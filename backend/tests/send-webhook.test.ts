import { execFile } from 'node:child_process';
import { once } from 'node:events';
import { promisify } from 'node:util';
import { afterAll, beforeAll, expect, test } from 'vitest';
import request from 'supertest';
import { app } from '../src/app.js';
import { prisma } from '../src/db.js';

const exec = promisify(execFile);
let server: ReturnType<typeof app.listen>;
let apiUrl: string;

beforeAll(async () => {
  server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Expected a TCP server');
  apiUrl = `http://127.0.0.1:${address.port}`;
});
afterAll(() => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));

function run(...args: string[]) {
  return exec('npm', ['run', 'send-webhook', '--', ...args], {
    env: { ...process.env, API_URL: apiUrl }, timeout: 10000,
  });
}

async function place() {
  const response = await request(app).post('/orders').send({ items: [{ productId: 1, quantity: 1 }] }).expect(201);
  return response.body.id as string;
}

test('CLI fetches the total, prints a generated event ID, and can resend it', async () => {
  const id = await place();
  const { stdout } = await run(id);
  expect(stdout).toContain('HTTP 200');
  expect(stdout).toContain('"result":"paid"');
  const eventId = stdout.match(/eventId: (evt_\S+)/)?.[1];
  expect(eventId).toBeTruthy();
  const duplicate = await run(id, '--event', eventId!);
  expect(duplicate.stdout).toContain('"result":"duplicate"');
  expect(await prisma.webhookEvent.count()).toBe(1);
});

test('CLI supports explicit amount, event and status without fetching an unknown order', async () => {
  const { stdout } = await run('unknown', '--amount', '0', '--event', 'evt_cli', '--status', 'failed');
  expect(stdout).toContain('eventId: evt_cli');
  expect(stdout).toContain('HTTP 200');
  expect(stdout).toContain('"reason":"unknown_order"');
  expect(await prisma.webhookEvent.findUnique({ where: { eventId: 'evt_cli' } }))
    .toMatchObject({ orderId: null, payload: { amountPaise: 0, status: 'failed' } });
});

test('CLI bad signature prints the 401 and leaves the database unchanged', async () => {
  const id = await place();
  await expect(run(id, '--bad-signature')).rejects.toMatchObject({
    stdout: expect.stringContaining('HTTP 401'), code: 1,
  });
  expect(await prisma.webhookEvent.count()).toBe(0);
  expect((await prisma.order.findUniqueOrThrow({ where: { id } })).status).toBe('pending');
});

test.each([[], ['x', '--amount', '-1'], ['x', '--amount', '1.5'], ['x', '--amount', ''], ['x', '--unknown']].map((args) => ({ args })))(
  'CLI rejects invalid arguments $args before sending anything', async ({ args }) => {
    await expect(run(...args)).rejects.toMatchObject({ code: 1, stderr: expect.any(String) });
    expect(await prisma.webhookEvent.count()).toBe(0);
  },
);
