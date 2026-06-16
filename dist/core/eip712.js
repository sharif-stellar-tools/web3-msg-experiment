"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.hashTypedData = hashTypedData;
exports.verifySignature = verifySignature;
exports.recoverSigner = recoverSigner;
exports.formatTypedData = formatTypedData;
const ethers_1 = require("ethers");
/**
 * Hash typed data according to EIP-712
 * @param typedData - The EIP-712 typed data payload
 * @returns The hash of the typed data
 */
function hashTypedData(typedData) {
    return ethers_1.ethers.TypedDataEncoder.hash(typedData.domain, typedData.types, typedData.message);
}
/**
 * Verify an EIP-712 signature
 * @param typedData - The EIP-712 typed data payload
 * @param signature - The signature to verify
 * @param expectedSigner - The expected signer address
 * @returns True if signature is valid, false otherwise
 */
function verifySignature(typedData, signature, expectedSigner) {
    try {
        const hash = hashTypedData(typedData);
        const recoveredAddress = ethers_1.ethers.recoverAddress(hash, signature);
        return recoveredAddress.toLowerCase() === expectedSigner.toLowerCase();
    }
    catch (error) {
        return false;
    }
}
/**
 * Recover signer address from EIP-712 signature
 * @param typedData - The EIP-712 typed data payload
 * @param signature - The signature
 * @returns The recovered signer address
 */
function recoverSigner(typedData, signature) {
    const hash = hashTypedData(typedData);
    return ethers_1.ethers.recoverAddress(hash, signature);
}
/**
 * Format a message into EIP-712 typed data structure
 * @param domain - Domain separator information
 * @param types - Type definitions
 * @param primaryType - Primary type name
 * @param message - The actual message data
 * @returns Formatted EIP-712 message
 */
function formatTypedData(domain, types, primaryType, message) {
    return {
        domain,
        types,
        primaryType,
        message,
    };
}
//# sourceMappingURL=eip712.js.map