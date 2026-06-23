import {
  CrossChainDeliveryService,
  RetryQueue,
  createHttpTransport,
  CrossChainMessage,
  DeliveryTransport,
} from '../../src/core/delivery';
import { RetryExhaustedError } from '../../src/core/retry';

/** Build an axios-like HTTP error carrying a status code. */
function httpError(status: number, headers: Record<string, string> = {}): Error {
  const err = new Error(`HTTP ${status}`) as Error & {
    response: { status: number; headers: Record<string, string> };
  };
  err.response = { status, headers };
  return err;
}

const instantSleep = () => Promise.resolve();

function message(id: string, network = 'stellar'): CrossChainMessage {
  return { id, destinationNetwork: network, payload: { value: id } };
}

describe('CrossChainDeliveryService (resilient delivery)', () => {
  it('delivers after a simulated transient RPC outage', async () => {
    // Transport fails twice with a 503 (RPC temporarily unavailable) then recovers.
    let calls = 0;
    const transport: DeliveryTransport = async () => {
      calls += 1;
      if (calls <= 2) throw httpError(503);
    };

    const service = new CrossChainDeliveryService(transport, {
      sleep: instantSleep,
      retryConfig: { jitter: false },
    });

    const result = await service.deliver(message('m1'));

    expect(result.delivered).toBe(true);
    expect(result.attempts).toBe(3);
    expect(service.getQueue().size).toBe(0);
    expect(service.getMetrics().snapshot()).toMatchObject({
      successes: 1,
      retries: 2,
      serverErrors: 2,
    });
  });

  it('parks a message in the retry queue when the RPC stays down', async () => {
    const transport: DeliveryTransport = async () => {
      throw httpError(500);
    };

    const service = new CrossChainDeliveryService(transport, {
      sleep: instantSleep,
      retryConfig: { maxRetries: 3, jitter: false },
    });

    const result = await service.deliver(message('m2'));

    expect(result.delivered).toBe(false);
    expect(result.error).toBeInstanceOf(RetryExhaustedError);
    expect(service.getQueue().size).toBe(1);
    expect(service.getMetrics().snapshot()).toMatchObject({ failures: 1, retries: 3 });
  });

  it('handles 429 rate limiting by honouring Retry-After', async () => {
    const delays: number[] = [];
    let calls = 0;
    const transport: DeliveryTransport = async () => {
      calls += 1;
      if (calls === 1) throw httpError(429, { 'retry-after': '3' });
    };

    const service = new CrossChainDeliveryService(transport, {
      sleep: (ms) => {
        delays.push(ms);
        return Promise.resolve();
      },
      retryConfig: { jitter: false },
    });

    const result = await service.deliver(message('m3'));

    expect(result.delivered).toBe(true);
    expect(delays).toEqual([3_000]);
    expect(service.getMetrics().snapshot()).toMatchObject({ rateLimitHits: 1 });
  });

  it('does not retry a permanent client error', async () => {
    const transport = jest.fn<Promise<void>, [CrossChainMessage, number]>(
      async () => {
        throw httpError(404);
      },
    );

    const service = new CrossChainDeliveryService(transport, { sleep: instantSleep });
    const result = await service.deliver(message('m4'));

    expect(result.delivered).toBe(false);
    expect(transport).toHaveBeenCalledTimes(1);
    expect(service.getQueue().size).toBe(1);
  });

  it('reprocesses queued messages once the RPC recovers', async () => {
    let healthy = false;
    const transport: DeliveryTransport = async () => {
      if (!healthy) throw httpError(503);
    };

    const service = new CrossChainDeliveryService(transport, {
      sleep: instantSleep,
      retryConfig: { maxRetries: 1, jitter: false },
    });

    // First delivery fails and parks the message.
    await service.deliver(message('m5'));
    expect(service.getQueue().size).toBe(1);

    // RPC recovers; draining the queue now succeeds.
    healthy = true;
    const results = await service.processQueue();

    expect(results).toHaveLength(1);
    expect(results[0].delivered).toBe(true);
    expect(service.getQueue().size).toBe(0);
  });
});

describe('RetryQueue', () => {
  it('deduplicates by message id and counts re-enqueues', () => {
    const queue = new RetryQueue();
    queue.enqueue(message('dup'));
    queue.enqueue(message('dup'), new Error('boom'));

    expect(queue.size).toBe(1);
    expect(queue.peek()[0].enqueueCount).toBe(2);
    expect(queue.peek()[0].lastError?.message).toBe('boom');
  });

  it('dequeues in FIFO order', () => {
    const queue = new RetryQueue();
    queue.enqueue(message('a'));
    queue.enqueue(message('b'));

    expect(queue.dequeue()?.message.id).toBe('a');
    expect(queue.dequeue()?.message.id).toBe('b');
    expect(queue.dequeue()).toBeUndefined();
  });
});

describe('createHttpTransport', () => {
  it('POSTs the payload to the destination network RPC URL', async () => {
    const post = jest.fn().mockResolvedValue({ status: 200 });
    const transport = createHttpTransport(
      { stellar: 'https://rpc.example/stellar' },
      { client: { post } as never },
    );

    await transport(message('h1'), 0);

    expect(post).toHaveBeenCalledWith('https://rpc.example/stellar', {
      id: 'h1',
      payload: { value: 'h1' },
    });
  });

  it('throws when no RPC URL is configured for the destination', async () => {
    const transport = createHttpTransport(
      {},
      { client: { post: jest.fn() } as never },
    );

    await expect(transport(message('h2', 'unknown'), 0)).rejects.toThrow(
      /No RPC URL configured/,
    );
  });
});
