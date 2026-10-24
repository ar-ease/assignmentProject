import { expect, test } from 'vitest';
import request from 'supertest';
import { app } from '../src/app.js';
import { prisma } from '../src/db.js';
import { sendWebhook } from './webhook-helper.js';

test('inventory and webhook invariants across 60 operations in three waves, seed 20261024', async () => {
  let state = 20261024;
  const random = () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
  const pick = <T,>(values: T[]): T => values[Math.floor(random() * values.length)];
  const initial = await prisma.product.findMany({ orderBy: { id: 'asc' } });
  const puff = initial.find((product) => product.name === 'Veg Puff')!;
  type Order = { id: string; totalPaise: number };
  type Event = { eventId: string; orderId: string; amountPaise: number; status: string };
  const orders: Order[] = [];
  const events: Event[] = [];
  const outcomes: string[] = [];
  let expirations = 0;
  let duplicates = 0;
  let sequence = 0;
  const successfulClaims = new Map<string, number>();
  let pickupConflicts = 0;

  function place() {
    const product = random() < 0.65 ? puff : pick(initial);
    const quantity = 1 + Math.floor(random() * 3);
    return async () => {
      const response = await request(app).post('/orders').send({ items: [{ productId: product.id, quantity }] });
      expect([201, 409]).toContain(response.status);
      if (response.status === 409) {
        expect(response.body.error.code).toBe('INSUFFICIENT_STOCK');
        return null;
      }
      return response.body as Order;
    };
  }

  for (let wave = 0; wave < 3; wave++) {
    const [pickupOrder] = wave === 2
      ? await prisma.order.findMany({ where: { status: 'paid' }, orderBy: { id: 'asc' }, take: 1 })
      : [];
    if (wave === 2) expect(pickupOrder).toBeDefined();
    // Choose all operations before starting requests so scheduling cannot change the PRNG sequence.
    const sent = [...events];
    const operations = Array.from({ length: 20 }, (_, index) => {
      if (wave === 2 && index < 4) {
        return async () => {
          const response = await request(app).post(`/orders/${pickupOrder.id}/pickup-claim`);
          expect([200, 409]).toContain(response.status);
          if (response.status === 200) {
            successfulClaims.set(pickupOrder.id, (successfulClaims.get(pickupOrder.id) ?? 0) + 1);
          } else {
            expect(response.body.error.code).toBe('ALREADY_CLAIMED');
            pickupConflicts++;
          }
          return null;
        };
      }
      const kind = wave === 0 ? 0 : index % (wave === 1 ? 4 : 5);
      if (kind === 0) return place();
      if (kind === 4) {
        const event = pick(sent);
        return async () => {
          expect((await sendWebhook(event).expect(200)).body.result).toBe('duplicate');
          duplicates++;
          return null;
        };
      }
      const order = pick(orders);
      if (kind === 3) {
        return async () => {
          expirations += await prisma.$executeRaw`
            UPDATE orders SET expires_at = clock_timestamp() - interval '1 second'
            WHERE id = ${order.id}::uuid AND status = 'pending'
          `;
          return null;
        };
      }
      const event = {
        eventId: `evt_stress_${sequence++}`, orderId: order.id,
        amountPaise: order.totalPaise + (kind === 2 ? 1 : 0), status: 'captured',
      };
      events.push(event);
      return async () => {
        const response = await sendWebhook(event).expect(200);
        expect(['paid', 'needs_review', 'ignored']).toContain(response.body.result);
        outcomes.push(response.body.result);
        return null;
      };
    });
    for (let index = operations.length - 1; index > 0; index--) {
      const other = Math.floor(random() * (index + 1));
      [operations[index], operations[other]] = [operations[other], operations[index]];
    }
    const created = await Promise.all(operations.map((operation) => operation()));
    orders.push(...created.filter((order): order is Order => order !== null));

    // Independent SQL oracle, rather than reusing the production reservation fragment.
    const inventory = await prisma.$queryRaw<{ id: number; stock: number; reserved: number; picked: number }[]>`
      SELECT p.id, p.stock,
        COALESCE(SUM(oi.quantity) FILTER (WHERE o.status = 'paid' OR
          (o.status = 'pending' AND o.expires_at > now())), 0)::int AS reserved,
        COALESCE(SUM(oi.quantity) FILTER (WHERE o.status = 'picked_up'), 0)::int AS picked
      FROM products p
      LEFT JOIN order_items oi ON oi.product_id = p.id
      LEFT JOIN orders o ON o.id = oi.order_id
      GROUP BY p.id ORDER BY p.id
    `;
    expect(inventory).toHaveLength(initial.length);
    for (const product of inventory) {
      expect(product.stock, `wave ${wave}, product ${product.id}`).toBeGreaterThanOrEqual(0);
      expect(product.stock - product.reserved, `wave ${wave}, product ${product.id}`).toBeGreaterThanOrEqual(0);
      expect(product.stock + product.picked).toBe(initial.find((item) => item.id === product.id)!.stock);
    }
    const recorded = await prisma.webhookEvent.findMany({ select: { eventId: true } });
    expect(recorded.map((event) => event.eventId).sort()).toEqual([...new Set(events.map((event) => event.eventId))].sort());
    expect(await prisma.order.count({ where: {
      status: 'picked_up', OR: [{ paidAt: null }, { pickedUpAt: null }],
    } })).toBe(0);
    for (const count of successfulClaims.values()) expect(count).toBeLessThanOrEqual(1);
    for (const order of await prisma.order.findMany({ where: { status: 'picked_up' } })) {
      expect(successfulClaims.get(order.id)).toBe(1);
    }
  }
  expect(outcomes).toContain('paid');
  expect(outcomes).toContain('needs_review');
  expect(expirations).toBeGreaterThan(0);
  expect(duplicates).toBe(4);
  expect(successfulClaims.size).toBe(1);
  expect(pickupConflicts).toBe(3);
});
