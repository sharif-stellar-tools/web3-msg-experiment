import { Keypair } from '@stellar/stellar-sdk';
import { SignedMessage } from './types';

/**
 * Sign a string payload with the given Stellar Keypair.
 * The payload is encoded to UTF-8 bytes before signing.
 */
export function signMessage(payload: string, keypair: Keypair): SignedMessage {
  const payloadBytes = Buffer.from(payload, 'utf8');
  const signatureBytes = keypair.sign(payloadBytes);
  return {
    payload,
    senderPublicKey: keypair.publicKey(),
    signature: Buffer.from(signatureBytes).toString('hex'),
  };
}

/**
 * Verify a SignedMessage using the embedded senderPublicKey.
 * Returns true if the signature is valid, false otherwise.
 */
export function verifyMessage(message: SignedMessage): boolean {
  try {
    const { payload, senderPublicKey, signature } = message;
    const payloadBytes = Buffer.from(payload, 'utf8');
    const signatureBytes = Buffer.from(signature, 'hex');
    const keypair = Keypair.fromPublicKey(senderPublicKey);
    return keypair.verify(payloadBytes, signatureBytes);
  } catch {
    return false;
  }
}

/**
 * Serialize a SignedMessage to a JSON string for transmission.
 */
export function serializeMessage(message: SignedMessage): string {
  return JSON.stringify(message);
}

/**
 * Deserialize a JSON string into a SignedMessage.
 * Returns null if parsing fails or required fields are missing.
 */
export function deserializeMessage(raw: string): SignedMessage | null {
  try {
    const parsed = JSON.parse(raw);
    if (
      typeof parsed.payload === 'string' &&
      typeof parsed.senderPublicKey === 'string' &&
      typeof parsed.signature === 'string'
    ) {
      return parsed as SignedMessage;
    }
    return null;
  } catch {
    return null;
  }
}
