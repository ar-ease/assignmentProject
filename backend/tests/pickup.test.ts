import { randomUUID } from 'node:crypto';
import { expect, test, vi } from 'vitest';
import request from 'supertest';
import { app } from '../src/app.js';
import { prisma } from '../src/db.js';
import { sendWebhook } from './webhook-helper.js';

const claim = (id: string) => request(app).post(`/orders/${id}/pickup-claim`);
const place = (items = [{ productId: 1, quantity: 1 }]) =>
  request(app).post('/orders').send({ items }).expect(201);

async function pay(order: { id: string; totalPaise: number }, amountPaise = order.totalPaise) {
  return sendWebhook({ eventId: `evt_${randomUUID()}`, orderId: order.id, amountPaise, status: 'captured' }).expect(200);
}

async function paidOrder(items?: { productId: number; quantity: number }[]) {
  const { body } = await place(items);
  expect((await pay(body)).body.result).toBe('paid');
  return body;
}

async function concurrentClaims(count: number) {
  const order = await paidOrder();
  let claims: Promise<request.Response>[] = [];
  let responses: request.Response[] = [];
  try {
    await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM orders WHERE id = ${order.id}::uuid FOR UPDATE`;
      claims = Array.from({ length: count }, () => claim(order.id).then((response) => response));
      // Hold the row until every claim is waiting, exposing a check-then-act race deterministically.
      await expect.poll(async () => {
        const [row] = await prisma.$queryRaw<{ count: number }[]>`
          SELECT COUNT(*)::int AS count FROM pg_stat_activity
          WHERE datname = current_database() AND wait_event_type = 'Lock'
            AND query LIKE '%UPDATE orders SET status = ''picked_up''%'
        `;
        return row.count;
      }, { timeout: 2000, interval: 10 }).toBe(count);
    });
  } finally {
    responses = await Promise.all(claims);
  }
  expect(responses.filter((response) => response.status === 200)).toHaveLength(1);
  const conflicts = responses.filter((response) => response.status === 409);
  expect(conflicts).toHaveLength(count - 1);
  for (const response of conflicts) expect(response.body.error.code).toBe('ALREADY_CLAIMED');
  expect(await prisma.product.findUniqueOrThrow({ where: { id: 1 } })).toMatchObject({ stock: 19 });
  expect(await prisma.order.findUniqueOrThrow({ where: { id: order.id } }))
    .toMatchObject({ status: 'picked_up', paidAt: expect.any(Date), pickedUpAt: expect.any(Date) });
}

test('two simultaneous pickup claims collect once and reject the loser', async () => {
  await concurrentClaims(2);
});

test('ten simultaneous pickup claims collect once and reject nine losers', async () => {
  await concurrentClaims(10);
});

test.each([
  ['pending', 'ORDER_NOT_PAID'],
  ['expired', 'ORDER_EXPIRED'],
  ['overdue pending', 'ORDER_EXPIRED'],
  ['needs_review', 'ORDER_NEEDS_REVIEW'],
])('rejects %s pickup without changing stock', async (state, code) => {
  const { body: order } = await place();
  if (state === 'needs_review') await pay(order, 1);
  if (state === 'expired' || state === 'overdue pending') {
    await prisma.$executeRaw`
      UPDATE orders SET expires_at = now() - interval '1 second',
        status = ${state === 'expired' ? 'expired' : 'pending'}::order_status
      WHERE id = ${order.id}::uuid
    `;
  }
  const response = await claim(order.id).expect(409);
  expect(response.body.error.code).toBe(code);
  expect(await prisma.product.findUniqueOrThrow({ where: { id: 1 } })).toMatchObject({ stock: 20 });
  expect((await prisma.order.findUniqueOrThrow({ where: { id: order.id } })).pickedUpAt).toBeNull();
});

test('a later pickup retry preserves stock and the original pickup timestamp', async () => {
  const order = await paidOrder();
  const first = await claim(order.id).expect(200);
  const second = await claim(order.id).expect(409);
  expect(second.body.error.code).toBe('ALREADY_CLAIMED');
  expect(await prisma.product.findUniqueOrThrow({ where: { id: 1 } })).toMatchObject({ stock: 19 });
  expect((await prisma.order.findUniqueOrThrow({ where: { id: order.id } })).pickedUpAt?.toISOString())
    .toBe(first.body.pickedUpAt);
});

test('pickup rejects an unknown order UUID', async () => {
  expect((await claim(randomUUID()).expect(404)).body.error.code).toBe('ORDER_NOT_FOUND');
});

test('pickup rejects an invalid UUID', async () => {
  expect((await claim('not-a-uuid').expect(400)).body.error.code).toBe('VALIDATION_ERROR');
});

test('pickup preserves availability while decrementing every item exactly once', async () => {
  const order = await paidOrder([{ productId: 4, quantity: 1 }, { productId: 1, quantity: 2 }]);
  const before = (await request(app).get('/products').expect(200)).body;
  const response = await claim(order.id).expect(200);
  expect(response.body).toEqual({
    id: order.id, status: 'picked_up', pickedUpAt: expect.any(String),
    items: [
      { productId: 1, name: 'Samosa', quantity: 2, unitPricePaise: 2000 },
      { productId: 4, name: 'Veg Puff', quantity: 1, unitPricePaise: 3000 },
    ],
  });
  expect(Number.isNaN(Date.parse(response.body.pickedUpAt))).toBe(false);
  const after = (await request(app).get('/products').expect(200)).body;
  expect(after.map((product: { availableUnits: number }) => product.availableUnits))
    .toEqual(before.map((product: { availableUnits: number }) => product.availableUnits));
  expect(await prisma.product.findUniqueOrThrow({ where: { id: 1 } })).toMatchObject({ stock: 18 });
  expect(await prisma.product.findUniqueOrThrow({ where: { id: 4 } })).toMatchObject({ stock: 1 });
  expect((await request(app).get(`/orders/${order.id}`).expect(200)).body.status).toBe('picked_up');
});

test('concurrent pickups and a new multi-item order complete without deadlock', async () => {
  const a = await paidOrder([{ productId: 2, quantity: 1 }, { productId: 1, quantity: 1 }]);
  const b = await paidOrder([{ productId: 1, quantity: 1 }, { productId: 2, quantity: 1 }]);
  await Promise.all([
    claim(a.id).expect(200), claim(b.id).expect(200),
    place([{ productId: 2, quantity: 2 }, { productId: 1, quantity: 2 }]),
  ]);
  const products = (await request(app).get('/products').expect(200)).body;
  expect(products.find((product: { id: number }) => product.id === 1)).toMatchObject({ stock: 18, availableUnits: 16 });
  expect(products.find((product: { id: number }) => product.id === 2)).toMatchObject({ stock: 13, availableUnits: 11 });
});

test('the stock CHECK rolls back the pickup transition and earlier item decrements', async () => {
  const order = await paidOrder([{ productId: 1, quantity: 1 }, { productId: 4, quantity: 1 }]);
  await prisma.product.update({ where: { id: 4 }, data: { stock: 0 } });
  const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
  try {
    await claim(order.id).expect(500);
  } finally {
    errorLog.mockRestore();
  }
  expect(await prisma.order.findUniqueOrThrow({ where: { id: order.id } }))
    .toMatchObject({ status: 'paid', pickedUpAt: null });
  expect(await prisma.product.findUniqueOrThrow({ where: { id: 1 } })).toMatchObject({ stock: 20 });
  expect(await prisma.product.findUniqueOrThrow({ where: { id: 4 } })).toMatchObject({ stock: 0 });
});
