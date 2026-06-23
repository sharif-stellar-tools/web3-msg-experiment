/**
 * Robust retry mechanism with exponential backoff.
 *
 * Provides a generic {@link withRetry} helper used by the cross-chain message
 * delivery layer to survive transient failures of a destination network RPC.
 *
 * Highlights:
 *   - Exponential backoff with an optional full-jitter strategy.
 *   - `429 Too Many Requests` is treated differently from `5xx` errors and the
 *     `Retry-After` header (seconds or HTTP-date form) is respected when present.
 *   - Configurable via environment variables (see {@link loadRetryConfigFromEnv}).
 *   - Pluggable metrics collection (see {@link RetryMetrics}).
 */

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/** Tunable parameters for the exponential-backoff retry strategy. */
export interface RetryConfig {
  /** Base delay used for the first backoff, in milliseconds. */
  baseDelayMs: number;
  /** Upper bound for any single backoff delay, in milliseconds. */
  maxDelayMs: number;
  /** Maximum number of retries after the initial attempt. */
  maxRetries: number;
  /** When true, apply full jitter to each computed delay. */
  jitter: boolean;
}

/** Sensible defaults matching the issue's recommendation. */
export const DEFAULT_RETRY_CONFIG: RetryConfig = {
  baseDelayMs: 2_000, // 2 s
  maxDelayMs: 60_000, // 60 s
  maxRetries: 5,
  jitter: true,
};

/** Environment variable names recognised by {@link loadRetryConfigFromEnv}. */
export const RETRY_ENV_KEYS = {
  baseDelayMs: 'CROSS_CHAIN_RETRY_BASE_DELAY_MS',
  maxDelayMs: 'CROSS_CHAIN_RETRY_MAX_DELAY_MS',
  maxRetries: 'CROSS_CHAIN_RETRY_MAX_RETRIES',
  jitter: 'CROSS_CHAIN_RETRY_JITTER',
} as const;

function parsePositiveInt(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === '') return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 0) return fallback;
  return parsed;
}

function parseBool(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value.trim() === '') return fallback;
  const normalized = value.trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  return fallback;
}

/**
 * Build a {@link RetryConfig} from environment variables, falling back to
 * {@link DEFAULT_RETRY_CONFIG} for anything unset or malformed.
 */
export function loadRetryConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): RetryConfig {
  return {
    baseDelayMs: parsePositiveInt(
      env[RETRY_ENV_KEYS.baseDelayMs],
      DEFAULT_RETRY_CONFIG.baseDelayMs,
    ),
    maxDelayMs: parsePositiveInt(
      env[RETRY_ENV_KEYS.maxDelayMs],
      DEFAULT_RETRY_CONFIG.maxDelayMs,
    ),
    maxRetries: parsePositiveInt(
      env[RETRY_ENV_KEYS.maxRetries],
      DEFAULT_RETRY_CONFIG.maxRetries,
    ),
    jitter: parseBool(env[RETRY_ENV_KEYS.jitter], DEFAULT_RETRY_CONFIG.jitter),
  };
}

// ---------------------------------------------------------------------------
// Error classification
// ---------------------------------------------------------------------------

/** High-level category for a failed attempt. */
export type ErrorKind =
  | 'rate_limit' // HTTP 429
  | 'server_error' // HTTP 5xx
  | 'network' // no response (timeout / connection refused / DNS)
  | 'client_error' // HTTP 4xx (other than 429) — not retried
  | 'unknown';

/** Result of inspecting a thrown error. */
export interface ClassifiedError {
  /** Whether the operation should be retried. */
  retryable: boolean;
  /** Category of the error. */
  kind: ErrorKind;
  /** HTTP status code, if the error carried a response. */
  statusCode?: number;
  /** Server-requested delay (from `Retry-After`) in ms, if provided. */
  retryAfterMs?: number;
}

/**
 * Parse a `Retry-After` header value into milliseconds.
 * Accepts either a delay in seconds or an HTTP-date.
 * Returns undefined when the value cannot be interpreted.
 */
export function parseRetryAfter(
  value: string | number | undefined | null,
  now: number = Date.now(),
): number | undefined {
  if (value === undefined || value === null || value === '') return undefined;

  const asSeconds = typeof value === 'number' ? value : Number(value);
  if (Number.isFinite(asSeconds)) {
    return Math.max(0, asSeconds * 1_000);
  }

  const asDate = Date.parse(String(value));
  if (!Number.isNaN(asDate)) {
    return Math.max(0, asDate - now);
  }

  return undefined;
}

/** Shape we look for on error objects without depending on axios types. */
interface HttpLikeError {
  response?: {
    status?: number;
    headers?: Record<string, string | number | undefined>;
  };
  status?: number;
  statusCode?: number;
  code?: string;
}

function readHeader(
  headers: Record<string, string | number | undefined> | undefined,
  name: string,
): string | number | undefined {
  if (!headers) return undefined;
  const lower = name.toLowerCase();
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === lower) return headers[key];
  }
  return undefined;
}

/**
 * Inspect a thrown value and decide whether it is worth retrying.
 *
 * Network-level errors (no HTTP response) and `5xx`/`429` responses are
 * retryable; other `4xx` responses are treated as permanent.
 */
export function classifyError(
  err: unknown,
  now: number = Date.now(),
): ClassifiedError {
  const e = (err ?? {}) as HttpLikeError;
  const status = e.response?.status ?? e.status ?? e.statusCode;

  if (typeof status === 'number') {
    if (status === 429) {
      const retryAfter = parseRetryAfter(
        readHeader(e.response?.headers, 'retry-after'),
        now,
      );
      return {
        retryable: true,
        kind: 'rate_limit',
        statusCode: status,
        retryAfterMs: retryAfter,
      };
    }
    if (status >= 500 && status <= 599) {
      const retryAfter = parseRetryAfter(
        readHeader(e.response?.headers, 'retry-after'),
        now,
      );
      return {
        retryable: true,
        kind: 'server_error',
        statusCode: status,
        retryAfterMs: retryAfter,
      };
    }
    if (status >= 400 && status <= 499) {
      return { retryable: false, kind: 'client_error', statusCode: status };
    }
  }

  // No usable HTTP status: assume a transient network/transport failure.
  return { retryable: true, kind: 'network' };
}

// ---------------------------------------------------------------------------
// Backoff
// ---------------------------------------------------------------------------

/**
 * Compute the backoff delay (ms) for a given retry attempt (0-based: attempt 0
 * is the first retry). Applies exponential growth capped at `maxDelayMs`, with
 * optional full jitter.
 */
export function computeBackoffDelay(
  attempt: number,
  config: RetryConfig,
  random: () => number = Math.random,
): number {
  const exponential = config.baseDelayMs * 2 ** attempt;
  const capped = Math.min(exponential, config.maxDelayMs);
  if (!config.jitter) return capped;
  // Full jitter: pick a random delay in [0, capped].
  return Math.floor(random() * capped);
}

// ---------------------------------------------------------------------------
// Metrics
// ---------------------------------------------------------------------------

/** Immutable view of collected retry metrics. */
export interface RetryMetricsSnapshot {
  /** Total individual attempts made (initial attempts + retries). */
  attempts: number;
  /** Number of retries triggered (attempts beyond the first per operation). */
  retries: number;
  /** Operations that ultimately succeeded. */
  successes: number;
  /** Operations that ultimately failed after exhausting retries. */
  failures: number;
  /** Number of attempts that hit a 429 rate limit. */
  rateLimitHits: number;
  /** Number of attempts that hit a 5xx server error. */
  serverErrors: number;
  /** Number of attempts that failed at the network/transport level. */
  networkErrors: number;
}

/**
 * Lightweight in-memory metrics collector for retry activity. Designed to be
 * shared across many operations and periodically scraped via {@link snapshot}.
 */
export class RetryMetrics {
  private attempts = 0;
  private retries = 0;
  private successes = 0;
  private failures = 0;
  private rateLimitHits = 0;
  private serverErrors = 0;
  private networkErrors = 0;

  recordAttempt(): void {
    this.attempts += 1;
  }

  recordRetry(kind: ErrorKind): void {
    this.retries += 1;
    if (kind === 'rate_limit') this.rateLimitHits += 1;
    else if (kind === 'server_error') this.serverErrors += 1;
    else if (kind === 'network') this.networkErrors += 1;
  }

  recordSuccess(): void {
    this.successes += 1;
  }

  recordFailure(): void {
    this.failures += 1;
  }

  snapshot(): RetryMetricsSnapshot {
    return {
      attempts: this.attempts,
      retries: this.retries,
      successes: this.successes,
      failures: this.failures,
      rateLimitHits: this.rateLimitHits,
      serverErrors: this.serverErrors,
      networkErrors: this.networkErrors,
    };
  }

  reset(): void {
    this.attempts = 0;
    this.retries = 0;
    this.successes = 0;
    this.failures = 0;
    this.rateLimitHits = 0;
    this.serverErrors = 0;
    this.networkErrors = 0;
  }
}

// ---------------------------------------------------------------------------
// withRetry
// ---------------------------------------------------------------------------

/** Information passed to the {@link WithRetryOptions.onRetry} callback. */
export interface RetryEvent {
  /** Zero-based retry index (0 = first retry). */
  attempt: number;
  /** Delay that will be awaited before the next attempt, in ms. */
  delayMs: number;
  /** Classification of the error that triggered the retry. */
  error: ClassifiedError;
  /** The raw thrown value. */
  cause: unknown;
}

/** Options for {@link withRetry}. */
export interface WithRetryOptions {
  /** Partial overrides merged over {@link DEFAULT_RETRY_CONFIG}. */
  config?: Partial<RetryConfig>;
  /** Metrics collector to update during execution. */
  metrics?: RetryMetrics;
  /** Sleep implementation (injectable for tests). */
  sleep?: (ms: number) => Promise<void>;
  /** Random source for jitter (injectable for tests). */
  random?: () => number;
  /** Invoked just before each backoff wait. */
  onRetry?: (event: RetryEvent) => void;
}

/** Raised when all retry attempts have been exhausted. */
export class RetryExhaustedError extends Error {
  constructor(
    message: string,
    readonly attempts: number,
    readonly lastError: unknown,
    readonly classification: ClassifiedError,
  ) {
    super(message);
    this.name = 'RetryExhaustedError';
  }
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Execute `fn`, retrying on transient failures with exponential backoff.
 *
 * The provided function receives the current attempt number (0-based). It is
 * retried up to `config.maxRetries` times. Non-retryable errors (e.g. a `4xx`
 * other than `429`) short-circuit immediately.
 *
 * @throws RetryExhaustedError when retries are exhausted.
 * @throws the original error when it is classified as non-retryable.
 */
export async function withRetry<T>(
  fn: (attempt: number) => Promise<T>,
  options: WithRetryOptions = {},
): Promise<T> {
  const config: RetryConfig = { ...DEFAULT_RETRY_CONFIG, ...options.config };
  const sleep = options.sleep ?? defaultSleep;
  const random = options.random ?? Math.random;
  const metrics = options.metrics;

  let lastError: unknown;
  let lastClassification: ClassifiedError = { retryable: false, kind: 'unknown' };

  for (let attempt = 0; attempt <= config.maxRetries; attempt += 1) {
    metrics?.recordAttempt();
    try {
      const result = await fn(attempt);
      metrics?.recordSuccess();
      return result;
    } catch (err) {
      lastError = err;
      const now = Date.now();
      const classification = classifyError(err, now);
      lastClassification = classification;

      const isLastAttempt = attempt >= config.maxRetries;
      if (!classification.retryable || isLastAttempt) {
        metrics?.recordFailure();
        if (!classification.retryable) {
          throw err;
        }
        throw new RetryExhaustedError(
          `Operation failed after ${attempt + 1} attempt(s): ${describeError(err)}`,
          attempt + 1,
          err,
          classification,
        );
      }

      // Decide on the delay: honour Retry-After for rate limits when present.
      let delayMs: number;
      if (
        classification.kind === 'rate_limit' &&
        classification.retryAfterMs !== undefined
      ) {
        delayMs = Math.min(classification.retryAfterMs, config.maxDelayMs);
      } else {
        delayMs = computeBackoffDelay(attempt, config, random);
      }

      metrics?.recordRetry(classification.kind);
      options.onRetry?.({ attempt, delayMs, error: classification, cause: err });

      await sleep(delayMs);
    }
  }

  // Unreachable in practice (loop either returns or throws), but keeps TS happy.
  throw new RetryExhaustedError(
    `Operation failed after ${config.maxRetries + 1} attempt(s)`,
    config.maxRetries + 1,
    lastError,
    lastClassification,
  );
}

function describeError(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}
