'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { createOrder, errorMessage, getProducts, type Order, type Product } from '../lib/api';
import { cartLines, MAX_PER_ITEM, reconcileCart, type Cart } from '../lib/cart';
import { formatPaise } from '../lib/money';

export default function Home() {
  const router = useRouter();
  const [products, setProducts] = useState<Product[] | null>(null);
  const [cart, setCart] = useState<Cart>({});
  const [productsError, setProductsError] = useState('');
  const [orderError, setOrderError] = useState('');
  const [placing, setPlacing] = useState(false);
  const productsRequest = useRef<AbortController | null>(null);
  const orderRequest = useRef<AbortController | null>(null);
  const refreshTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const refreshProducts = useCallback(async function refresh() {
    clearTimeout(refreshTimer.current);
    productsRequest.current?.abort();
    const controller = new AbortController();
    productsRequest.current = controller;
    try {
      const fresh = await getProducts(controller.signal);
      if (controller.signal.aborted) return;
      setProducts(fresh);
      setCart((current) => reconcileCart(current, fresh));
      setProductsError('');
    } catch (error: unknown) {
      if (!controller.signal.aborted) setProductsError(errorMessage(error));
    } finally {
      if (!controller.signal.aborted) refreshTimer.current = setTimeout(() => void refresh(), 5000);
    }
  }, []);

  useEffect(() => {
    void refreshProducts();
    return () => {
      clearTimeout(refreshTimer.current);
      productsRequest.current?.abort();
      orderRequest.current?.abort();
    };
  }, [refreshProducts]);

  const lines = cartLines(cart, products ?? []);
  const totalPaise = lines.reduce((total, line) => total + line.lineTotalPaise, 0);

  function changeQuantity(productId: number, delta: number) {
    setCart((current) => reconcileCart({ ...current, [productId]: (current[productId] ?? 0) + delta }, products ?? []));
  }

  async function placeOrder() {
    if (orderRequest.current || lines.length === 0) return;
    const controller = new AbortController();
    orderRequest.current = controller;
    setPlacing(true);
    setOrderError('');
    let order: Order | undefined;
    try {
      order = await createOrder(lines.map((line) => ({ productId: line.id, quantity: line.quantity })), controller.signal);
    } catch (error: unknown) {
      if (!controller.signal.aborted) setOrderError(errorMessage(error));
    } finally {
      // Refresh after every attempt, including stock conflicts, and clamp the cart.
      if (!controller.signal.aborted) await refreshProducts();
      if (!controller.signal.aborted && !order) {
        orderRequest.current = null;
        setPlacing(false);
      }
    }
    if (order && !controller.signal.aborted) router.push(`/orders/${order.id}`);
  }

  return (
    <main>
      <header className="page-header">
        <p className="eyebrow">Pickup Counter</p>
        <h1>A snack, then back to it.</h1>
        <p className="muted">Choose your snacks. Pay via UPI. Collect from the locker.</p>
      </header>
      <div className="menu-layout">
        <section aria-labelledby="menu-heading">
          <div className="section-heading">
            <h2 id="menu-heading">On the menu</h2>
            <span className="muted small">Stock refreshes every 5s</span>
          </div>
          {productsError && <p role="alert" className="error-note">{productsError} Retrying automatically…</p>}
          {products === null ? <p role="status">Loading snacks…</p> : products.length === 0 ? <p>No snacks on the menu yet.</p> : (
            <ul className="product-list">
              {products.map((product) => {
                const quantity = cart[product.id] ?? 0;
                const limit = Math.min(product.availableUnits, MAX_PER_ITEM);
                return (
                  <li key={product.id} className="product-row">
                    <div>
                      <h3>{product.name}</h3>
                      <p className="product-price">{formatPaise(product.pricePaise)}</p>
                      <p className={product.availableUnits === 0 ? 'sold-out small' : 'muted small'}>
                        {product.availableUnits === 0 ? 'Sold out' : `${product.availableUnits} available`}
                      </p>
                    </div>
                    <div className="quantity-control" aria-label={`Quantity for ${product.name}`}>
                      <button type="button" aria-label={`Remove one ${product.name}`} disabled={placing || quantity === 0}
                        onClick={() => changeQuantity(product.id, -1)}>−</button>
                      <output aria-label={`${product.name} quantity`}>{quantity}</output>
                      <button type="button" aria-label={`Add one ${product.name}`} disabled={placing || quantity >= limit}
                        onClick={() => changeQuantity(product.id, 1)}>+</button>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
          <p className="muted small">Up to {MAX_PER_ITEM} of each item per order. Items are held after you place your order.</p>
        </section>

        <section className="panel cart-panel" aria-labelledby="cart-heading" aria-busy={placing}>
          <h2 id="cart-heading">Your cart</h2>
          {lines.length === 0 ? <p className="muted">Your next snack starts here. Add something from the menu.</p> : (
            <ul className="summary-list">
              {lines.map((line) => <li key={line.id}>
                <span>{line.quantity} × {line.name}<small className="muted">{formatPaise(line.pricePaise)} each</small></span>
                <span>{formatPaise(line.lineTotalPaise)}</span>
              </li>)}
            </ul>
          )}
          <p className="total-row"><span>Total</span><strong>{formatPaise(totalPaise)}</strong></p>
          {orderError && <p role="alert" className="error-note">{orderError}</p>}
          <button type="button" className="primary-button full-width" disabled={placing || lines.length === 0}
            onClick={() => void placeOrder()}>{placing ? 'Placing order…' : 'Place order'}</button>
          <p className="muted small">Payment is the next step.</p>
        </section>
      </div>
    </main>
  );
}
