import {
  classifyError,
  computeBackoffDelay,
  loadRetryConfigFromEnv,
  parseRetryAfter,
  withRetry,
  RetryMetrics,
  RetryExhaustedError,
  DEFAULT_RETRY_CONFIG,
  RETRY_ENV_KEYS,
} from '../src/core/retry';

/** Helper to build an axios-like HTTP error. */
function httpError(status: number, headers: Record<string, string> = {}): Error {
  const err = new Error(`HTTP ${status}`) as Error & {
    response: { status: number; headers: Record<string, string> };
  };
  err.response = { status, headers };
  return err;
}

const instantSleep = () => Promise.resolve();

describe('classifyError', () => {
  it('marks 429 as a retryable rate limit', () => {
    const c = classifyError(httpError(429));
    expect(c).toMatchObject({ retryable: true, kind: 'rate_limit', statusCode: 429 });
  });

  it('marks 5xx as a retryable server error', () => {
    const c = classifyError(httpError(503));
    expect(c).toMatchObject({ retryable: true, kind: 'server_error', statusCode: 503 });
  });

  it('marks non-429 4xx as a non-retryable client error', () => {
    const c = classifyError(httpError(400));
    expect(c).toMatchObject({ retryable: false, kind: 'client_error', statusCode: 400 });
  });

  it('treats responseless errors as retryable network failures', () => {
    const c = classifyError(new Error('ECONNREFUSED'));
    expect(c).toMatchObject({ retryable: true, kind: 'network' });
  });

  it('extracts Retry-After (seconds) from a 429 response', () => {
    const c = classifyError(httpError(429, { 'retry-after': '5' }));
    expect(c.retryAfterMs).toBe(5_000);
  });

  it('reads Retry-After case-insensitively', () => {
    const c = classifyError(httpError(429, { 'Retry-After': '2' }));
    expect(c.retryAfterMs).toBe(2_000);
  });
});

describe('parseRetryAfter', () => {
  it('parses a numeric seconds value', () => {
    expect(parseRetryAfter('3')).toBe(3_000);
  });

  it('parses an HTTP-date relative to now', () => {
    const now = 1_000_000;
    const future = new Date(now + 4_000).toUTCString();
    expect(parseRetryAfter(future, now)).toBe(4_000);
  });

  it('returns undefined for empty or unparseable values', () => {
    expect(parseRetryAfter(undefined)).toBeUndefined();
    expect(parseRetryAfter('')).toBeUndefined();
    expect(parseRetryAfter('not-a-date')).toBeUndefined();
  });
});

describe('computeBackoffDelay', () => {
  const config = { ...DEFAULT_RETRY_CONFIG, jitter: false };

  it('grows exponentially from the base delay', () => {
    expect(computeBackoffDelay(0, config)).toBe(2_000);
    expect(computeBackoffDelay(1, config)).toBe(4_000);
    expect(computeBackoffDelay(2, config)).toBe(8_000);
  });

  it('caps the delay at maxDelayMs', () => {
    expect(computeBackoffDelay(10, config)).toBe(config.maxDelayMs);
  });

  it('applies full jitter when enabled', () => {
    const jittered = { ...config, jitter: true };
    // random=0.5 -> half of the capped exponential delay
    expect(computeBackoffDelay(1, jittered, () => 0.5)).toBe(2_000);
  });
});

describe('loadRetryConfigFromEnv', () => {
  it('falls back to defaults when env is empty', () => {
    expect(loadRetryConfigFromEnv({})).toEqual(DEFAULT_RETRY_CONFIG);
  });

  it('reads overrides from environment variables', () => {
    const cfg = loadRetryConfigFromEnv({
      [RETRY_ENV_KEYS.baseDelayMs]: '500',
      [RETRY_ENV_KEYS.maxDelayMs]: '5000',
      [RETRY_ENV_KEYS.maxRetries]: '3',
      [RETRY_ENV_KEYS.jitter]: 'false',
    });
    expect(cfg).toEqual({
      baseDelayMs: 500,
      maxDelayMs: 5000,
      maxRetries: 3,
      jitter: false,
    });
  });

  it('ignores malformed values and keeps defaults', () => {
    const cfg = loadRetryConfigFromEnv({
      [RETRY_ENV_KEYS.maxRetries]: 'abc',
      [RETRY_ENV_KEYS.baseDelayMs]: '-10',
    });
    expect(cfg.maxRetries).toBe(DEFAULT_RETRY_CONFIG.maxRetries);
    expect(cfg.baseDelayMs).toBe(DEFAULT_RETRY_CONFIG.baseDelayMs);
  });
});

describe('withRetry', () => {
  it('returns immediately on first success', async () => {
    const metrics = new RetryMetrics();
    const fn = jest.fn().mockResolvedValue('ok');

    const result = await withRetry(fn, { metrics, sleep: instantSleep });

    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(1);
    expect(metrics.snapshot()).toMatchObject({ attempts: 1, retries: 0, successes: 1 });
  });

  it('retries transient failures then succeeds', async () => {
    const metrics = new RetryMetrics();
    const fn = jest
      .fn()
      .mockRejectedValueOnce(httpError(503))
      .mockRejectedValueOnce(httpError(503))
      .mockResolvedValue('recovered');

    const result = await withRetry(fn, {
      metrics,
      sleep: instantSleep,
      config: { jitter: false },
    });

    expect(result).toBe('recovered');
    expect(fn).toHaveBeenCalledTimes(3);
    const snap = metrics.snapshot();
    expect(snap).toMatchObject({ attempts: 3, retries: 2, successes: 1, serverErrors: 2 });
  });

  it('throws RetryExhaustedError after exceeding maxRetries', async () => {
    const metrics = new RetryMetrics();
    const fn = jest.fn().mockRejectedValue(httpError(500));

    await expect(
      withRetry(fn, {
        metrics,
        sleep: instantSleep,
        config: { maxRetries: 2, jitter: false },
      }),
    ).rejects.toBeInstanceOf(RetryExhaustedError);

    // initial attempt + 2 retries = 3 calls
    expect(fn).toHaveBeenCalledTimes(3);
    expect(metrics.snapshot()).toMatchObject({ attempts: 3, retries: 2, failures: 1 });
  });

  it('does not retry non-retryable client errors', async () => {
    const metrics = new RetryMetrics();
    const fn = jest.fn().mockRejectedValue(httpError(400));

    await expect(
      withRetry(fn, { metrics, sleep: instantSleep }),
    ).rejects.toMatchObject({ response: { status: 400 } });

    expect(fn).toHaveBeenCalledTimes(1);
    expect(metrics.snapshot()).toMatchObject({ attempts: 1, retries: 0, failures: 1 });
  });

  it('respects Retry-After on 429 over exponential backoff', async () => {
    const delays: number[] = [];
    const sleep = (ms: number) => {
      delays.push(ms);
      return Promise.resolve();
    };
    const fn = jest
      .fn()
      .mockRejectedValueOnce(httpError(429, { 'retry-after': '7' }))
      .mockResolvedValue('done');

    await withRetry(fn, { sleep, config: { jitter: false } });

    expect(delays).toEqual([7_000]);
  });

  it('caps a large Retry-After at maxDelayMs', async () => {
    const delays: number[] = [];
    const sleep = (ms: number) => {
      delays.push(ms);
      return Promise.resolve();
    };
    const fn = jest
      .fn()
      .mockRejectedValueOnce(httpError(429, { 'retry-after': '120' }))
      .mockResolvedValue('done');

    await withRetry(fn, { sleep, config: { maxDelayMs: 60_000, jitter: false } });

    expect(delays).toEqual([60_000]);
  });

  it('invokes onRetry with backoff metadata', async () => {
    const events: number[] = [];
    const fn = jest
      .fn()
      .mockRejectedValueOnce(httpError(503))
      .mockResolvedValue('ok');

    await withRetry(fn, {
      sleep: instantSleep,
      config: { jitter: false },
      onRetry: (e) => events.push(e.delayMs),
    });

    expect(events).toEqual([2_000]);
  });
});
