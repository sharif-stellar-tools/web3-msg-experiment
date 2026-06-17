import request from 'supertest';
import { ethers } from 'ethers';
import { createApp } from '../../src/api/app';
import { EIP712Message } from '../../src/core/eip712';

describe('EIP-712 Integration Tests', () => {
  const app = createApp();
  let signer: ethers.Wallet;
  let typedData: EIP712Message;

  beforeEach(() => {
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

  describe('POST /api/eip712/validate', () => {
    describe('Positive Tests', () => {
      it('should validate a valid signature', async () => {
        const signature = await signer.signTypedData(
          typedData.domain,
          typedData.types,
          typedData.message
        );

        const response = await request(app)
          .post('/api/eip712/validate')
          .send({
            typedData,
            signature,
            expectedSigner: signer.address,
          });

        expect(response.status).toBe(200);
        expect(response.body).toEqual({
          success: true,
          hash: expect.stringMatching(/^0x[0-9a-f]{64}$/i),
          valid: true,
        });
      });

      it('should recover signer from valid signature', async () => {
        const signature = await signer.signTypedData(
          typedData.domain,
          typedData.types,
          typedData.message
        );

        const response = await request(app)
          .post('/api/eip712/validate')
          .send({
            typedData,
            signature,
          });

        expect(response.status).toBe(200);
        expect(response.body).toEqual({
          success: true,
          hash: expect.stringMatching(/^0x[0-9a-f]{64}$/i),
          signer: signer.address,
          valid: true,
        });
      });

      it('should complete full challenge-response flow', async () => {
        const challengeMessage: EIP712Message = {
          domain: {
            name: 'AuthApp',
            version: '1',
            chainId: 1,
          },
          types: {
            Challenge: [
              { name: 'nonce', type: 'string' },
              { name: 'timestamp', type: 'uint256' },
            ],
          },
          primaryType: 'Challenge',
          message: {
            nonce: '0x' + Math.random().toString(16).slice(2),
            timestamp: Math.floor(Date.now() / 1000),
          },
        };

        const signature = await signer.signTypedData(
          challengeMessage.domain,
          challengeMessage.types,
          challengeMessage.message
        );

        const response = await request(app)
          .post('/api/eip712/validate')
          .send({
            typedData: challengeMessage,
            signature,
            expectedSigner: signer.address,
          });

        expect(response.status).toBe(200);
        expect(response.body.success).toBe(true);
        expect(response.body.valid).toBe(true);
      });
    });

    describe('Negative Tests', () => {
      it('should reject invalid signature', async () => {
        const invalidSignature =
          '0x0000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000';

        const response = await request(app)
          .post('/api/eip712/validate')
          .send({
            typedData,
            signature: invalidSignature,
            expectedSigner: signer.address,
          });

        expect(response.status).toBe(200);
        expect(response.body.success).toBe(true);
        expect(response.body.valid).toBe(false);
      });

      it('should reject signature from wrong signer', async () => {
        const signature = await signer.signTypedData(
          typedData.domain,
          typedData.types,
          typedData.message
        );

        const wrongSigner = ethers.Wallet.createRandom().address;

        const response = await request(app)
          .post('/api/eip712/validate')
          .send({
            typedData,
            signature,
            expectedSigner: wrongSigner,
          });

        expect(response.status).toBe(200);
        expect(response.body.success).toBe(true);
        expect(response.body.valid).toBe(false);
      });

      it('should reject request with missing typedData', async () => {
        const response = await request(app)
          .post('/api/eip712/validate')
          .send({
            signature: '0x123',
          });

        expect(response.status).toBe(400);
        expect(response.body.success).toBe(false);
        expect(response.body.error).toContain('Missing');
      });

      it('should reject request with missing signature', async () => {
        const response = await request(app)
          .post('/api/eip712/validate')
          .send({
            typedData,
          });

        expect(response.status).toBe(400);
        expect(response.body.success).toBe(false);
        expect(response.body.error).toContain('Missing');
      });

      it('should reject tampered message', async () => {
        const originalSignature = await signer.signTypedData(
          typedData.domain,
          typedData.types,
          typedData.message
        );

        const tamperedData = JSON.parse(JSON.stringify(typedData));
        tamperedData.message.content = 'Tampered content';

        const response = await request(app)
          .post('/api/eip712/validate')
          .send({
            typedData: tamperedData,
            signature: originalSignature,
            expectedSigner: signer.address,
          });

        expect(response.status).toBe(200);
        expect(response.body.valid).toBe(false);
      });

      it('should reject malformed signature', async () => {
        const response = await request(app)
          .post('/api/eip712/validate')
          .send({
            typedData,
            signature: 'not-a-valid-signature',
            expectedSigner: signer.address,
          });

        expect(response.status).toBe(200);
        expect(response.body.success).toBe(true);
        expect(response.body.valid).toBe(false);
      });
    });

    describe('Edge Cases', () => {
      it('should handle multiple signers in sequence', async () => {
        const signer2 = ethers.Wallet.createRandom();
        const signature1 = await signer.signTypedData(
          typedData.domain,
          typedData.types,
          typedData.message
        );
        const signature2 = await signer2.signTypedData(
          typedData.domain,
          typedData.types,
          typedData.message
        );

        const response1 = await request(app)
          .post('/api/eip712/validate')
          .send({
            typedData,
            signature: signature1,
            expectedSigner: signer.address,
          });

        const response2 = await request(app)
          .post('/api/eip712/validate')
          .send({
            typedData,
            signature: signature2,
            expectedSigner: signer2.address,
          });

        expect(response1.status).toBe(200);
        expect(response1.body.valid).toBe(true);
        expect(response2.status).toBe(200);
        expect(response2.body.valid).toBe(true);
      });

      it('should be case-insensitive for signer address', async () => {
        const signature = await signer.signTypedData(
          typedData.domain,
          typedData.types,
          typedData.message
        );

        const responseLower = await request(app)
          .post('/api/eip712/validate')
          .send({
            typedData,
            signature,
            expectedSigner: signer.address.toLowerCase(),
          });

        const responseUpper = await request(app)
          .post('/api/eip712/validate')
          .send({
            typedData,
            signature,
            expectedSigner: signer.address.toUpperCase(),
          });

        expect(responseLower.status).toBe(200);
        expect(responseLower.body.valid).toBe(true);
        expect(responseUpper.status).toBe(200);
        expect(responseUpper.body.valid).toBe(true);
      });

      it('should handle complex nested types', async () => {
        const complexTypedData: EIP712Message = {
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
            content: 'Hello World',
          },
        };

        const signature = await signer.signTypedData(
          complexTypedData.domain,
          complexTypedData.types,
          complexTypedData.message
        );

        const response = await request(app)
          .post('/api/eip712/validate')
          .send({
            typedData: complexTypedData,
            signature,
            expectedSigner: signer.address,
          });

        expect(response.status).toBe(200);
        expect(response.body.success).toBe(true);
        expect(response.body.valid).toBe(true);
      });
    });
  });
});
