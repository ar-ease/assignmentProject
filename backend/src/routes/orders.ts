import { Router, json } from 'express';
import { z } from 'zod';
import { createOrder, getOrder } from '../orders.js';

const itemSchema = z.object({
  productId: z.number().int().positive(),
  quantity: z.number().int().positive().max(20),
});
const orderSchema = z.object({ items: z.array(itemSchema).min(1) });
export const ordersRouter = Router();
ordersRouter.use(json());

ordersRouter.post('/', async (req, res) => {
  const { items } = orderSchema.parse(req.body);
  const quantities = new Map<number, number>();
  for (const item of items) {
    quantities.set(item.productId, (quantities.get(item.productId) ?? 0) + item.quantity);
  }
  const merged = orderSchema.parse({ items: Array.from(quantities, ([productId, quantity]) => ({ productId, quantity })) });
  res.status(201).json(await createOrder(merged.items));
});

ordersRouter.get('/:id', async (req, res) => {
  const id = z.string().uuid().parse(req.params.id);
  res.json(await getOrder(id));
});
