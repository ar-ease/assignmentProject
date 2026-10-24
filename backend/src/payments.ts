import type { OrderStatus } from '@prisma/client';
import { z } from 'zod';
import { withTx } from './db.js';
import { reservedUnitsSql } from './reservations.js';

export const webhookSchema = z.object({
  eventId: z.string().min(1),
  orderId: z.string(),
  amountPaise: z.number().int().nonnegative(),
  status: z.string(),
});

export function processPayment(payload: z.infer<typeof webhookSchema>) {
  return withTx(async (tx) => {
    const orderId = z.string().uuid().safeParse(payload.orderId).success ? payload.orderId : null;
    // The unique insert waits for concurrent retries; rollback removes the event so a provider can retry.
    const inserted = await tx.$queryRaw<{ event_id: string }[]>`
      INSERT INTO webhook_events (event_id, order_id, payload)
      VALUES (${payload.eventId}, ${orderId}::uuid, ${JSON.stringify(payload)}::jsonb)
      ON CONFLICT (event_id) DO NOTHING RETURNING event_id
    `;
    if (!inserted.length) return { result: 'duplicate' };

    // Always lock the ORDER first, then PRODUCT rows in ID order. Pickup must use this same rule.
    const [order] = await tx.$queryRaw<{ status: OrderStatus; totalPaise: number; activeHold: boolean }[]>`
      SELECT status, total_paise AS "totalPaise", expires_at > now() AS "activeHold"
      FROM orders WHERE id = ${orderId}::uuid FOR UPDATE
    `;
    // A provider retries non-2xx; retrying cannot fix an unknown order, so record it and acknowledge 200.
    if (!order) return { result: 'ignored', reason: 'unknown_order' };
    if (payload.status !== 'captured') return { result: 'ignored', reason: 'not_captured' };
    if (['paid', 'picked_up', 'needs_review'].includes(order.status)) {
      console.warn('Distinct capture for a final order; possible double charge, refund review needed', {
        eventId: payload.eventId, orderId, status: order.status,
      });
      return { result: 'ignored', reason: 'already_final' };
    }

    let reviewReason: string | null = null;
    const late = order.status === 'expired' || !order.activeHold;
    if (payload.amountPaise !== order.totalPaise) {
      reviewReason = 'amount_mismatch';
    } else {
      const items = await tx.orderItem.findMany({ where: { orderId: orderId! } });
      const ids = items.map((item) => item.productId);
      const products = await tx.$queryRaw<{ id: number; stock: number }[]>`
        SELECT id, stock FROM products WHERE id = ANY(${ids}::int[]) ORDER BY id FOR UPDATE
      `;
      // Even active captures lock stock: a lock wait can cross expiry while another order reclaims it.
      // Exclude our own hold and read separately after locking to see the previous lock holder's commits.
      const reservations = await tx.$queryRaw<{ id: number; reserved: number }[]>`
        SELECT p.id, ${reservedUnitsSql} AS reserved
        FROM products p
        LEFT JOIN order_items oi ON oi.product_id = p.id
        LEFT JOIN orders o ON o.id = oi.order_id AND o.id <> ${orderId}::uuid
        WHERE p.id = ANY(${ids}::int[])
        GROUP BY p.id
      `;
      const reserved = new Map(reservations.map((row) => [row.id, row.reserved]));
      const quantities = new Map(items.map((item) => [item.productId, item.quantity]));
      if (products.some((product) => product.stock - reserved.get(product.id)! < quantities.get(product.id)!)) {
        reviewReason = 'late_payment_stock_unavailable';
      }
    }

    if (reviewReason) {
      await tx.$executeRaw`
        UPDATE orders SET status = 'needs_review', review_reason = ${reviewReason} WHERE id = ${orderId}::uuid
      `;
      return { result: 'needs_review', reason: reviewReason };
    }
    await tx.$executeRaw`UPDATE orders SET status = 'paid', paid_at = now() WHERE id = ${orderId}::uuid`;
    return late ? { result: 'paid', late: true } : { result: 'paid' };
  });
}
