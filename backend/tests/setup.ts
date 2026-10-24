import { afterAll, beforeEach } from 'vitest';
import { prisma } from '../src/db.js';
import { seed } from '../prisma/seed.js';

export async function resetDatabase() {
  await prisma.$executeRaw`TRUNCATE TABLE order_items, webhook_events, orders, products RESTART IDENTITY CASCADE`;
  await seed(prisma);
}

beforeEach(resetDatabase);
afterAll(() => prisma.$disconnect());
