#!/usr/bin/env node

import {
  hashTypedData,
  verifySignature,
  recoverSigner,
  EIP712Message,
} from '../core/eip712';
import logger from '../logger';

/**
 * CLI command for EIP-712 operations
 * Usage:
 *   eip712 hash <typedDataJson>
 *   eip712 verify <typedDataJson> <signature> <expectedSigner>
 *   eip712 recover <typedDataJson> <signature>
 */

function printHelp(): void {
  logger.info(`
EIP-712 CLI Tool

Usage:
  eip712 hash <typedData.json>
    Hash a typed data payload
    
  eip712 verify <typedData.json> <signature> <expectedSigner>
    Verify a signature against an expected signer
    
  eip712 recover <typedData.json> <signature>
    Recover the signer address from a signature

Examples:
  eip712 hash ./message.json
  eip712 verify ./message.json 0x... 0x...
  eip712 recover ./message.json 0x...
  `);
}

function loadTypedData(filePath: string): EIP712Message {
  try {
    const fs = require('fs');
    const content = fs.readFileSync(filePath, 'utf-8');
    return JSON.parse(content);
  } catch (error) {
    throw new Error(
      `Failed to load typed data from ${filePath}: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

function executeHash(typedDataPath: string): void {
  try {
    const typedData = loadTypedData(typedDataPath);
    const hash = hashTypedData(typedData);
    logger.info({ hash }, 'Computed hash');
  } catch (error) {
    logger.error({ err: error }, 'Failed to compute hash');
    process.exit(1);
  }
}

function executeVerify(
  typedDataPath: string,
  signature: string,
  expectedSigner: string
): void {
  try {
    const typedData = loadTypedData(typedDataPath);
    const isValid = verifySignature(typedData, signature, expectedSigner);
    logger.info({ valid: isValid }, 'Signature verification result');
  } catch (error) {
    logger.error({ err: error }, 'Failed to verify signature');
    process.exit(1);
  }
}

function executeRecover(typedDataPath: string, signature: string): void {
  try {
    const typedData = loadTypedData(typedDataPath);
    const signer = recoverSigner(typedData, signature);
    logger.info({ signer }, 'Recovered signer');
  } catch (error) {
    logger.error({ err: error }, 'Failed to recover signer');
    process.exit(1);
  }
}

function main(): void {
  const args = process.argv.slice(2);

  if (args.length === 0) {
    printHelp();
    process.exit(0);
  }

  const command = args[0];

  switch (command) {
    case 'hash':
      if (args.length < 2) {
        logger.error('hash command requires <typedData.json>');
        process.exit(1);
      }
      executeHash(args[1]);
      break;

    case 'verify':
      if (args.length < 4) {
        logger.error(
          'verify command requires <typedData.json> <signature> <expectedSigner>'
        );
        process.exit(1);
      }
      executeVerify(args[1], args[2], args[3]);
      break;

    case 'recover':
      if (args.length < 3) {
        logger.error('recover command requires <typedData.json> <signature>');
        process.exit(1);
      }
      executeRecover(args[1], args[2]);
      break;

    case '--help':
    case '-h':
      printHelp();
      break;

    default:
      logger.error({ command }, 'Unknown command');
      printHelp();
      process.exit(1);
  }
}

main();
