import { expect, test } from 'vitest';
import request from 'supertest';
import { app } from '../src/app.js';
import { prisma } from '../src/db.js';

async function productId(name: string): Promise<number> {
  return (await prisma.product.findUniqueOrThrow({ where: { name } })).id;
}

const place = (items: { productId: number; quantity: number }[]) => request(app).post('/orders').send({ items });

function expectError(body: unknown, code: string) {
  expect(body).toEqual({ error: { code, message: expect.any(String) } });
}

test('ten concurrent requests reserve exactly two Veg Puffs without overselling', async () => {
  const id = await productId('Veg Puff');
  const responses = await Promise.all(Array.from({ length: 10 }, () => place([{ productId: id, quantity: 1 }])));
  expect(responses.filter((response) => response.status === 201)).toHaveLength(2);
  const conflicts = responses.filter((response) => response.status === 409);
  expect(conflicts).toHaveLength(8);
  for (const response of conflicts) expectError(response.body, 'INSUFFICIENT_STOCK');
  const products = await request(app).get('/products').expect(200);
  expect(products.body.find((product: { id: number }) => product.id === id).availableUnits).toBe(0);
  expect((await prisma.orderItem.aggregate({ where: { productId: id }, _sum: { quantity: true } }))._sum.quantity).toBe(2);
  expect(await prisma.order.count()).toBe(2);
});

test('a shortage in one item rolls back the entire multi-item order', async () => {
  const samosa = await productId('Samosa');
  const puff = await productId('Veg Puff');
  const response = await place([{ productId: samosa, quantity: 1 }, { productId: puff, quantity: 3 }]).expect(409);
  expectError(response.body, 'INSUFFICIENT_STOCK');
  expect(response.body.error.message).toContain('Veg Puff');
  expect(response.body.error.message).toContain('2');
  expect(await prisma.order.count()).toBe(0);
  expect(await prisma.orderItem.count()).toBe(0);
  const products = await request(app).get('/products').expect(200);
  for (const product of products.body) expect(product.availableUnits).toBe(product.stock);
});

test('snapshots integer prices, computes totals, and returns a database countdown', async () => {
  const samosa = await productId('Samosa');
  const chai = await productId('Chai');
  const response = await place([{ productId: chai, quantity: 3 }, { productId: samosa, quantity: 2 }]).expect(201);
  const { HOLD_SECONDS } = await import('../src/config.js');
  expect(response.body).toMatchObject({
    id: expect.any(String), status: 'pending', totalPaise: 8500, expiresAt: expect.any(String),
    items: [
      { productId: samosa, name: 'Samosa', quantity: 2, unitPricePaise: 2000 },
      { productId: chai, name: 'Chai', quantity: 3, unitPricePaise: 1500 },
    ],
  });
  expect(Number.isInteger(response.body.totalPaise)).toBe(true);
  expect(response.body.expiresInSeconds).toBeGreaterThanOrEqual(HOLD_SECONDS - 2);
  expect(response.body.expiresInSeconds).toBeLessThanOrEqual(HOLD_SECONDS);
  await prisma.product.update({ where: { id: samosa }, data: { pricePaise: 9999 } });
  const read = await request(app).get(`/orders/${response.body.id}`).expect(200);
  expect(read.body.items).toEqual(response.body.items);
  expect(read.body.totalPaise).toBe(8500);
  expect(read.body.expiresInSeconds).toBeGreaterThanOrEqual(HOLD_SECONDS - 2);
  expect(read.body.expiresInSeconds).toBeLessThanOrEqual(HOLD_SECONDS);
});

test('expired holds release stock before lazy expiry or the sweeper runs', async () => {
  const id = await productId('Veg Puff');
  const first = await place([{ productId: id, quantity: 1 }]).expect(201);
  const second = await place([{ productId: id, quantity: 1 }]).expect(201);
  await prisma.$executeRaw`UPDATE orders SET expires_at = now() - interval '1 second'`;
  const products = await request(app).get('/products').expect(200);
  expect(products.body.find((product: { id: number }) => product.id === id).availableUnits).toBe(2);
  expect(await prisma.order.count({ where: { status: 'pending' } })).toBe(2);
  const read = await request(app).get(`/orders/${first.body.id}`).expect(200);
  expect(read.body.status).toBe('expired');
  expect(read.body.expiresInSeconds).toBe(0);
  expect((await prisma.order.findUniqueOrThrow({ where: { id: first.body.id } })).status).toBe('expired');
  const { expirePendingOrders } = await import('../src/orders.js');
  expect(await expirePendingOrders()).toBe(1);
  expect((await prisma.order.findUniqueOrThrow({ where: { id: second.body.id } })).status).toBe('expired');
  expect(await expirePendingOrders()).toBe(0);
  await place([{ productId: id, quantity: 2 }]).expect(201);
  expect(await expirePendingOrders()).toBe(0);
});

test('paid orders stay reserved and never expire, with a zero countdown', async () => {
  const id = await productId('Veg Puff');
  const created = await place([{ productId: id, quantity: 2 }]).expect(201);
  await prisma.$executeRaw`UPDATE orders SET status = 'paid', expires_at = now() - interval '1 second'`;
  const read = await request(app).get(`/orders/${created.body.id}`).expect(200);
  expect(read.body.status).toBe('paid');
  expect(read.body.expiresInSeconds).toBe(0);
  const { expirePendingOrders } = await import('../src/orders.js');
  expect(await expirePendingOrders()).toBe(0);
  const blocked = await place([{ productId: id, quantity: 1 }]).expect(409);
  expectError(blocked.body, 'INSUFFICIENT_STOCK');
});

test.each([
  {}, { items: [] }, { items: [{ productId: 1, quantity: 0 }] },
  { items: [{ productId: 1, quantity: 21 }] }, { items: [{ productId: 1, quantity: 1.5 }] },
  { items: [{ productId: 0, quantity: 1 }] }, { items: [{ productId: 1.5, quantity: 1 }] },
  { items: [{ productId: 1, quantity: '1' }] },
])('rejects invalid order body %j', async (body) => {
  const response = await request(app).post('/orders').send(body).expect(400);
  expectError(response.body, 'VALIDATION_ERROR');
  expect(await prisma.order.count()).toBe(0);
  expect(await prisma.orderItem.count()).toBe(0);
});

test('rejects malformed JSON with the error envelope', async () => {
  const response = await request(app).post('/orders').set('Content-Type', 'application/json').send('{').expect(400);
  expectError(response.body, 'VALIDATION_ERROR');
});

test('rejects unknown products without creating partial records', async () => {
  const response = await place([{ productId: await productId('Samosa'), quantity: 1 }, { productId: 999999, quantity: 1 }]).expect(404);
  expectError(response.body, 'PRODUCT_NOT_FOUND');
  expect(await prisma.order.count()).toBe(0);
  expect(await prisma.orderItem.count()).toBe(0);
});

test('validates order UUIDs and reports missing orders', async () => {
  const invalid = await request(app).get('/orders/not-a-uuid').expect(400);
  expectError(invalid.body, 'VALIDATION_ERROR');
  const missing = await request(app).get('/orders/9e14f6c3-9e6b-4f23-9adf-31bfc8a6db7f').expect(404);
  expectError(missing.body, 'ORDER_NOT_FOUND');
});

test('merges duplicate product IDs into one order item', async () => {
  const id = await productId('Samosa');
  const response = await place([{ productId: id, quantity: 2 }, { productId: id, quantity: 3 }]).expect(201);
  expect(response.body.items).toEqual([{ productId: id, name: 'Samosa', quantity: 5, unitPricePaise: 2000 }]);
  expect(response.body.totalPaise).toBe(10000);
  expect(await prisma.orderItem.count()).toBe(1);
});

test('rejects duplicate quantities whose merged total exceeds twenty', async () => {
  const id = await productId('Samosa');
  const response = await place([{ productId: id, quantity: 11 }, { productId: id, quantity: 10 }]).expect(400);
  expectError(response.body, 'VALIDATION_ERROR');
  expect(await prisma.order.count()).toBe(0);
  expect(await prisma.orderItem.count()).toBe(0);
});

test('rejects totals beyond the database integer limit without partial records', async () => {
  const id = await productId('Samosa');
  await prisma.product.update({ where: { id }, data: { pricePaise: 2_147_483_647 } });
  const response = await place([{ productId: id, quantity: 2 }]).expect(400);
  expectError(response.body, 'VALIDATION_ERROR');
  expect(await prisma.order.count()).toBe(0);
  expect(await prisma.orderItem.count()).toBe(0);
});
