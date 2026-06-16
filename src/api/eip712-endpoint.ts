import {
  hashTypedData,
  verifySignature,
  recoverSigner,
  EIP712Message,
} from '../core/eip712';

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
export function validateEIP712Signature(
  request: EIP712Request
): EIP712Response {
  try {
    const hash = hashTypedData(request.typedData);

    if (request.expectedSigner) {
      const valid = verifySignature(
        request.typedData,
        request.signature,
        request.expectedSigner
      );
      return {
        success: true,
        hash,
        valid,
      };
    }

    const signer = recoverSigner(request.typedData, request.signature);
    return {
      success: true,
      hash,
      signer,
      valid: true,
    };
  } catch (error) {
    return {
      success: false,
      error:
        error instanceof Error
          ? error.message
          : 'Failed to validate EIP-712 signature',
    };
  }
}

/**
 * Express route handler for EIP-712 validation endpoint
 */
export async function handleEIP712Validation(
  req: any,
  res: any
): Promise<void> {
  try {
    const request: EIP712Request = req.body;

    if (!request.typedData || !request.signature) {
      res.status(400).json({
        success: false,
        error: 'Missing typedData or signature in request',
      });
      return;
    }

    const response = validateEIP712Signature(request);
    res.status(response.success ? 200 : 400).json(response);
  } catch (error) {
    res.status(500).json({
      success: false,
      error:
        error instanceof Error ? error.message : 'Internal server error',
    });
  }
}
