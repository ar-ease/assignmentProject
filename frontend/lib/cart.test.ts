import { expect, it } from 'vitest';
import type { Product } from './api';
import { cartLines, reconcileCart } from './cart';

const products: Product[] = [
  { id: 1, name: 'Samosa', pricePaise: 2050, stock: 30, availableUnits: 25 },
  { id: 2, name: 'Chai', pricePaise: 1525, stock: 5, availableUnits: 2 },
  { id: 3, name: 'Puff', pricePaise: 3000, stock: 5, availableUnits: 0 },
];

it('caps quantities at stock and the backend limit, removing unavailable products', () => {
  expect(reconcileCart({ 1: 25, 2: 4, 3: 1, 99: 2 }, products)).toEqual({ 1: 20, 2: 2 });
});

it('adjusts an existing cart after stock changes', () => {
  expect(reconcileCart({ 1: 3, 2: 1 }, [{ ...products[0], availableUnits: 1 }])).toEqual({ 1: 1 });
});

it('computes cart line totals and the total in integer paise', () => {
  const lines = cartLines({ 1: 3, 2: 2 }, products);
  expect(lines.map((line) => line.lineTotalPaise)).toEqual([6150, 3050]);
  expect(lines.reduce((total, line) => total + line.lineTotalPaise, 0)).toBe(9200);
  expect(cartLines({}, products)).toEqual([]);
});
