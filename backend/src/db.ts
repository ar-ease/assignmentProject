import { PrismaClient, type Prisma } from '@prisma/client';

export const prisma = new PrismaClient();

export function withTx<T>(fn: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
  return prisma.$transaction(async (tx) => fn(tx), { maxWait: 10000, timeout: 10000 });
}
