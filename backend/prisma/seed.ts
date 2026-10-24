import type { PrismaClient } from '@prisma/client';
import { pathToFileURL } from 'node:url';
import { prisma } from '../src/db.js';

export async function seed(db: PrismaClient = prisma): Promise<void> {
  const products = [
    { name: 'Samosa', pricePaise: 2000, stock: 20 },
    { name: 'Masala Chips', pricePaise: 2500, stock: 15 },
    { name: 'Chai', pricePaise: 1500, stock: 25 },
    { name: 'Veg Puff', pricePaise: 3000, stock: 2 },
    { name: 'Peanut Chikki', pricePaise: 1000, stock: 12 },
  ];
  for (const product of products) {
    await db.product.upsert({ where: { name: product.name }, update: {}, create: product });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  seed().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  }).finally(() => prisma.$disconnect());
}
