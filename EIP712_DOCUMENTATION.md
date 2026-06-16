# EIP-712 Typed Data Signing Support

## Overview

This module provides comprehensive support for EIP-712 typed data signing, enabling cross-chain authentication between Ethereum/EVM-compatible wallets and the Stellar ecosystem.

## Features

- **Type Hashing**: Hash typed data according to EIP-712 specification
- **Signature Verification**: Verify EIP-712 signatures against expected signers
- **Signer Recovery**: Recover signer address from a given signature
- **Type Formatting**: Format messages into proper EIP-712 structure

## API Reference

### `hashTypedData(typedData: EIP712Message): string`

Computes the hash of typed data according to EIP-712 specification.

**Parameters:**
- `typedData`: EIP712Message object containing domain, types, primaryType, and message

**Returns:** 32-byte hex string hash

**Example:**
```typescript
const typedData = {
  domain: {
    name: 'MyApp',
    version: '1',
    chainId: 1,
    verifyingContract: '0x...'
  },
  types: {
    Message: [
      { name: 'content', type: 'string' },
      { name: 'timestamp', type: 'uint256' }
    ]
  },
  primaryType: 'Message',
  message: {
    content: 'Hello World',
    timestamp: 1234567890
  }
};

const hash = hashTypedData(typedData);
```

### `verifySignature(typedData: EIP712Message, signature: string, expectedSigner: string): boolean`

Verifies that a signature was created by the expected signer.

**Parameters:**
- `typedData`: The typed data that was signed
- `signature`: The signature hex string
- `expectedSigner`: The expected signer address

**Returns:** `true` if signature is valid, `false` otherwise

### `recoverSigner(typedData: EIP712Message, signature: string): string`

Recovers the signer address from a signature.

**Parameters:**
- `typedData`: The typed data that was signed
- `signature`: The signature hex string

**Returns:** The recovered signer address (checksummed)

### `formatTypedData(...): EIP712Message`

Helper function to format message into EIP-712 structure.

## Endpoint

### POST `/api/eip712/validate`

Validates an EIP-712 signature.

**Request Body:**
```json
{
  "typedData": {
    "domain": {
      "name": "string",
      "version": "string",
      "chainId": "number",
      "verifyingContract": "string"
    },
    "types": {
      "TypeName": [
        { "name": "fieldName", "type": "fieldType" }
      ]
    },
    "primaryType": "string",
    "message": {
      "fieldName": "value"
    }
  },
  "signature": "0x...",
  "expectedSigner": "0x..." // optional
}
```

**Response:**
```json
{
  "success": true,
  "hash": "0x...",
  "valid": true,
  "signer": "0x..." // if expectedSigner not provided
}
```

## Limitations and Edge Cases

### Cross-Chain Considerations

1. **Chain ID Mismatch**: The `chainId` in the domain must match the intended signing chain. Mismatches won't prevent signing but may indicate a phishing attempt.

2. **Contract Verification**: When using `verifyingContract`, ensure the contract address is on the expected chain and is trusted.

3. **Domain Separator**: Each domain is unique. Signatures from one domain cannot be replayed to another.

### Type Safety

- **Complex Types**: Arrays and nested structs are supported but must be properly encoded
- **Custom Types**: Only primitive types and other custom types defined in the `types` field are valid
- **Type Ordering**: Type field order matters for encoding

### Signature Format

- **Format**: Signatures must be 65-byte hex strings (130 chars with `0x` prefix) in format `r + s + v`
- **v Component**: Must be 27 or 28 for mainnet/standard chains
- **Recovery**: The `v` component contains the recovery ID for address recovery

### Known Limitations

1. **No Contract Call Verification**: This module verifies the cryptographic signature but cannot verify if the signer has authority in a smart contract context.

2. **Hardware Wallet Compatibility**: Works with any wallet that supports EIP-712, but specific implementations (MetaMask, Ledger, etc.) may have nuances in domain display.

3. **Timestamp Validation**: The module does not validate timestamp fields; applications must implement their own replay protection.

4. **Gas Considerations**: On-chain verification would require a contract implementing signature validation separately.

## Security Considerations

- Always validate the domain matches expected values before processing signatures
- Implement nonce/timestamp checks to prevent replay attacks
- Use checksummed addresses for comparison
- Validate that `verifyingContract` addresses are trusted

## Usage Example

```typescript
import {
  hashTypedData,
  verifySignature,
  recoverSigner,
} from './core/eip712';

// Define typed data
const typedData = {
  domain: { name: 'MyApp', version: '1', chainId: 1 },
  types: {
    Message: [
      { name: 'text', type: 'string' },
      { name: 'nonce', type: 'uint256' },
    ],
  },
  primaryType: 'Message',
  message: {
    text: 'Sign this message',
    nonce: 1,
  },
};

// Recover signer from signature
const signer = recoverSigner(typedData, signature);

// Verify against expected signer
const isValid = verifySignature(typedData, signature, expectedAddress);
```
