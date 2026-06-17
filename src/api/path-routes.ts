/**
 * Internal API routes for the cross-border payment routing algorithm.
 *
 * Exposes an endpoint for the front-end to query the best payment path
 * before submitting a transaction.
 */

import { PathFinder, } from '../core/pathfinder';
import { PathFinderConfig, PathFinderResult, PathPaymentMode } from '../core/types';

/** Request body for the /api/paths/find endpoint */
export interface FindPathsRequest {
  /** Source asset (e.g., "XLM" or "USDC:GA5Z...") */
  sourceAsset: string;
  /** Destination asset (e.g., "EURT:GAP5...") */
  destAsset: string;
  /** Amount to send (for strict_send) or receive (for strict_receive) */
  amount: string;
  /** Path payment mode (default: "strict_send") */
  mode?: PathPaymentMode;
}

/** Response shape for the /api/paths/find endpoint */
export interface FindPathsResponse {
  success: boolean;
  data?: PathFinderResult;
  error?: string;
}

/**
 * API handler for path-finding operations.
 *
 * Usage:
 *   // Express.js style:
 *   app.post('/api/paths/find', pathRoutes.handleFindPaths);
 */
export class PathRoutes {
  private pathFinder: PathFinder;

  constructor(config?: Partial<PathFinderConfig>) {
    this.pathFinder = new PathFinder(config);
  }

  /**
   * Handle a POST request to find the best payment path.
   *
   * Expects a JSON body matching FindPathsRequest.
   * Returns a JSON response with the PathFinderResult.
   */
  handleFindPaths = async (req: { body: FindPathsRequest }): Promise<FindPathsResponse> => {
    try {
      const { sourceAsset, destAsset, amount, mode } = req.body;

      // Validate required fields
      if (!sourceAsset || !destAsset || !amount) {
        return {
          success: false,
          error: 'Missing required fields: sourceAsset, destAsset, amount',
        };
      }

      // Validate amount is a positive number
      const amtNum = parseFloat(amount);
      if (isNaN(amtNum) || amtNum <= 0) {
        return {
          success: false,
          error: 'amount must be a positive number',
        };
      }

      // Validate mode
      const paymentMode: PathPaymentMode = mode === 'strict_receive' ? 'strict_receive' : 'strict_send';

      const result = await this.pathFinder.findPaths(
        sourceAsset,
        destAsset,
        amount,
        paymentMode,
      );

      return {
        success: !result.error || result.bestPath !== null,
        data: result,
        error: result.error || undefined,
      };
    } catch (err: any) {
      return {
        success: false,
        error: `Internal error: ${err.message || err}`,
      };
    }
  };

  /**
   * Update the PathFinder configuration.
   */
  updateConfig(config: Partial<PathFinderConfig>): void {
    this.pathFinder.updateConfig(config);
  }

  /**
   * Get the current PathFinder configuration.
   */
  getConfig(): PathFinderConfig {
    return this.pathFinder.getConfig();
  }

  /**
   * Switch to Stellar testnet.
   */
  useTestnet(): void {
    this.pathFinder.setHorizonUrl('https://horizon-testnet.stellar.org');
    this.pathFinder.updateConfig({ networkPassphrase: 'Test SDF Network ; September 2015' });
  }

  /**
   * Switch to Stellar mainnet.
   */
  useMainnet(): void {
    this.pathFinder.setHorizonUrl('https://horizon.stellar.org');
    this.pathFinder.updateConfig({ networkPassphrase: 'Public Global Stellar Network ; September 2015' });
  }

  /** Clear the orderbook cache. */
  clearCache(): void {
    this.pathFinder.clearCache();
  }
}