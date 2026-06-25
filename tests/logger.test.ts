import { getLoggerOptions } from '../src/logger';

describe('getLoggerOptions', () => {
  it('uses pretty transport in development mode', () => {
    const options = getLoggerOptions('development');

    expect(options.transport).toEqual(
      expect.objectContaining({
        target: 'pino-pretty',
      })
    );
  });

  it('does not use transport in production mode', () => {
    const options = getLoggerOptions('production');

    expect(options.transport).toBeUndefined();
  });
});
