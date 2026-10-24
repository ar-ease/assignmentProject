import { Router } from 'express';
import { prisma } from '../db.js';
import { reservedUnitsSql } from '../reservations.js';

type ProductAvailability = {
  id: number;
  name: string;
  pricePaise: number;
  stock: number;
  availableUnits: number;
};

export const productsRouter = Router();

productsRouter.get('/', async (_req, res) => {
  const products = await prisma.$queryRaw<ProductAvailability[]>`
    SELECT p.id, p.name, p.price_paise AS "pricePaise", p.stock,
      (p.stock - ${reservedUnitsSql})::int AS "availableUnits"
    FROM products p
    LEFT JOIN order_items oi ON oi.product_id = p.id
    LEFT JOIN orders o ON o.id = oi.order_id
    GROUP BY p.id
    ORDER BY p.id
  `;
  res.json(products);
});
