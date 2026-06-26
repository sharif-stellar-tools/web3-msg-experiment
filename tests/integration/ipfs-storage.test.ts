/**
 * Integration tests for IPFS-based message storage and retrieval.
 *
 * Verifies that message envelopes are correctly pinned to IPFS and that the
 * resulting CIDs can be reliably fetched back — including under transient
 * pinning/gateway failures — without hitting the real network. The HTTP layer
 * is replaced by an in-memory fake IPFS node that mimics a Pinata-compatible
 * pinning API and an IPFS gateway.
 */

import { createHash } from 'crypto';
import { IpfsMessageStore, IpfsPinError } from '../../src/core/ipfs';
import { SignedMessage } from '../../src/core/types';

const instantSleep = () => Promise.resolve();

/** Build an axios-like HTTP error carrying a status code (matches retry layer). */
function httpError(status: number, headers: Record<string, string> = {}): Error {
  const err = new Error(`HTTP ${status}`) as Error & {
    response: { status: number; headers: Record<string, string> };
  };
  err.response = { status, headers };
  return err;
}

/**
 * Minimal in-memory IPFS node exposing the two HTTP surfaces the store uses:
 *  - POST `${pinningUrl}/pinning/pinJSONToIPFS` -> `{ IpfsHash, PinSize, Timestamp }`
 *  - GET  `${gatewayUrl}/ipfs/${cid}`           -> the originally pinned content
 *
 * CIDs are derived deterministically from content so identical messages pin to
 * the same address (content addressing), which the tests assert on.
 */
class FakeIpfsNode {
  readonly pinned = new Map<string, unknown>();
  /** Per-CID number of gateway failures to inject before succeeding. */
  private gatewayFailuresLeft = new Map<string, number>();
  /** Number of pin failures to inject before succeeding. */
  private pinFailuresLeft = 0;

  pinCalls = 0;
  getCalls = 0;

  /** Queue `n` transient gateway failures for the next reads of `cid`. */
  failGatewayTimes(cid: string, n: number): void {
    this.gatewayFailuresLeft.set(cid, n);
  }

  /** Queue `n` transient failures for the next pin operations. */
  failPinTimes(n: number): void {
    this.pinFailuresLeft = n;
  }

  cidFor(content: unknown): string {
    const digest = createHash('sha256')
      .update(JSON.stringify(content))
      .digest('hex')
      .slice(0, 44);
    return `bafy${digest}`;
  }

  /** axios-like client wired into the store. */
  asClient() {
    return {
      post: async (url: string, body: { pinataContent: unknown }) => {
        this.pinCalls += 1;
        if (this.pinFailuresLeft > 0) {
          this.pinFailuresLeft -= 1;
          throw httpError(503); // pinning service temporarily unavailable
        }
        const content = body.pinataContent;
        const cid = this.cidFor(content);
        this.pinned.set(cid, content);
        return {
          data: {
            IpfsHash: cid,
            PinSize: JSON.stringify(content).length,
            Timestamp: new Date(0).toISOString(),
          },
        };
      },
      get: async (url: string) => {
        this.getCalls += 1;
        const cid = url.split('/ipfs/')[1];
        const failures = this.gatewayFailuresLeft.get(cid) ?? 0;
        if (failures > 0) {
          this.gatewayFailuresLeft.set(cid, failures - 1);
          throw httpError(504); // gateway timeout
        }
        if (!this.pinned.has(cid)) {
          throw httpError(404);
        }
        return { data: this.pinned.get(cid) };
      },
    } as any;
  }
}

function sampleMessage(payload = 'gm from stellar'): SignedMessage {
  return {
    payload,
    senderPublicKey: 'GADUMMYPUBLICKEYAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    signature: 'deadbeefcafebabe',
  };
}

function makeStore(node: FakeIpfsNode) {
  return new IpfsMessageStore({
    client: node.asClient(),
    sleep: instantSleep,
    retryConfig: { jitter: false },
  });
}

describe('IPFS message storage and retrieval', () => {
  it('pins a message and returns a CID', async () => {
    const node = new FakeIpfsNode();
    const store = makeStore(node);

    const result = await store.pin(sampleMessage());

    expect(result.cid).toMatch(/^bafy/);
    expect(node.pinned.has(result.cid)).toBe(true);
    expect(result.pinSize).toBeGreaterThan(0);
  });

  it('round-trips: a pinned message is fetched back unchanged', async () => {
    const node = new FakeIpfsNode();
    const store = makeStore(node);
    const message = sampleMessage('round-trip payload');

    const { cid } = await store.pin(message);
    const fetched = await store.fetch<SignedMessage>(cid);

    expect(fetched).toEqual(message);
  });

  it('store() helper pins and reads back in one call', async () => {
    const node = new FakeIpfsNode();
    const store = makeStore(node);
    const message = sampleMessage('combined helper');

    const { cid, retrieved } = await store.store(message);

    expect(node.pinned.get(cid)).toEqual(message);
    expect(retrieved).toEqual(message);
  });

  it('is content-addressed: identical messages pin to the same CID', async () => {
    const node = new FakeIpfsNode();
    const store = makeStore(node);
    const message = sampleMessage('idempotent');

    const first = await store.pin(message);
    const second = await store.pin(message);

    expect(second.cid).toBe(first.cid);
  });

  it('different messages produce different CIDs', async () => {
    const node = new FakeIpfsNode();
    const store = makeStore(node);

    const a = await store.pin(sampleMessage('message A'));
    const b = await store.pin(sampleMessage('message B'));

    expect(a.cid).not.toBe(b.cid);
  });

  it('reliably fetches a CID despite transient gateway failures', async () => {
    const node = new FakeIpfsNode();
    const store = makeStore(node);
    const message = sampleMessage('survives flaky gateway');

    const { cid } = await store.pin(message);
    // Gateway times out twice before serving the content.
    node.failGatewayTimes(cid, 2);

    const fetched = await store.fetch<SignedMessage>(cid);

    expect(fetched).toEqual(message);
    expect(node.getCalls).toBe(3); // two failures + one success
  });

  it('retries pinning when the pinning service is briefly unavailable', async () => {
    const node = new FakeIpfsNode();
    const store = makeStore(node);
    node.failPinTimes(2);

    const result = await store.pin(sampleMessage('survives flaky pinning'));

    expect(result.cid).toMatch(/^bafy/);
    expect(node.pinCalls).toBe(3);
  });

  it('throws when fetching an unknown CID', async () => {
    const node = new FakeIpfsNode();
    const store = makeStore(node);

    await expect(store.fetch('bafyDOESNOTEXIST')).rejects.toBeDefined();
  });

  it('rejects an empty CID without a network call', async () => {
    const node = new FakeIpfsNode();
    const store = makeStore(node);

    await expect(store.fetch('')).rejects.toThrow(/non-empty CID/);
    expect(node.getCalls).toBe(0);
  });

  it('surfaces an IpfsPinError when the service returns no CID', async () => {
    const badClient = {
      post: async () => ({ data: {} }), // missing IpfsHash
      get: async () => ({ data: null }),
    } as any;
    const store = new IpfsMessageStore({
      client: badClient,
      sleep: instantSleep,
      retryConfig: { jitter: false },
    });

    await expect(store.pin(sampleMessage())).rejects.toBeInstanceOf(IpfsPinError);
  });
});
