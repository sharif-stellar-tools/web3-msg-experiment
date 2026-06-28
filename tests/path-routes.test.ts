/**
 * Tests for PathRoutes – covers StrategyMetadata (riskScore and auditLink) passthrough.
 *
 * @jest-environment node
 */

jest.mock('axios', () => {
  const mockGet = jest.fn();
  const mockCreate = jest.fn(() => ({
    get: mockGet,
    defaults: {},
    interceptors: { request: { use: jest.fn() }, response: { use: jest.fn() } },
  }));
  return { create: mockCreate, get: mockGet, defaults: {}, interceptors: { request: { use: jest.fn() }, response: { use: jest.fn() } } } as any;
});

import axios from 'axios';
import { PathRoutes, FindPathsRequest, FindPathsResponse } from '../src/api/path-routes';
import { StrategyMetadata } from '../src/core/types';

function getMockGet(): jest.Mock {
  return ((axios as any).create as jest.Mock)().get as jest.Mock;
}

function mockPathsResponse(records: object[]): void {
  getMockGet().mockResolvedValueOnce({ data: { _links: {}, records } });
}

const BASE_RECORD = { source_amount: '100', destination_amount: '100', path: [] };

describe('PathRoutes – StrategyMetadata (issue #76)', () => {
  let routes: PathRoutes;

  beforeEach(() => {
    jest.clearAllMocks();
    routes = new PathRoutes({ enableCache: false });
  });

  it('should include strategyMetadata in the response when provided', async () => {
    mockPathsResponse([BASE_RECORD]);

    const meta: StrategyMetadata = {
      name: 'Aquarius',
      riskScore: 42,
      auditLink: 'https://example.com/audit/aquarius',
    };

    const req: { body: FindPathsRequest } = {
      body: {
        sourceAsset: 'XLM',
        destAsset: 'USDC:GABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789',
        amount: '100',
        strategyMetadata: meta,
      },
    };

    const res: FindPathsResponse = await routes.handleFindPaths(req);

    expect(res.success).toBe(true);
    expect(res.strategyMetadata).toBeDefined();
    expect(res.strategyMetadata!.name).toBe('Aquarius');
    expect(res.strategyMetadata!.riskScore).toBe(42);
    expect(res.strategyMetadata!.auditLink).toBe('https://example.com/audit/aquarius');
  });

  it('should omit strategyMetadata from the response when not provided', async () => {
    mockPathsResponse([BASE_RECORD]);

    const req: { body: FindPathsRequest } = {
      body: {
        sourceAsset: 'XLM',
        destAsset: 'USDC:GABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789',
        amount: '100',
      },
    };

    const res: FindPathsResponse = await routes.handleFindPaths(req);

    expect(res.success).toBe(true);
    expect(res.strategyMetadata).toBeUndefined();
  });

  it('should preserve riskScore of 0 (boundary value)', async () => {
    mockPathsResponse([BASE_RECORD]);

    const meta: StrategyMetadata = {
      name: 'SafeProtocol',
      riskScore: 0,
      auditLink: 'https://example.com/audit/safe',
    };

    const res = await routes.handleFindPaths({ body: { sourceAsset: 'XLM', destAsset: 'USDC:GABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789', amount: '50', strategyMetadata: meta } });

    expect(res.strategyMetadata!.riskScore).toBe(0);
  });

  it('should preserve riskScore of 100 (boundary value)', async () => {
    mockPathsResponse([BASE_RECORD]);

    const meta: StrategyMetadata = {
      name: 'HighRisk',
      riskScore: 100,
      auditLink: 'https://example.com/audit/highrisk',
    };

    const res = await routes.handleFindPaths({ body: { sourceAsset: 'XLM', destAsset: 'USDC:GABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789', amount: '50', strategyMetadata: meta } });

    expect(res.strategyMetadata!.riskScore).toBe(100);
    expect(res.strategyMetadata!.auditLink).toBe('https://example.com/audit/highrisk');
  });

  it('should return an error when required fields are missing, regardless of strategyMetadata', async () => {
    const res = await routes.handleFindPaths({
      body: {
        sourceAsset: '',
        destAsset: 'USDC:GABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789',
        amount: '100',
        strategyMetadata: { name: 'Test', riskScore: 10, auditLink: 'https://example.com' },
      } as FindPathsRequest,
    });

    expect(res.success).toBe(false);
    expect(res.error).toContain('Missing required fields');
  });
});
