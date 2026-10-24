import { randomUUID } from 'node:crypto';
import type { OrderStatus, Product, Prisma } from '@prisma/client';
import { HOLD_SECONDS } from './config.js';
import { prisma, withTx } from './db.js';
import { AppError } from './errors.js';
import { reservedUnitsSql } from './reservations.js';

type OrderItemInput = { productId: number; quantity: number };
type OrderView = {
  id: string;
  status: OrderStatus;
  totalPaise: number;
  reviewReason: string | null;
  items: { productId: number; name: string; quantity: number; unitPricePaise: number }[];
  expiresAt: Date;
  expiresInSeconds: number;
};

export async function createOrder(items: OrderItemInput[]): Promise<OrderView> {
  const id = randomUUID();
  const ids = items.map((item) => item.productId);
  const quantities = new Map(items.map((item) => [item.productId, item.quantity]));

  await withTx(async (tx) => {
    const products = await tx.$queryRaw<Product[]>`
      SELECT id, name, price_paise AS "pricePaise", stock
      FROM products WHERE id = ANY(${ids}::bigint[]) ORDER BY id FOR UPDATE
    `;
    if (products.length !== ids.length) {
      throw new AppError(404, 'PRODUCT_NOT_FOUND', 'One or more requested products do not exist');
    }

    // Under READ COMMITTED this separate statement sees orders committed by the previous lock holder.
    const reservations = await tx.$queryRaw<{ id: number; reserved: number }[]>`
      SELECT p.id, ${reservedUnitsSql} AS reserved
      FROM products p
      LEFT JOIN order_items oi ON oi.product_id = p.id
      LEFT JOIN orders o ON o.id = oi.order_id
      WHERE p.id = ANY(${ids}::bigint[])
      GROUP BY p.id
    `;
    const reserved = new Map(reservations.map((row) => [row.id, row.reserved]));
    const shortages = products.filter((product) => product.stock - reserved.get(product.id)! < quantities.get(product.id)!);
    if (shortages.length) {
      throw new AppError(409, 'INSUFFICIENT_STOCK', shortages.map((product) =>
        `${product.name}: ${product.stock - reserved.get(product.id)!} units available`
      ).join('; '));
    }

    const totalPaise = products.reduce((total, product) => total + product.pricePaise * quantities.get(product.id)!, 0);
    if (!Number.isSafeInteger(totalPaise) || totalPaise > 2_147_483_647) {
      throw new AppError(400, 'VALIDATION_ERROR', 'Order total exceeds the supported integer paise limit');
    }
    await tx.$executeRaw`
      INSERT INTO orders (id, total_paise, expires_at)
      VALUES (${id}::uuid, ${totalPaise}, now() + make_interval(secs => ${HOLD_SECONDS}::int))
    `;
    await tx.orderItem.createMany({ data: products.map((product) => ({
      orderId: id, productId: product.id, quantity: quantities.get(product.id)!, unitPricePaise: product.pricePaise,
    })) });
  });

  // Read after commit so the countdown uses a fresh database clock immediately before the response.
  return readOrder(id);
}

async function readOrder(id: string, db: Prisma.TransactionClient = prisma): Promise<OrderView> {
  const [order] = await db.$queryRaw<OrderView[]>`
    SELECT o.id, o.status, o.total_paise AS "totalPaise", o.review_reason AS "reviewReason", o.expires_at AS "expiresAt",
      CASE WHEN o.status = 'pending' THEN
        GREATEST(0, CEIL(EXTRACT(EPOCH FROM (o.expires_at - now()))))::int
      ELSE 0 END AS "expiresInSeconds",
      COALESCE(json_agg(json_build_object(
        'productId', oi.product_id, 'name', p.name,
        'quantity', oi.quantity, 'unitPricePaise', oi.unit_price_paise
      ) ORDER BY oi.product_id) FILTER (WHERE oi.order_id IS NOT NULL), '[]'::json) AS items
    FROM orders o
    LEFT JOIN order_items oi ON oi.order_id = o.id
    LEFT JOIN products p ON p.id = oi.product_id
    WHERE o.id = ${id}::uuid
    GROUP BY o.id
  `;
  if (!order) throw new AppError(404, 'ORDER_NOT_FOUND', 'Order not found');
  return order;
}

export async function getOrder(id: string): Promise<OrderView> {
  return withTx(async (tx) => {
    await tx.$executeRaw`
      UPDATE orders SET status = 'expired'
      WHERE id = ${id}::uuid AND status = 'pending' AND expires_at <= now()
    `;
    return readOrder(id, tx);
  });
}

export function claimPickup(id: string) {
  return withTx(async (tx) => {
    // A competing claim waits on this order row, then rechecks status and updates zero rows after the winner commits.
    const [claimed] = await tx.$queryRaw<{ id: string; pickedUpAt: Date }[]>`
      UPDATE orders SET status = 'picked_up', picked_up_at = now()
      WHERE id = ${id}::uuid AND status = 'paid'
      RETURNING id, picked_up_at AS "pickedUpAt"
    `;
    if (!claimed) {
      const [order] = await tx.$queryRaw<{ status: OrderStatus; expired: boolean }[]>`
        SELECT status, expires_at <= now() AS expired FROM orders WHERE id = ${id}::uuid
      `;
      if (!order) throw new AppError(404, 'ORDER_NOT_FOUND', 'Order not found');
      if (order.status === 'picked_up') throw new AppError(409, 'ALREADY_CLAIMED', 'Order already collected');
      if (order.status === 'needs_review') throw new AppError(409, 'ORDER_NEEDS_REVIEW', 'Payment needs review');
      if (order.status === 'expired' || (order.status === 'pending' && order.expired)) {
        throw new AppError(409, 'ORDER_EXPIRED', 'Order hold expired');
      }
      throw new AppError(409, 'ORDER_NOT_PAID', 'Order is not paid');
    }

    const { items } = await readOrder(id, tx);
    const ids = items.map((item) => item.productId);
    await tx.$queryRaw`
      SELECT id FROM products WHERE id = ANY(${ids}::int[]) ORDER BY id FOR UPDATE
    `;
    for (const item of items) {
      await tx.$executeRaw`UPDATE products SET stock = stock - ${item.quantity} WHERE id = ${item.productId}`;
    }
    return { ...claimed, status: 'picked_up' as const, items };
  });
}

// Availability already ignores overdue pending holds; sweeping only keeps the stored status accurate.
export function expirePendingOrders(): Promise<number> {
  return prisma.$executeRaw`
    UPDATE orders SET status = 'expired' WHERE status = 'pending' AND expires_at <= now()
  `;
}
