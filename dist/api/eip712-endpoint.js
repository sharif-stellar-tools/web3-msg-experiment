"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.validateEIP712Signature = validateEIP712Signature;
exports.handleEIP712Validation = handleEIP712Validation;
const eip712_1 = require("../core/eip712");
/**
 * Validate EIP-712 signature
 */
function validateEIP712Signature(request) {
    try {
        const hash = (0, eip712_1.hashTypedData)(request.typedData);
        if (request.expectedSigner) {
            const valid = (0, eip712_1.verifySignature)(request.typedData, request.signature, request.expectedSigner);
            return {
                success: true,
                hash,
                valid,
            };
        }
        const signer = (0, eip712_1.recoverSigner)(request.typedData, request.signature);
        return {
            success: true,
            hash,
            signer,
            valid: true,
        };
    }
    catch (error) {
        return {
            success: false,
            error: error instanceof Error
                ? error.message
                : 'Failed to validate EIP-712 signature',
        };
    }
}
/**
 * Express route handler for EIP-712 validation endpoint
 */
async function handleEIP712Validation(req, res) {
    try {
        const request = req.body;
        if (!request.typedData || !request.signature) {
            res.status(400).json({
                success: false,
                error: 'Missing typedData or signature in request',
            });
            return;
        }
        const response = validateEIP712Signature(request);
        res.status(response.success ? 200 : 400).json(response);
    }
    catch (error) {
        res.status(500).json({
            success: false,
            error: error instanceof Error ? error.message : 'Internal server error',
        });
    }
}
//# sourceMappingURL=eip712-endpoint.js.map