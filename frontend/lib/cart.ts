import type { Product } from './api';

export type Cart = Record<number, number>;
// Matches the quantity validator in backend/src/routes/orders.ts.
export const MAX_PER_ITEM = 20;

export function reconcileCart(cart: Cart, products: Product[]): Cart {
  const next: Cart = {};
  for (const product of products) {
    const quantity = Math.min(cart[product.id] ?? 0, product.availableUnits, MAX_PER_ITEM);
    if (quantity > 0) next[product.id] = quantity;
  }
  return next;
}

export function cartLines(cart: Cart, products: Product[]) {
  const quantities = reconcileCart(cart, products);
  return products.filter((product) => quantities[product.id] > 0).map((product) => ({
    ...product,
    quantity: quantities[product.id],
    lineTotalPaise: product.pricePaise * quantities[product.id],
  }));
}
