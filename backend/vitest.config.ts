import { defineConfig } from 'vitest/config';

const testUrl = process.env.TEST_DATABASE_URL ?? 'postgresql://pickup:pickup@localhost:5432/pickup_test?connection_limit=20';
// Set this during config loading, before setup or tests can import Prisma.
if (new URL(testUrl).pathname !== '/pickup_test') {
  throw new Error('Tests require the pickup_test database; tables will be truncated.');
}
process.env.DATABASE_URL = testUrl;

export default defineConfig({
  test: {
    env: { DATABASE_URL: testUrl, WEBHOOK_SECRET: process.env.WEBHOOK_SECRET ?? 'local-development-webhook-secret' },
    globalSetup: ['./tests/global-setup.ts'],
    setupFiles: ['./tests/setup.ts'],
    fileParallelism: false,
  },
});
