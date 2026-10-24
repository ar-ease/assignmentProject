import { Prisma } from '@prisma/client';

// Queries using this fragment alias order_items as oi and orders as o.
export const reservedUnitsSql = Prisma.sql`COALESCE(SUM(oi.quantity) FILTER (WHERE
  (o.status = 'pending' AND o.expires_at > now()) OR o.status = 'paid'
), 0)::int`;
