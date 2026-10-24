import { expect, test } from 'vitest';
import request from 'supertest';
import { app } from '../src/app.js';

test('lists five seeded products with all stock available when no orders exist', async () => {
  const response = await request(app).get('/products').expect(200);
  expect(response.body).toHaveLength(5);
  for (const product of response.body) {
    expect(product.availableUnits).toBe(product.stock);
    expect(Number.isInteger(product.pricePaise)).toBe(true);
  }
  expect(response.body).toContainEqual({
    id: expect.any(Number), name: 'Samosa', pricePaise: 2000, stock: 20, availableUnits: 20,
  });
});

// Fixtures exercise the availability query without adding order endpoints.
test('reserves active pending and paid items, ignoring expired and collected orders', async () => {
  const { prisma } = await import('../src/db.js');
  await prisma.$executeRaw`
    INSERT INTO orders (id, status, total_paise, expires_at)
    VALUES
      ('00000000-0000-0000-0000-000000000001', 'pending', 2000, now() + interval '1 hour'),
      ('00000000-0000-0000-0000-000000000002', 'paid', 4000, now() - interval '1 hour'),
      ('00000000-0000-0000-0000-000000000003', 'pending', 6000, now() - interval '1 hour'),
      ('00000000-0000-0000-0000-000000000004', 'expired', 8000, now() + interval '1 hour'),
      ('00000000-0000-0000-0000-000000000005', 'picked_up', 10000, now() + interval '1 hour'),
      ('00000000-0000-0000-0000-000000000006', 'needs_review', 12000, now() + interval '1 hour')
  `;
  await prisma.$executeRaw`
    INSERT INTO order_items (order_id, product_id, quantity, unit_price_paise)
    SELECT o.id, p.id, row_number() OVER (ORDER BY o.id)::int, p.price_paise
    FROM orders o CROSS JOIN products p WHERE p.name = 'Samosa'
  `;
  const response = await request(app).get('/products').expect(200);
  expect(response.body.find((product: { name: string }) => product.name === 'Samosa'))
    .toMatchObject({ stock: 20, availableUnits: 17 });
  expect(response.body.find((product: { name: string }) => product.name === 'Veg Puff'))
    .toMatchObject({ stock: 2, availableUnits: 2 });
});

test('seed is idempotent and preserves current stock', async () => {
  const { prisma } = await import('../src/db.js');
  const { seed } = await import('../prisma/seed.js');
  await prisma.product.update({ where: { name: 'Samosa' }, data: { stock: 7 } });
  await seed();
  expect(await prisma.product.count()).toBe(5);
  expect(await prisma.product.findUnique({ where: { name: 'Samosa' } })).toMatchObject({ stock: 7 });
});
