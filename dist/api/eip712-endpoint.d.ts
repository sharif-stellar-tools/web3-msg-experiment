import { EIP712Message } from '../core/eip712';
export interface EIP712Request {
    typedData: EIP712Message;
    signature: string;
    expectedSigner?: string;
}
export interface EIP712Response {
    success: boolean;
    hash?: string;
    signer?: string;
    valid?: boolean;
    error?: string;
}
/**
 * Validate EIP-712 signature
 */
export declare function validateEIP712Signature(request: EIP712Request): EIP712Response;
/**
 * Express route handler for EIP-712 validation endpoint
 */
export declare function handleEIP712Validation(req: any, res: any): Promise<void>;
//# sourceMappingURL=eip712-endpoint.d.ts.map