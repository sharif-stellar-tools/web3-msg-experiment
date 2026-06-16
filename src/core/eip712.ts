import { ethers } from 'ethers';

/**
 * EIP-712 Typed Data Signing Module
 * Supports parsing, hashing, and verification of EIP-712 typed data signatures
 */

export interface EIP712Domain {
  name?: string;
  version?: string;
  chainId?: number;
  verifyingContract?: string;
  salt?: string;
}

export interface EIP712Message {
  types: Record<string, Array<{ name: string; type: string }>>;
  primaryType: string;
  domain: EIP712Domain;
  message: Record<string, any>;
}

/**
 * Hash typed data according to EIP-712
 * @param typedData - The EIP-712 typed data payload
 * @returns The hash of the typed data
 */
export function hashTypedData(typedData: EIP712Message): string {
  return ethers.TypedDataEncoder.hash(
    typedData.domain,
    typedData.types,
    typedData.message
  );
}

/**
 * Verify an EIP-712 signature
 * @param typedData - The EIP-712 typed data payload
 * @param signature - The signature to verify
 * @param expectedSigner - The expected signer address
 * @returns True if signature is valid, false otherwise
 */
export function verifySignature(
  typedData: EIP712Message,
  signature: string,
  expectedSigner: string
): boolean {
  try {
    const hash = hashTypedData(typedData);
    const recoveredAddress = ethers.recoverAddress(hash, signature);
    return recoveredAddress.toLowerCase() === expectedSigner.toLowerCase();
  } catch (error) {
    return false;
  }
}

/**
 * Recover signer address from EIP-712 signature
 * @param typedData - The EIP-712 typed data payload
 * @param signature - The signature
 * @returns The recovered signer address
 */
export function recoverSigner(
  typedData: EIP712Message,
  signature: string
): string {
  const hash = hashTypedData(typedData);
  return ethers.recoverAddress(hash, signature);
}

/**
 * Format a message into EIP-712 typed data structure
 * @param domain - Domain separator information
 * @param types - Type definitions
 * @param primaryType - Primary type name
 * @param message - The actual message data
 * @returns Formatted EIP-712 message
 */
export function formatTypedData(
  domain: EIP712Domain,
  types: Record<string, Array<{ name: string; type: string }>>,
  primaryType: string,
  message: Record<string, any>
): EIP712Message {
  return {
    domain,
    types,
    primaryType,
    message,
  };
}
