/**
 * Cross-border payment routing algorithm for Stellar.
 *
 * Queries Stellar Horizon `/paths/strict-send` and `/paths/strict-receive`
 * endpoints, factors in spread, base fees, and slippage to compute the true cost
 * of each path, and provides a fallback mechanism when liquidity is insufficient.
 */

import axios, { AxiosInstance } from 'axios';
import {
  Asset,
  Keypair,
  Operation,
  TransactionBuilder,
  BASE_FEE,
  Networks,
  StrKey,
  xdr,
} from '@stellar/stellar-sdk';
import {
  PathPaymentMode,
  PathHop,
  PaymentPath,
  PathCost,
  PathFinderConfig,
  PathFinderResult,
  CachedOrderbook,
} from './types';

// ---------------------------------------------------------------------------
// Default configuration
// ---------------------------------------------------------------------------

const DEFAULT_CONFIG: PathFinderConfig = {
  horizonUrl: 'https://horizon.stellar.org',
  networkPassphrase: Networks.PUBLIC,
  baseFee: 100, // 0.00001 XLM
  slippageTolerance: 0.01, // 1 %
  maxPathHops: 5,
  cacheTtlMs: 30_000, // 30 s
  enableCache: true,
  fallbackAssets: ['XLM', 'USDC'],
};

// ---------------------------------------------------------------------------
// Big-number helpers (avoid floating-point precision issues)
// ---------------------------------------------------------------------------

/** Add two decimal strings. */
function add(a: string, b: string): string {
  const x = BigInt(a.includes('.') ? a.replace('.', '') : a);
  const y = BigInt(b.includes('.') ? b.replace('.', '') : b);
  const [intA, fracA = ''] = a.split('.');
  const [intB, fracB = ''] = b.split('.');
  const decimals = Math.max(fracA.length, fracB.length);
  const factor = 10n ** BigInt(decimals);
  const xNorm = x * factor / (10n ** BigInt(fracA.length || 0));
  const yNorm = y * factor / (10n ** BigInt(fracB.length || 0));
  const sum = xNorm + yNorm;
  const resultStr = sum.toString().padStart(decimals + 1, '0');
  const dotPos = resultStr.length - decimals;
  if (dotPos <= 0) return `0.${'0'.repeat(-dotPos)}${resultStr}`;
  return `${resultStr.slice(0, dotPos)}.${resultStr.slice(dotPos)}`;
}

/** Multiply string by a factor, return string. */
function mulString(amount: string, factor: number): string {
  const num = parseFloat(amount);
  if (isNaN(num)) return '0';
  return (num * factor).toFixed(7).replace(/\.?0+$/, '');
}

/** Parse a string as number, defaulting to 0. */
function toNum(s: string | undefined): number {
  if (s === undefined || s === '' || s === null) return 0;
  return parseFloat(s);
}

// ---------------------------------------------------------------------------
// Asset helpers
// ---------------------------------------------------------------------------

function assetToString(asset: Asset): string {
  if (asset.isNative()) return 'XLM';
  return `${asset.getCode()}:${asset.getIssuer()}`;
}

function parseAssetString(s: string): Asset {
  if (s === 'XLM' || s === 'native') return Asset.native();
  const [code, issuer] = s.split(':');
  if (!issuer) throw new Error(`Invalid asset string: "${s}"`);
  return new Asset(code, issuer);
}

// ---------------------------------------------------------------------------
// Horizon response types (subset we need)
// ---------------------------------------------------------------------------

interface HorizonPathResponse {
  _links: Record<string, unknown>;
  records: Array<{
    source_amount: string;
    destination_amount: string;
    path: Array<{
      asset_type: string;
      asset_code?: string;
      asset_issuer?: string;
    }>;
  }>;
}

interface HorizonOrderbookResponse {
  bids: Array<{ price_r: { n: number; d: number }; amount: string; price: string }>;
  asks: Array<{ price_r: { n: number; d: number }; amount: string; price: string }>;
}

// ---------------------------------------------------------------------------
// Orderbook cache
// ---------------------------------------------------------------------------

export class OrderbookCache {
  private store = new Map<string, CachedOrderbook>();
  private ttlMs: number;

  constructor(ttlMs: number) {
    this.ttlMs = ttlMs;
  }

  private key(base: string, counter: string): string {
    return `${base}:${counter}`;
  }

  get(base: string, counter: string): CachedOrderbook | null {
    const k = this.key(base, counter);
    const entry = this.store.get(k);
    if (!entry) return null;
    if (Date.now() - entry.cachedAt > this.ttlMs) {
      this.store.delete(k);
      return null;
    }
    return entry;
  }

  set(base: string, counter: string, data: CachedOrderbook): void {
    this.store.set(this.key(base, counter), data);
  }

  invalidate(base: string, counter: string): void {
    this.store.delete(this.key(base, counter));
  }

  clear(): void {
    this.store.clear();
  }
}

// ---------------------------------------------------------------------------
// PathFinder – main algorithm
// ---------------------------------------------------------------------------

export class PathFinder {
  private config: PathFinderConfig;
  private http: AxiosInstance;
  private cache: OrderbookCache;

  constructor(config?: Partial<PathFinderConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.http = axios.create({
      baseURL: this.config.horizonUrl,
      timeout: 10_000,
    });
    this.cache = new OrderbookCache(this.config.cacheTtlMs);
  }

  /**
   * Compute the most cost-effective path(s) for a cross-border payment.
   *
   * @param sourceAsset  - source asset string ("XLM" or "CODE:ISSUER")
   * @param destAsset    - destination asset string
   * @param amount       - amount for the send or receive leg
   * @param mode         - "strict_send" or "strict_receive"
   */
  async findPaths(
    sourceAsset: string,
    destAsset: string,
    amount: string,
    mode: PathPaymentMode = 'strict_send',
  ): Promise<PathFinderResult> {
    const result: PathFinderResult = {
      bestPath: null,
      alternativePaths: [],
      usedFallback: false,
      fallbackDescription: null,
      error: null,
    };

    try {
      // 1. Query primary paths
      const rawPaths = await this.queryHorizonPaths(sourceAsset, destAsset, amount, mode);

      if (rawPaths.length > 0) {
        // Convert and enrich with cost data (async due to orderbook queries)
        const paths = await Promise.all(
          rawPaths.map((p) =>
            this.enrichPath(p, sourceAsset, destAsset, amount, mode),
          ),
        );

        // Sort by total cost ascending (numeric comparison)
        paths.sort((a, b) => toNum(a.trueCost.totalCost) - toNum(b.trueCost.totalCost));
        // Also keep alternative paths sorted
        result.alternativePaths = paths.slice(1).sort(
          (a, b) => toNum(a.trueCost.totalCost) - toNum(b.trueCost.totalCost),
        );

        result.bestPath = paths[0];
        result.alternativePaths = paths.slice(1);
        result.usedFallback = false;
        result.fallbackDescription = null;
        result.error = null;

        return result;
      }

      // 2. No direct path found → try fallback assets
      result.usedFallback = true;
      result.fallbackDescription = 'No direct path found; routing through fallback assets.';

      for (const fallback of this.config.fallbackAssets) {
        try {
          // Source → fallback
          const srcToFb = await this.queryHorizonPaths(sourceAsset, fallback, amount, mode);
          // Fallback → destination
          const fbToDest = await this.queryHorizonPaths(fallback, destAsset, amount, mode);

          if (srcToFb.length > 0 && fbToDest.length > 0) {
            // Build a composite path
            const compositePath = this.buildCompositePath(
              srcToFb[0],
              fbToDest[0],
              sourceAsset,
              destAsset,
              amount,
              mode,
              fallback,
            );

            if (compositePath) {
              result.bestPath = compositePath;
              result.alternativePaths = [];
              result.fallbackDescription = `Routed through ${fallback} due to insufficient liquidity on direct path.`;
              return result;
            }
          }
        } catch {
          // Fallback asset failed to parse or query; try the next one
          continue;
        }
      }

      // 3. Still nothing – report error
      result.error =
        'No viable path found. Insufficient liquidity in all available routes, including fallback assets.';
      return result;
    } catch (err: any) {
      result.error = `Path finding failed: ${err.message || err}`;
      return result;
    }
  }

  // -----------------------------------------------------------------------
  // Horizon API calls
  // -----------------------------------------------------------------------

  private async queryHorizonPaths(
    sourceAsset: string,
    destAsset: string,
    amount: string,
    mode: PathPaymentMode,
  ): Promise<Array<{ source_amount: string; destination_amount: string; path: PathHop[] }>> {
    const src = parseAssetString(sourceAsset);
    const dst = parseAssetString(destAsset);

    const endpoint = mode === 'strict_send' ? 'paths/strict-send' : 'paths/strict-receive';

    const params: Record<string, string> = {
      source_asset_type: src.getAssetType(),
      source_asset_code: src.getCode(),
      source_asset_issuer: src.getIssuer() || '',
      destination_asset_type: dst.getAssetType(),
      destination_asset_code: dst.getCode(),
      destination_asset_issuer: dst.getIssuer() || '',
      destination_amount: amount,
    };

    if (mode === 'strict_send') {
      params.source_amount = amount;
      delete params.destination_amount;
    }

    try {
      const resp = await this.http.get<HorizonPathResponse>(`/${endpoint}`, { params });
      return resp.data.records.map((rec) => ({
        source_amount: rec.source_amount,
        destination_amount: rec.destination_amount,
        path: rec.path.map((hop) => ({
          asset: this.hopToAsset(hop),
          amount: '0', // placeholder; Horizon does not return per-hop amounts
        })),
      }));
    } catch {
      return [];
    }
  }

  /** Convert a Horizon path-hop JSON object to an Asset. */
  private hopToAsset(hop: {
    asset_type: string;
    asset_code?: string;
    asset_issuer?: string;
  }): Asset {
    if (hop.asset_type === 'native') return Asset.native();
    return new Asset(hop.asset_code!, hop.asset_issuer!);
  }

  // -----------------------------------------------------------------------
  // Cost calculation
  // -----------------------------------------------------------------------

  /**
   * Enrich a raw path with a full cost breakdown.
   */
  private async enrichPath(
    raw: { source_amount: string; destination_amount: string; path: PathHop[] },
    sourceAsset: string,
    destAsset: string,
    amount: string,
    mode: PathPaymentMode,
  ): Promise<PaymentPath> {
    const sourceAmount = mode === 'strict_send' ? amount : raw.source_amount;
    const destAmount = mode === 'strict_receive' ? amount : raw.destination_amount;

    const spread = await this.calculateSpread(sourceAsset, destAsset, raw);
    const slippage = this.calculateSlippage(sourceAmount);
    const baseFee = this.config.baseFee.toString();
    const total = add(add(spread.spreadAmount, slippage.slippageAmount), baseFee);
    const totalNum = toNum(total);
    const sourceNum = toNum(sourceAmount);
    const totalPercent = sourceNum > 0 ? (totalNum / sourceNum) * 100 : 0;

    const cost: PathCost = {
      spreadPercent: spread.spreadPercent,
      spreadAmount: spread.spreadAmount,
      baseFee,
      slippagePercent: this.config.slippageTolerance * 100,
      slippageAmount: slippage.slippageAmount,
      totalCost: total,
      totalCostPercent: parseFloat(totalPercent.toFixed(4)),
    };

    return {
      sourceAsset,
      destAsset,
      sourceAmount,
      destAmount,
      path: raw.path,
      mode,
      trueCost: cost,
      computedAt: Date.now(),
    };
  }

  /**
   * Estimate spread by querying the orderbook for the trading pair.
   * Falls back to a reasonable default if the orderbook is not available.
   */
  private async calculateSpread(
    sourceAsset: string,
    destAsset: string,
    _raw: { source_amount: string; destination_amount: string; path: PathHop[] },
  ): Promise<{ spreadPercent: number; spreadAmount: string }> {
    // We use the orderbook midpoint vs the path's effective price to estimate spread.
    // For simplicity, we estimate based on best bid / ask spread when available.
    const midMarket = await this.estimateMidMarketPrice(sourceAsset, destAsset);
    const effectivePrice =
      toNum(_raw.source_amount) > 0
        ? toNum(_raw.destination_amount) / toNum(_raw.source_amount)
        : 0;

    if (midMarket <= 0 || effectivePrice <= 0) {
      // Fallback: assume 0.5% spread
      const fallbackSpread = 0.5;
      return {
        spreadPercent: fallbackSpread,
        spreadAmount: mulString(
          _raw.source_amount,
          fallbackSpread / 100,
        ),
      };
    }

    const spreadAbs = Math.abs(effectivePrice - midMarket);
    const spreadPercent = midMarket > 0 ? (spreadAbs / midMarket) * 100 : 0;

    return {
      spreadPercent: parseFloat(spreadPercent.toFixed(4)),
      spreadAmount: mulString(_raw.source_amount, spreadPercent / 100),
    };
  }

  /**
   * Estimate the mid-market price by fetching the orderbook (with caching).
   */
  private async estimateMidMarketPrice(
    baseAsset: string,
    counterAsset: string,
  ): Promise<number> {
    try {
      // Check cache
      if (this.config.enableCache) {
        const cached = this.cache.get(baseAsset, counterAsset);
        if (cached && cached.bids.length > 0 && cached.asks.length > 0) {
          return this.midPriceFromOrderbook(cached.bids, cached.asks);
        }
      }

      const resp = await this.http.get<HorizonOrderbookResponse>('/orderbook', {
        params: {
          selling_asset_type: 'native',
          selling_asset_code: undefined,
          selling_asset_issuer: undefined,
          buying_asset_type: 'native',
          buying_asset_code: undefined,
          buying_asset_issuer: undefined,
        },
      });

      // For a real implementation, parse selling/buying asset from the pair.
      // For now we use a reasonable default.
      // The orderbook endpoint returns orderbook for the specified selling/buying assets.
      // We construct proper params based on the asset strings.
      return await this.fetchOrderbookPrice(baseAsset, counterAsset);
    } catch {
      return 0;
    }
  }

  /**
   * Actually fetch the orderbook price for a specific trading pair.
   */
  private async fetchOrderbookPrice(
    baseAsset: string,
    counterAsset: string,
  ): Promise<number> {
    const base = parseAssetString(baseAsset);
    const counter = parseAssetString(counterAsset);

    const params: Record<string, string | undefined> = {
      selling_asset_type: base.getAssetType(),
      selling_asset_code: base.getCode() === 'XLM' ? undefined : base.getCode(),
      selling_asset_issuer: base.getIssuer() || undefined,
      buying_asset_type: counter.getAssetType(),
      buying_asset_code: counter.getCode() === 'XLM' ? undefined : counter.getCode(),
      buying_asset_issuer: counter.getIssuer() || undefined,
      limit: '20',
    };

    try {
      const resp = await this.http.get<HorizonOrderbookResponse>('/orderbook', { params });
      const orderbook = resp.data;

      // Cache it
      if (this.config.enableCache) {
        this.cache.set(baseAsset, counterAsset, {
          base: baseAsset,
          counter: counterAsset,
          bids: orderbook.bids.map((b) => ({ price: b.price, amount: b.amount })),
          asks: orderbook.asks.map((a) => ({ price: a.price, amount: a.amount })),
          cachedAt: Date.now(),
        });
      }

      if (orderbook.bids.length === 0 || orderbook.asks.length === 0) return 0;
      return this.midPriceFromOrderbook(
        orderbook.bids.map((b) => ({ price: b.price, amount: b.amount })),
        orderbook.asks.map((a) => ({ price: a.price, amount: a.amount })),
      );
    } catch {
      return 0;
    }
  }

  private midPriceFromOrderbook(
    bids: Array<{ price: string; amount: string }>,
    asks: Array<{ price: string; amount: string }>,
  ): number {
    const bestBid = toNum(bids[0]?.price);
    const bestAsk = toNum(asks[0]?.price);
    if (bestBid <= 0 || bestAsk <= 0) return 0;
    return (bestBid + bestAsk) / 2;
  }

  /**
   * Calculate slippage based on the configured tolerance.
   */
  private calculateSlippage(sourceAmount: string): {
    slippagePercent: number;
    slippageAmount: string;
  } {
    const pct = this.config.slippageTolerance * 100;
    const amt = mulString(sourceAmount, this.config.slippageTolerance);
    return { slippagePercent: pct, slippageAmount: amt };
  }

  // -----------------------------------------------------------------------
  // Composite path builder (fallback)
  // -----------------------------------------------------------------------

  /**
   * Build a composite payment path from two separate Horizon path results
   * (source→fallback + fallback→destination).
   */
  private buildCompositePath(
    firstLeg: { source_amount: string; destination_amount: string; path: PathHop[] },
    secondLeg: { source_amount: string; destination_amount: string; path: PathHop[] },
    sourceAsset: string,
    destAsset: string,
    amount: string,
    mode: PathPaymentMode,
    fallbackAsset: string,
  ): PaymentPath | null {
    if (!firstLeg.destination_amount || !secondLeg.destination_amount) return null;

    // Estimate the effective overall cost
    const totalSource = toNum(firstLeg.source_amount);
    const totalDest = toNum(secondLeg.destination_amount);
    const effectiveSpread =
      totalSource > 0 ? ((totalSource - totalDest) / totalSource) * 100 : 0;

    const cost: PathCost = {
      spreadPercent: parseFloat(effectiveSpread.toFixed(4)),
      spreadAmount: mulString(
        firstLeg.source_amount,
        Math.max(effectiveSpread, 0) / 100,
      ),
      baseFee: (this.config.baseFee * 2).toString(), // two transactions
      slippagePercent: this.config.slippageTolerance * 100,
      slippageAmount: mulString(firstLeg.source_amount, this.config.slippageTolerance),
      totalCost: '0',
      totalCostPercent: 0,
    };

    const total = add(
      add(cost.spreadAmount, cost.slippageAmount),
      cost.baseFee,
    );
    cost.totalCost = total;
    const srcNum = toNum(firstLeg.source_amount);
    cost.totalCostPercent = srcNum > 0 ? (toNum(total) / srcNum) * 100 : 0;

    return {
      sourceAsset,
      destAsset,
      sourceAmount: firstLeg.source_amount,
      destAmount: secondLeg.destination_amount,
      path: [...firstLeg.path, ...secondLeg.path],
      mode,
      trueCost: cost,
      computedAt: Date.now(),
    };
  }

  // -----------------------------------------------------------------------
  // Utility
  // -----------------------------------------------------------------------

  /** Update the Horizon URL (e.g., switch to testnet). */
  setHorizonUrl(url: string): void {
    this.config.horizonUrl = url;
    this.http = axios.create({
      baseURL: url,
      timeout: 10_000,
    });
  }

  /** Get current configuration. */
  getConfig(): PathFinderConfig {
    return { ...this.config };
  }

  /** Update configuration. */
  updateConfig(partial: Partial<PathFinderConfig>): void {
    this.config = { ...this.config, ...partial };
    if (partial.cacheTtlMs !== undefined) {
      this.cache = new OrderbookCache(this.config.cacheTtlMs);
    }
  }

  /** Clear cached orderbook data. */
  clearCache(): void {
    this.cache.clear();
  }
}