/**
 * IPFS-backed message storage.
 *
 * Persists message envelopes to IPFS via a pinning service (Pinata-compatible
 * `pinJSONToIPFS` API) and retrieves them back by CID through an HTTP gateway.
 * Both operations are wrapped in the shared exponential-backoff retry layer
 * ({@link withRetry}) so that transient pinning/gateway unavailability does not
 * cause a stored message to be lost or an existing CID to appear unreadable.
 *
 * The HTTP client is injectable, which keeps the storage logic deterministic
 * and offline-testable (see `tests/integration/ipfs-storage.test.ts`).
 */

import axios, { AxiosInstance } from 'axios';
import {
  RetryConfig,
  RetryMetrics,
  withRetry,
} from './retry';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A content identifier returned by IPFS after pinning. */
export type Cid = string;

/** Result of pinning a message to IPFS. */
export interface PinResult {
  /** The content identifier the message can be fetched by. */
  cid: Cid;
  /** Size in bytes reported by the pinning service, when available. */
  pinSize?: number;
  /** Pin timestamp reported by the pinning service, when available. */
  timestamp?: string;
}

/** Options for {@link IpfsMessageStore}. */
export interface IpfsMessageStoreOptions {
  /**
   * Base URL of the pinning service. Defaults to the public Pinata endpoint.
   * The store POSTs to `${pinningUrl}/pinning/pinJSONToIPFS`.
   */
  pinningUrl?: string;
  /**
   * Gateway base URL used to fetch content by CID. The store GETs
   * `${gatewayUrl}/ipfs/${cid}`. Defaults to the public Pinata gateway.
   */
  gatewayUrl?: string;
  /** Bearer token (JWT) for the pinning service, when authentication is required. */
  authToken?: string;
  /** Per-request timeout in ms (default 10s). */
  timeoutMs?: number;
  /** Pre-configured axios instance (injectable for tests). */
  client?: AxiosInstance;
  /** Retry tuning; defaults to the library defaults. */
  retryConfig?: Partial<RetryConfig>;
  /** Shared metrics collector (optional). */
  metrics?: RetryMetrics;
  /** Sleep implementation (injectable for tests). */
  sleep?: (ms: number) => Promise<void>;
  /** Random source for jitter (injectable for tests). */
  random?: () => number;
}

const DEFAULT_PINNING_URL = 'https://api.pinata.cloud';
const DEFAULT_GATEWAY_URL = 'https://gateway.pinata.cloud';

/** Raised when a pin succeeds at the HTTP level but returns no usable CID. */
export class IpfsPinError extends Error {
  /**
   * A 4xx-style status so the retry layer classifies this as a permanent
   * (non-retryable) failure: a response without a CID will not improve on retry.
   */
  readonly statusCode = 422;

  constructor(message: string) {
    super(message);
    this.name = 'IpfsPinError';
  }
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

/**
 * Pins JSON message envelopes to IPFS and fetches them back by CID.
 *
 * Both {@link pin} and {@link fetch} are retried on transient failures so that
 * callers get reliable storage and retrieval semantics.
 */
export class IpfsMessageStore {
  private readonly client: AxiosInstance;
  private readonly pinningUrl: string;
  private readonly gatewayUrl: string;
  private readonly authToken?: string;
  private readonly retryConfig?: Partial<RetryConfig>;
  private readonly metrics?: RetryMetrics;
  private readonly sleep?: (ms: number) => Promise<void>;
  private readonly random?: () => number;

  constructor(options: IpfsMessageStoreOptions = {}) {
    this.client =
      options.client ?? axios.create({ timeout: options.timeoutMs ?? 10_000 });
    this.pinningUrl = stripTrailingSlash(options.pinningUrl ?? DEFAULT_PINNING_URL);
    this.gatewayUrl = stripTrailingSlash(options.gatewayUrl ?? DEFAULT_GATEWAY_URL);
    this.authToken = options.authToken;
    this.retryConfig = options.retryConfig;
    this.metrics = options.metrics;
    this.sleep = options.sleep;
    this.random = options.random;
  }

  /** Shared retry options derived from the store configuration. */
  private retryOptions() {
    return {
      config: this.retryConfig,
      metrics: this.metrics,
      sleep: this.sleep,
      random: this.random,
    };
  }

  private authHeaders(): Record<string, string> {
    return this.authToken ? { Authorization: `Bearer ${this.authToken}` } : {};
  }

  /**
   * Pin a message to IPFS and return its CID.
   *
   * @param message Any JSON-serialisable message envelope.
   * @returns The pin result, including the CID the message can be fetched by.
   * @throws IpfsPinError when the service responds without a CID.
   */
  async pin(message: unknown): Promise<PinResult> {
    const url = `${this.pinningUrl}/pinning/pinJSONToIPFS`;

    return withRetry(async () => {
      const response = await this.client.post(
        url,
        { pinataContent: message },
        { headers: { 'Content-Type': 'application/json', ...this.authHeaders() } },
      );

      const data = response?.data ?? {};
      const cid: Cid | undefined = data.IpfsHash ?? data.cid ?? data.Hash;
      if (!cid) {
        throw new IpfsPinError(
          'Pinning service did not return a CID (expected `IpfsHash`).',
        );
      }

      return {
        cid,
        pinSize: data.PinSize,
        timestamp: data.Timestamp,
      };
    }, this.retryOptions());
  }

  /**
   * Fetch a previously pinned message by CID.
   *
   * @typeParam T The expected shape of the stored message.
   * @param cid The content identifier returned by {@link pin}.
   * @returns The deserialised message body.
   */
  async fetch<T = unknown>(cid: Cid): Promise<T> {
    if (!cid) {
      throw new Error('A non-empty CID is required to fetch from IPFS.');
    }
    const url = `${this.gatewayUrl}/ipfs/${cid}`;

    return withRetry(async () => {
      const response = await this.client.get(url);
      return response.data as T;
    }, this.retryOptions());
  }

  /**
   * Convenience round-trip helper: pin a message, then return both the CID and
   * the content read back from the gateway. Primarily useful in tests and
   * sanity checks that storage and retrieval agree.
   */
  async store<T>(message: T): Promise<{ cid: Cid; retrieved: T }> {
    const { cid } = await this.pin(message);
    const retrieved = await this.fetch<T>(cid);
    return { cid, retrieved };
  }
}

function stripTrailingSlash(url: string): string {
  return url.replace(/\/+$/, '');
}
