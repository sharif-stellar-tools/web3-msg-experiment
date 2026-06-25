import pino, { Logger, LoggerOptions } from 'pino';

export function getLoggerOptions(env: string = process.env.NODE_ENV ?? 'development'): LoggerOptions {
  const isProduction = env === 'production';

  return {
    level: process.env.LOG_LEVEL ?? 'info',
    timestamp: pino.stdTimeFunctions.isoTime,
    base: undefined,
    formatters: {
      level: (label) => ({ level: label }),
    },
    transport: isProduction
      ? undefined
      : {
          target: 'pino-pretty',
          options: {
            colorize: false,
            translateTime: 'SYS:standard',
          },
        },
  };
}

export function createLogger(name?: string): Logger {
  return pino({
    ...getLoggerOptions(),
    name: name ?? process.env.npm_package_name ?? 'web3-msg-experiment',
  });
}

export const logger = createLogger();

export default logger;
