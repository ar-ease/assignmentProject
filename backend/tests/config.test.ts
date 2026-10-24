import { afterEach, expect, test, vi } from 'vitest';

afterEach(() => { vi.unstubAllEnvs(); vi.resetModules(); });

test.each([undefined, '', '   '])('rejects missing or empty WEBHOOK_SECRET %j at startup', async (value) => {
  vi.stubEnv('WEBHOOK_SECRET', value);
  vi.resetModules();
  await expect(import('../src/config.js')).rejects.toThrow();
});

test('defaults HOLD_SECONDS and accepts a configured positive integer', async () => {
  vi.stubEnv('HOLD_SECONDS', undefined);
  vi.resetModules();
  expect((await import('../src/config.js')).HOLD_SECONDS).toBe(120);
  vi.stubEnv('HOLD_SECONDS', '45');
  vi.resetModules();
  expect((await import('../src/config.js')).HOLD_SECONDS).toBe(45);
});

test.each(['0', '-1', '1.5', 'abc', '', 'Infinity', '2147483648'])(
  'rejects invalid HOLD_SECONDS %j', async (value) => {
    vi.stubEnv('HOLD_SECONDS', value);
    vi.resetModules();
    await expect(import('../src/config.js')).rejects.toThrow();
  },
);
