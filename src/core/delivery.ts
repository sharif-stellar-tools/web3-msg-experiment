/**
 * Resilient cross-chain message delivery.
 *
 * Wraps the underlying transport (typically an HTTP POST to a destination
 * network RPC) in the exponential-backoff retry mechanism from {@link withRetry}
 * so that transient RPC unavailability does not drop messages. Messages that
 * still fail after exhausting retries are parked in a {@link RetryQueue} for
 * later reprocessing.
 */

import axios, { AxiosInstance } from 'axios';
import {
  RetryConfig,
  RetryMetrics,
  RetryExhaustedError,
  loadRetryConfigFromEnv,
  withRetry,
  WithRetryOptions,
} from './retry';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A message destined for another chain. */
export interface CrossChainMessage {
  /** Unique identifier for de-duplication and tracking. */
  id: string;
  /** Logical name of the destination network (e.g. "stellar", "ethereum"). */
  destinationNetwork: string;
  /** Arbitrary serialisable payload to deliver. */
  payload: unknown;
}

/**
 * Transport responsible for actually pushing a message to a destination.
 * Should reject with an HTTP-like error (carrying `.response.status`) so the
 * retry layer can classify rate limits vs. server errors.
 */
export type DeliveryTransport = (
  message: CrossChainMessage,
  attempt: number,
) => Promise<void>;

/** Outcome of a delivery attempt. */
export interface DeliveryResult {
  message: CrossChainMessage;
  delivered: boolean;
  /** Number of attempts performed (1 = succeeded first try). */
  attempts: number;
  /** Present when delivery ultimately failed. */
  error?: Error;
}

/** Options for {@link CrossChainDeliveryService}. */
export interface DeliveryServiceOptions {
  /** Retry tuning; defaults to environment configuration. */
  retryConfig?: Partial<RetryConfig>;
  /** Shared metrics collector. One is created if omitted. */
  metrics?: RetryMetrics;
  /** Sleep implementation (injectable for tests). */
  sleep?: (ms: number) => Promise<void>;
  /** Random source for jitter (injectable for tests). */
  random?: () => number;
}

// ---------------------------------------------------------------------------
// Retry queue
// ---------------------------------------------------------------------------

/** A queued message awaiting (re)delivery. */
export interface QueuedMessage {
  message: CrossChainMessage;
  /** Number of full delivery cycles already attempted for this message. */
  enqueueCount: number;
  /** Last error seen, if any. */
  lastError?: Error;
}

/**
 * Simple in-memory FIFO queue for messages that have exhausted their retry
 * budget and need to be reprocessed later (e.g. on the next scheduler tick).
 */
export class RetryQueue {
  private items: QueuedMessage[] = [];

  enqueue(message: CrossChainMessage, lastError?: Error): void {
    const existing = this.items.find((q) => q.message.id === message.id);
    if (existing) {
      existing.enqueueCount += 1;
      existing.lastError = lastError;
      return;
    }
    this.items.push({ message, enqueueCount: 1, lastError });
  }

  dequeue(): QueuedMessage | undefined {
    return this.items.shift();
  }

  get size(): number {
    return this.items.length;
  }

  peek(): readonly QueuedMessage[] {
    return [...this.items];
  }

  clear(): void {
    this.items = [];
  }
}

// ---------------------------------------------------------------------------
// Delivery service
// ---------------------------------------------------------------------------

/**
 * Delivers cross-chain messages with exponential-backoff retries and a parking
 * queue for permanent-for-now failures.
 */
export class CrossChainDeliveryService {
  private readonly transport: DeliveryTransport;
  private readonly retryConfig: RetryConfig;
  private readonly metrics: RetryMetrics;
  private readonly queue = new RetryQueue();
  private readonly sleep?: (ms: number) => Promise<void>;
  private readonly random?: () => number;

  constructor(transport: DeliveryTransport, options: DeliveryServiceOptions = {}) {
    this.transport = transport;
    this.retryConfig = { ...loadRetryConfigFromEnv(), ...options.retryConfig };
    this.metrics = options.metrics ?? new RetryMetrics();
    this.sleep = options.sleep;
    this.random = options.random;
  }

  /** Access the shared metrics collector. */
  getMetrics(): RetryMetrics {
    return this.metrics;
  }

  /** Access the retry queue (e.g. for inspection or draining). */
  getQueue(): RetryQueue {
    return this.queue;
  }

  /** Effective retry configuration in use. */
  getRetryConfig(): RetryConfig {
    return { ...this.retryConfig };
  }

  /**
   * Attempt to deliver a single message, retrying transient failures. On
   * permanent failure the message is parked in the retry queue and a failed
   * {@link DeliveryResult} is returned (this method does not throw).
   */
  async deliver(message: CrossChainMessage): Promise<DeliveryResult> {
    let attempts = 0;
    const retryOptions: WithRetryOptions = {
      config: this.retryConfig,
      metrics: this.metrics,
      sleep: this.sleep,
      random: this.random,
    };

    try {
      await withRetry(async (attempt) => {
        attempts = attempt + 1;
        await this.transport(message, attempt);
      }, retryOptions);

      return { message, delivered: true, attempts };
    } catch (err) {
      const error =
        err instanceof RetryExhaustedError
          ? err
          : err instanceof Error
            ? err
            : new Error(String(err));
      this.queue.enqueue(message, error);
      return { message, delivered: false, attempts, error };
    }
  }

  /**
   * Drain the retry queue, re-attempting delivery for each parked message.
   * Returns the per-message results. Messages that still fail are re-queued.
   */
  async processQueue(): Promise<DeliveryResult[]> {
    const results: DeliveryResult[] = [];
    const pending = this.queue.peek();
    this.queue.clear();

    for (const { message } of pending) {
      results.push(await this.deliver(message));
    }
    return results;
  }
}

// ---------------------------------------------------------------------------
// HTTP transport factory
// ---------------------------------------------------------------------------

/** Options for the default HTTP transport. */
export interface HttpTransportOptions {
  /** Per-request timeout in ms (default 10s). */
  timeoutMs?: number;
  /** Pre-configured axios instance (injectable for tests). */
  client?: AxiosInstance;
}

/**
 * Build a {@link DeliveryTransport} that POSTs each message's payload to the
 * destination network's RPC URL.
 *
 * @param rpcUrls Map of destination network name -> RPC endpoint URL.
 */
export function createHttpTransport(
  rpcUrls: Record<string, string>,
  options: HttpTransportOptions = {},
): DeliveryTransport {
  const client =
    options.client ?? axios.create({ timeout: options.timeoutMs ?? 10_000 });

  return async (message: CrossChainMessage) => {
    const url = rpcUrls[message.destinationNetwork];
    if (!url) {
      throw new Error(
        `No RPC URL configured for destination network "${message.destinationNetwork}"`,
      );
    }
    await client.post(url, { id: message.id, payload: message.payload });
  };
}
