/**
 * Core types for the cross-border payment routing system.
 */

import { Asset } from '@stellar/stellar-sdk';

/** Signed message envelope transmitted over the P2P network */
export interface SignedMessage {
  /** The raw string payload */
  payload: string;
  /** Stellar public key of the sender (G... address) */
  senderPublicKey: string;
  /** Hex-encoded Ed25519 signature of the payload bytes */
  signature: string;
}

/** Supported Stellar path payment modes */
export type PathPaymentMode = 'strict_send' | 'strict_receive';

/** Represents a single hop in a payment path */
export interface PathHop {
  /** The asset being sent from this hop */
  asset: Asset;
  /** Amount going through this hop (string to preserve precision) */
  amount: string;
}

/** A complete payment path from source to destination */
export interface PaymentPath {
  /** The source asset */
  sourceAsset: string;
  /** The destination asset */
  destAsset: string;
  /** Amount to send (for strict_send) or receive (for strict_receive) */
  sourceAmount: string;
  /** Amount to receive (for strict_send) or send (for strict_receive) */
  destAmount: string;
  /** The ordered list of hops (intermediate assets) */
  path: PathHop[];
  /** The payment mode used */
  mode: PathPaymentMode;
  /** The true cost after factoring in spread, fees, and slippage */
  trueCost: PathCost;
  /** Timestamp when this path was computed */
  computedAt: number;
}

/** Cost breakdown for a payment path */
export interface PathCost {
  /** Spread as a percentage (e.g., 0.5 for 0.5%) */
  spreadPercent: number;
  /** Spread amount in source asset units */
  spreadAmount: string;
  /** Base network fee in XLM */
  baseFee: string;
  /** Slippage as a percentage */
  slippagePercent: number;
  /** Slippage amount in source asset units */
  slippageAmount: string;
  /** Total cost in source asset units (spread + baseFee + slippage) */
  totalCost: string;
  /** Total cost as a percentage of the source amount */
  totalCostPercent: number;
}

/** Configuration for the PathFinder algorithm */
export interface PathFinderConfig {
  /** Stellar Horizon URL */
  horizonUrl: string;
  /** Network passphrase (e.g., 'Public Global Stellar Network ; September 2015') */
  networkPassphrase: string;
  /** Base fee in stroops (default: 100 = 0.00001 XLM) */
  baseFee: number;
  /** Slippage tolerance as a decimal (e.g., 0.01 for 1%) */
  slippageTolerance: number;
  /** Maximum number of path hops allowed (default: 5) */
  maxPathHops: number;
  /** Time-to-live for cached orderbook states in ms (default: 30_000) */
  cacheTtlMs: number;
  /** Whether to enable caching of orderbook states */
  enableCache: boolean;
  /** Fallback assets to try when direct paths have insufficient liquidity */
  fallbackAssets: string[];
}

/** Result from path finding, including fallback information */
export interface PathFinderResult {
  /** The best path found, if any */
  bestPath: PaymentPath | null;
  /** Alternative paths ranked by cost */
  alternativePaths: PaymentPath[];
  /** Whether the best path uses a fallback (intermediate) asset */
  usedFallback: boolean;
  /** The fallback strategy description if fallback was used */
  fallbackDescription: string | null;
  /** Error description if no path was found */
  error: string | null;
}

/** Security and audit metadata for a yield strategy / protocol */
export interface StrategyMetadata {
  /** Protocol name */
  name: string;
  /** Numeric risk score from 0 (lowest risk) to 100 (highest risk) */
  riskScore: number;
  /** URL to the smart-contract audit report */
  auditLink: string;
}

/** Cached orderbook data for a trading pair */
export interface CachedOrderbook {
  /** Base asset code */
  base: string;
  /** Counter asset code */
  counter: string;
  /** Bids (buy orders) */
  bids: Array<{ price: string; amount: string }>;
  /** Asks (sell orders) */
  asks: Array<{ price: string; amount: string }>;
  /** Timestamp when cached */
  cachedAt: number;
}