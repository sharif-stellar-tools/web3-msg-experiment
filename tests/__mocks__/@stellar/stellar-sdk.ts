// Manual mock for @stellar/stellar-sdk
// Must support `new Asset(code, issuer)` since pathfinder.ts uses it that way.

class Asset {
  code: string;
  issuer: string;

  constructor(code: string, issuer?: string) {
    this.code = code;
    this.issuer = issuer || '';
  }

  getCode(): string {
    return this.code;
  }

  getIssuer(): string {
    return this.issuer;
  }

  getAssetType(): string {
    return this.code === 'XLM' ? 'native' : 'credit_alphanum4';
  }

  isNative(): boolean {
    return this.code === 'XLM';
  }

  static native(): Asset {
    return new Asset('XLM');
  }
}

module.exports = {
  Asset,
  Keypair: { fromRawEd25519Seed: jest.fn(), random: jest.fn() },
  Operation: { pathPaymentStrictSend: jest.fn(), pathPaymentStrictReceive: jest.fn() },
  TransactionBuilder: jest.fn(),
  BASE_FEE: '100',
  Networks: {
    PUBLIC: 'Public Global Stellar Network ; September 2015',
    TESTNET: 'Test SDF Network ; September 2015',
  },
  StrKey: { isValidEd25519PublicKey: jest.fn() },
  xdr: {},
};