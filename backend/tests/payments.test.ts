import { randomUUID } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { expect, test, vi } from 'vitest';
import request from 'supertest';
import { app } from '../src/app.js';
import { prisma } from '../src/db.js';
import { sendWebhook, signPayload } from './webhook-helper.js';

async function place(quantity = 2) {
  const product = await prisma.product.findUniqueOrThrow({ where: { name: 'Veg Puff' } });
  const response = await request(app).post('/orders')
    .send({ items: [{ productId: product.id, quantity }] }).expect(201);
  return response.body as { id: string; totalPaise: number };
}

const capture = (order: { id: string; totalPaise: number }, eventId = `evt_${randomUUID()}`) => ({
  eventId, orderId: order.id, amountPaise: order.totalPaise, status: 'captured',
});

async function availablePuffs() {
  const response = await request(app).get('/products').expect(200);
  for (const product of response.body) expect(product.availableUnits).toBeGreaterThanOrEqual(0);
  return response.body.find((product: { name: string }) => product.name === 'Veg Puff').availableUnits;
}

test('sequential retries record one event and preserve paid_at', async () => {
  const order = await place();
  const payload = capture(order);
  expect((await sendWebhook(payload).expect(200)).body).toEqual({ result: 'paid' });
  const paid = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
  expect(paid.paidAt).toBeInstanceOf(Date);
  expect((await sendWebhook(payload).expect(200)).body).toEqual({ result: 'duplicate' });
  expect(await prisma.webhookEvent.count()).toBe(1);
  expect(await prisma.webhookEvent.findUnique({ where: { eventId: payload.eventId } }))
    .toMatchObject({ orderId: order.id, payload });
  expect((await prisma.order.findUniqueOrThrow({ where: { id: order.id } })).paidAt).toEqual(paid.paidAt);
});

test('five simultaneous retries pay once and record one event', async () => {
  const payload = capture(await place());
  const responses = await Promise.all(Array.from({ length: 5 }, () => sendWebhook(payload).expect(200)));
  expect(responses.map((response) => response.body.result).sort())
    .toEqual(['duplicate', 'duplicate', 'duplicate', 'duplicate', 'paid']);
  expect(await prisma.webhookEvent.count()).toBe(1);
});

test.each(['bad', 'missing', 'short', 'long', 'nonhex', 'tampered'])(
  'rejects %s signatures without recording events or changing orders', async (kind) => {
    const order = await place();
    const raw = JSON.stringify(capture(order));
    const signatures: Record<string, string> = {
      bad: '0'.repeat(64), short: 'a'.repeat(62), long: 'a'.repeat(66),
      nonhex: 'g'.repeat(64), tampered: signPayload(raw),
    };
    const call = request(app).post('/payments/webhook').set('Content-Type', 'application/json');
    if (kind !== 'missing') call.set('X-Signature', signatures[kind]);
    const response = await call.send(kind === 'tampered' ? `${raw} ` : raw).expect(401);
    expect(response.body).toEqual({ error: { code: 'INVALID_SIGNATURE', message: expect.any(String) } });
    expect(await prisma.webhookEvent.count()).toBe(0);
    expect(await prisma.order.findUniqueOrThrow({ where: { id: order.id } }))
      .toMatchObject({ status: 'pending', paidAt: null });
  },
);

test('checks signatures before attempting JSON parsing', async () => {
  await request(app).post('/payments/webhook').set('Content-Type', 'application/json')
    .set('X-Signature', '0'.repeat(64)).send('{').expect(401);
  expect(await prisma.webhookEvent.count()).toBe(0);
});

test('accepts signatures over exact bytes including whitespace and Unicode', async () => {
  const raw = ` { "eventId": "evt_चाय", "orderId": "${randomUUID()}", "amountPaise": 0, "status": "failed" }\n`;
  const response = await request(app).post('/payments/webhook').set('Content-Type', 'application/json')
    .set('X-Signature', signPayload(raw).toUpperCase()).send(raw).expect(200);
  expect(response.body).toEqual({ result: 'ignored', reason: 'unknown_order' });
});

test('signed malformed JSON returns a readable 400 without recording an event', async () => {
  const raw = '{';
  const response = await request(app).post('/payments/webhook').set('Content-Type', 'application/json')
    .set('X-Signature', signPayload(raw)).send(raw).expect(400);
  expect(response.body.error).toEqual({ code: 'VALIDATION_ERROR', message: expect.stringContaining('JSON') });
  expect(await prisma.webhookEvent.count()).toBe(0);
});

test('rejects bodies over 10kb without recording events', async () => {
  const raw = JSON.stringify({ eventId: 'a'.repeat(11 * 1024), orderId: 'x', amountPaise: 0, status: 'captured' });
  await request(app).post('/payments/webhook').set('Content-Type', 'application/json')
    .set('X-Signature', signPayload(raw)).send(raw).expect(413);
  expect(await prisma.webhookEvent.count()).toBe(0);
});

test('rejects compressed bodies instead of changing the bytes before verification', async () => {
  const compressed = gzipSync('{}');
  await request(app).post('/payments/webhook').set('Content-Type', 'application/json')
    .set('Content-Encoding', 'gzip').set('X-Signature', '0'.repeat(64)).send(compressed).expect(415);
  expect(await prisma.webhookEvent.count()).toBe(0);
});

test.each([
  {}, null, { eventId: '', orderId: 'x', amountPaise: 0, status: 'captured' },
  { eventId: 'evt', orderId: 123, amountPaise: 0, status: 'captured' },
  { eventId: 'evt', orderId: 'x', amountPaise: -1, status: 'captured' },
  { eventId: 'evt', orderId: 'x', amountPaise: 1.5, status: 'captured' },
  { eventId: 'evt', orderId: 'x', amountPaise: '2000', status: 'captured' },
  { eventId: 'evt', orderId: 'x', amountPaise: 0, status: 1 },
])('rejects signed invalid schema %j without recording an event', async (payload) => {
  const response = await sendWebhook(payload).expect(400);
  expect(response.body.error).toEqual({ code: 'VALIDATION_ERROR', message: expect.any(String) });
  expect(response.body.error.message.length).toBeGreaterThan(0);
  expect(await prisma.webhookEvent.count()).toBe(0);
});

test('wrong amount flags review and exposes the reason on GET /orders/:id', async () => {
  const order = await place();
  const response = await sendWebhook({ ...capture(order), amountPaise: 1 }).expect(200);
  expect(response.body).toEqual({ result: 'needs_review', reason: 'amount_mismatch' });
  const read = await request(app).get(`/orders/${order.id}`).expect(200);
  expect(read.body).toMatchObject({ status: 'needs_review', reviewReason: 'amount_mismatch' });
  expect((await prisma.order.findUniqueOrThrow({ where: { id: order.id } })).paidAt).toBeNull();
});

test('capture within the hold pays and keeps the units reserved after the deadline', async () => {
  const order = await place();
  expect((await sendWebhook(capture(order)).expect(200)).body).toEqual({ result: 'paid' });
  await prisma.$executeRaw`UPDATE orders SET expires_at = now() - interval '1 second' WHERE id = ${order.id}::uuid`;
  expect(await availablePuffs()).toBe(0);
  const read = await request(app).get(`/orders/${order.id}`).expect(200);
  expect(read.body).toMatchObject({ status: 'paid', reviewReason: null });
});

test.each(['pending', 'expired'])('late payment for %s reclaims free stock', async (status) => {
  const order = await place();
  await prisma.$executeRaw`
    UPDATE orders SET expires_at = now() - interval '1 second', status = ${status}::order_status
    WHERE id = ${order.id}::uuid
  `;
  expect(await availablePuffs()).toBe(2);
  expect((await sendWebhook(capture(order)).expect(200)).body).toEqual({ result: 'paid', late: true });
  expect(await availablePuffs()).toBe(0);
  expect(await prisma.order.findUniqueOrThrow({ where: { id: order.id } }))
    .toMatchObject({ status: 'paid', paidAt: expect.any(Date) });
});

test('late capture cannot reclaim stock held by a newer order', async () => {
  const a = await place();
  await prisma.$executeRaw`UPDATE orders SET expires_at = now() - interval '1 second' WHERE id = ${a.id}::uuid`;
  const b = await place();
  const response = await sendWebhook(capture(a)).expect(200);
  expect(response.body).toEqual({ result: 'needs_review', reason: 'late_payment_stock_unavailable' });
  expect(await availablePuffs()).toBe(0);
  expect((await request(app).get(`/orders/${a.id}`).expect(200)).body)
    .toMatchObject({ status: 'needs_review', reviewReason: 'late_payment_stock_unavailable' });
  expect((await prisma.order.findUniqueOrThrow({ where: { id: b.id } })).status).toBe('pending');
});

test('two late captures competing for the last stock cannot both pay', async () => {
  const a = await place();
  await prisma.$executeRaw`UPDATE orders SET expires_at = now() - interval '1 second' WHERE id = ${a.id}::uuid`;
  const b = await place();
  await prisma.$executeRaw`UPDATE orders SET expires_at = now() - interval '1 second' WHERE id = ${b.id}::uuid`;
  const responses = await Promise.all([sendWebhook(capture(a)).expect(200), sendWebhook(capture(b)).expect(200)]);
  expect(responses.map((response) => response.body.result).sort()).toEqual(['needs_review', 'paid']);
  expect(await availablePuffs()).toBe(0);
});

test('late payment checks every item before reclaiming any stock', async () => {
  const response = await request(app).post('/orders').send({ items: [
    { productId: 1, quantity: 1 }, { productId: 4, quantity: 2 },
  ] }).expect(201);
  const order = response.body as { id: string; totalPaise: number };
  await prisma.$executeRaw`UPDATE orders SET expires_at = now() - interval '1 second' WHERE id = ${order.id}::uuid`;
  await place();
  expect((await sendWebhook(capture(order)).expect(200)).body)
    .toEqual({ result: 'needs_review', reason: 'late_payment_stock_unavailable' });
  const products = await request(app).get('/products').expect(200);
  expect(products.body.find((product: { id: number }) => product.id === 1).availableUnits).toBe(20);
  expect(await availablePuffs()).toBe(0);
});

test.each(['invalid-uuid', ''])('records malformed orderId %j as null and acknowledges it', async (orderId) => {
  const payload = { eventId: 'evt_unknown', orderId, amountPaise: 0, status: 'captured' };
  expect((await sendWebhook(payload).expect(200)).body).toEqual({ result: 'ignored', reason: 'unknown_order' });
  expect(await prisma.webhookEvent.findUnique({ where: { eventId: payload.eventId } }))
    .toMatchObject({ orderId: null, payload });
  expect((await sendWebhook(payload).expect(200)).body).toEqual({ result: 'duplicate' });
});

test('records a valid but unknown order UUID and acknowledges it', async () => {
  const payload = capture({ id: randomUUID(), totalPaise: 0 });
  expect((await sendWebhook(payload).expect(200)).body).toEqual({ result: 'ignored', reason: 'unknown_order' });
  expect(await prisma.webhookEvent.findUnique({ where: { eventId: payload.eventId } }))
    .toMatchObject({ orderId: payload.orderId });
});

test('failed status leaves the order pending even if the amount differs', async () => {
  const order = await place();
  const payload = { ...capture(order), status: 'failed', amountPaise: 1 };
  expect((await sendWebhook(payload).expect(200)).body).toEqual({ result: 'ignored', reason: 'not_captured' });
  expect(await prisma.webhookEvent.count()).toBe(1);
  expect(await prisma.order.findUniqueOrThrow({ where: { id: order.id } }))
    .toMatchObject({ status: 'pending', paidAt: null });
});

test('a distinct second capture leaves a paid order unchanged and warns', async () => {
  const order = await place();
  await sendWebhook(capture(order)).expect(200);
  const paid = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
  const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
  try {
    expect((await sendWebhook({ ...capture(order), amountPaise: 1 }).expect(200)).body)
      .toEqual({ result: 'ignored', reason: 'already_final' });
    expect(warning).toHaveBeenCalled();
  } finally { warning.mockRestore(); }
  expect(await prisma.order.findUniqueOrThrow({ where: { id: order.id } })).toEqual(paid);
  expect(await prisma.webhookEvent.count()).toBe(2);
});

test.each(['picked_up', 'needs_review'] as const)('a capture preserves final status %s', async (status) => {
  const order = await place();
  await prisma.order.update({ where: { id: order.id }, data: { status } });
  expect((await sendWebhook(capture(order)).expect(200)).body).toEqual({ result: 'ignored', reason: 'already_final' });
  expect((await prisma.order.findUniqueOrThrow({ where: { id: order.id } })).status).toBe(status);
});

test('a failed transaction rolls back its event so the same event can retry', async () => {
  const order = await place();
  const payload = capture(order);
  await prisma.$executeRawUnsafe(`ALTER TABLE orders ADD CONSTRAINT test_reject_paid CHECK (status <> 'paid') NOT VALID`);
  const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
  try {
    await sendWebhook(payload).expect(500);
    expect(await prisma.webhookEvent.count()).toBe(0);
    expect((await prisma.order.findUniqueOrThrow({ where: { id: order.id } })).status).toBe('pending');
  } finally {
    errorLog.mockRestore();
    await prisma.$executeRawUnsafe('ALTER TABLE orders DROP CONSTRAINT test_reject_paid');
  }
  expect((await sendWebhook(payload).expect(200)).body).toEqual({ result: 'paid' });
  expect(await prisma.webhookEvent.count()).toBe(1);
});
