import express, { Express } from 'express';
import { handleEIP712Validation } from './eip712-endpoint';

export function createApp(): Express {
  const app = express();

  app.use(express.json());

  app.post('/api/eip712/validate', handleEIP712Validation);

  return app;
}
