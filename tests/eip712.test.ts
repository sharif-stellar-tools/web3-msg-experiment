import {
  hashTypedData,
  verifySignature,
  recoverSigner,
  formatTypedData,
  EIP712Message,
} from '../src/core/eip712';
import { ethers } from 'ethers';

describe('EIP-712 Module', () => {
  let signer: ethers.Wallet;
  let typedData: EIP712Message;

  beforeEach(() => {
    // Create a deterministic signer for testing
    signer = new ethers.Wallet(
      '0x0123456789012345678901234567890123456789012345678901234567890123'
    );

    typedData = {
      domain: {
        name: 'TestApp',
        version: '1',
        chainId: 1,
        verifyingContract: '0x0000000000000000000000000000000000000000',
      },
      types: {
        Message: [
          { name: 'content', type: 'string' },
          { name: 'nonce', type: 'uint256' },
        ],
      },
      primaryType: 'Message',
      message: {
        content: 'Test message',
        nonce: 1,
      },
    };
  });

  describe('hashTypedData', () => {
    it('should hash typed data consistently', () => {
      const hash1 = hashTypedData(typedData);
      const hash2 = hashTypedData(typedData);

      expect(hash1).toBe(hash2);
      expect(hash1).toMatch(/^0x[0-9a-f]{64}$/i);
    });

    it('should produce different hashes for different messages', () => {
      const hash1 = hashTypedData(typedData);

      const typedData2 = { ...typedData };
      typedData2.message = { ...typedData2.message, nonce: 2 };

      const hash2 = hashTypedData(typedData2);

      expect(hash1).not.toBe(hash2);
    });

    it('should work with minimal domain', () => {
      const minimalData = {
        domain: { name: 'App' },
        types: {
          Test: [{ name: 'value', type: 'string' }],
        },
        primaryType: 'Test',
        message: { value: 'test' },
      };

      const hash = hashTypedData(minimalData);
      expect(hash).toMatch(/^0x[0-9a-f]{64}$/i);
    });
  });

  describe('verifySignature', () => {
    it('should verify valid signature', async () => {
      const signature = await signer.signTypedData(
        typedData.domain,
        typedData.types,
        typedData.message
      );

      const isValid = verifySignature(typedData, signature, signer.address);

      expect(isValid).toBe(true);
    });

    it('should reject invalid signature', () => {
      const invalidSignature =
        '0x0000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000';

      const isValid = verifySignature(
        typedData,
        invalidSignature,
        signer.address
      );

      expect(isValid).toBe(false);
    });

    it('should reject signature from wrong signer', async () => {
      const signature = await signer.signTypedData(
        typedData.domain,
        typedData.types,
        typedData.message
      );

      const wrongSigner = ethers.Wallet.createRandom().address;
      const isValid = verifySignature(typedData, signature, wrongSigner);

      expect(isValid).toBe(false);
    });

    it('should reject signature when message is modified', async () => {
      const signature = await signer.signTypedData(
        typedData.domain,
        typedData.types,
        typedData.message
      );

      typedData.message.content = 'Modified message';

      const isValid = verifySignature(typedData, signature, signer.address);

      expect(isValid).toBe(false);
    });
  });

  describe('recoverSigner', () => {
    it('should recover correct signer address', async () => {
      const signature = await signer.signTypedData(
        typedData.domain,
        typedData.types,
        typedData.message
      );

      const recoveredAddress = recoverSigner(typedData, signature);

      expect(recoveredAddress.toLowerCase()).toBe(signer.address.toLowerCase());
    });

    it('should recover signer even with different case addresses', async () => {
      const signature = await signer.signTypedData(
        typedData.domain,
        typedData.types,
        typedData.message
      );

      const recovered = recoverSigner(typedData, signature);

      expect(recovered).toBe(
        ethers.getAddress(signer.address) // Returns checksummed address
      );
    });
  });

  describe('formatTypedData', () => {
    it('should format typed data correctly', () => {
      const domain = { name: 'App', version: '1' };
      const types = { Message: [{ name: 'text', type: 'string' }] };
      const message = { text: 'Hello' };

      const formatted = formatTypedData(domain, types, 'Message', message);

      expect(formatted.domain).toEqual(domain);
      expect(formatted.types).toEqual(types);
      expect(formatted.primaryType).toBe('Message');
      expect(formatted.message).toEqual(message);
    });
  });

  describe('Complex Types', () => {
    it('should support nested structures', async () => {
      const complexData: EIP712Message = {
        domain: { name: 'ComplexApp' },
        types: {
          Person: [
            { name: 'name', type: 'string' },
            { name: 'age', type: 'uint256' },
          ],
          Message: [
            { name: 'author', type: 'Person' },
            { name: 'content', type: 'string' },
          ],
        },
        primaryType: 'Message',
        message: {
          author: { name: 'Alice', age: 30 },
          content: 'Hello',
        },
      };

      const signature = await signer.signTypedData(
        complexData.domain,
        complexData.types,
        complexData.message
      );

      const isValid = verifySignature(complexData, signature, signer.address);
      expect(isValid).toBe(true);
    });

    it('should support array types', async () => {
      const arrayData: EIP712Message = {
        domain: { name: 'ArrayApp' },
        types: {
          Item: [
            { name: 'id', type: 'uint256' },
            { name: 'name', type: 'string' },
          ],
          Batch: [
            { name: 'items', type: 'Item[]' },
            { name: 'count', type: 'uint256' },
          ],
        },
        primaryType: 'Batch',
        message: {
          items: [
            { id: 1, name: 'Item1' },
            { id: 2, name: 'Item2' },
          ],
          count: 2,
        },
      };

      const signature = await signer.signTypedData(
        arrayData.domain,
        arrayData.types,
        arrayData.message
      );

      const isValid = verifySignature(arrayData, signature, signer.address);
      expect(isValid).toBe(true);
    });
  });

  describe('Edge Cases', () => {
    it('should handle empty messages gracefully', () => {
      const emptyData: EIP712Message = {
        domain: { name: 'EmptyApp' },
        types: {
          Empty: [],
        },
        primaryType: 'Empty',
        message: {},
      };

      expect(() => hashTypedData(emptyData)).not.toThrow();
    });

    it('should handle large numeric values', async () => {
      const largeData: EIP712Message = {
        domain: { name: 'LargeApp' },
        types: {
          BigNumber: [{ name: 'value', type: 'uint256' }],
        },
        primaryType: 'BigNumber',
        message: {
          value: ethers.MaxUint256.toString(),
        },
      };

      const signature = await signer.signTypedData(
        largeData.domain,
        largeData.types,
        largeData.message
      );

      const isValid = verifySignature(largeData, signature, signer.address);
      expect(isValid).toBe(true);
    });

    it('should be case-insensitive for addresses', async () => {
      const signature = await signer.signTypedData(
        typedData.domain,
        typedData.types,
        typedData.message
      );

      const lowerCase = signer.address.toLowerCase();
      const upperCase = signer.address.toUpperCase();

      const isValidLower = verifySignature(typedData, signature, lowerCase);
      const isValidUpper = verifySignature(typedData, signature, upperCase);

      expect(isValidLower).toBe(true);
      expect(isValidUpper).toBe(true);
    });
  });
});
