// Manual mock for @stellar/stellar-sdk
// Delegates Keypair and StrKey to the real SDK so sign/verify use actual Ed25519.
// Everything else (Asset, Networks, etc.) uses lightweight stubs.

class Asset {
  code: string;
  issuer: string;

  constructor(code: string, issuer?: string) {
    this.code = code;
    this.issuer = issuer || '';
  }

  getCode(): string { return this.code; }
  getIssuer(): string { return this.issuer; }
  getAssetType(): string { return this.code === 'XLM' ? 'native' : 'credit_alphanum4'; }
  isNative(): boolean { return this.code === 'XLM'; }
  static native(): Asset { return new Asset('XLM'); }
}

// ---------------------------------------------------------------------------
// Keypair — delegate to the *real* SDK so sign/verify use real Ed25519 math.
// ---------------------------------------------------------------------------
// eslint-disable-next-line @typescript-eslint/no-var-requires
const realSdk = jest.requireActual('@stellar/stellar-sdk');

module.exports = {
  Asset,
  // Expose the real Keypair so signing tests work with actual Ed25519
  Keypair: realSdk.Keypair,
  Operation: { pathPaymentStrictSend: jest.fn(), pathPaymentStrictReceive: jest.fn() },
  TransactionBuilder: jest.fn(),
  BASE_FEE: '100',
  Networks: {
    PUBLIC: 'Public Global Stellar Network ; September 2015',
    TESTNET: 'Test SDF Network ; September 2015',
  },
  StrKey: realSdk.StrKey,
  xdr: {},
};
