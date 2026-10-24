'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import { ApiError, errorMessage, getOrder, type Order } from '../../../lib/api';
import { formatCountdown } from '../../../lib/countdown';
import { formatPaise } from '../../../lib/money';
import { useCountdown } from '../../../lib/use-countdown';

const reviewMessages: Record<string, string> = {
  amount_mismatch: "The payment amount didn't match. Staff will review and refund if needed.",
  late_payment_stock_unavailable: 'Your payment arrived after the hold expired and the items sold out. Staff will refund you.',
};

export default function OrderPage() {
  const { id } = useParams<{ id: string }>();
  return <PaymentScreen key={id} id={id} />;
}

function PaymentScreen({ id }: { id: string }) {
  const [order, setOrder] = useState<Order | null>(null);
  const [error, setError] = useState('');
  const [reconnecting, setReconnecting] = useState(false);
  const [copyMessage, setCopyMessage] = useState('');
  const { remaining, resync } = useCountdown();

  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;

    async function poll() {
      try {
        const fresh = await getOrder(id, controller.signal);
        if (controller.signal.aborted) return;
        setOrder(fresh);
        resync(fresh.expiresInSeconds);
        setError('');
        setReconnecting(false);
        if (fresh.status !== 'pending' && fresh.status !== 'paid') return;
      } catch (cause: unknown) {
        if (controller.signal.aborted) return;
        setError(errorMessage(cause));
        if (cause instanceof ApiError && (cause.status === 400 || cause.status === 404)) return;
        setReconnecting(true);
      }
      // Schedule only after the request settles so slow requests never overlap.
      if (!controller.signal.aborted) timer = setTimeout(poll, 2000);
    }

    void poll();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [id, resync]);

  const command = `docker compose exec backend npm run send-webhook -- ${order?.id ?? id}`;
  const pickupCommand = `curl -i -X POST ${process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000'}/orders/${id}/pickup-claim`;

  async function copyCommand() {
    try {
      await navigator.clipboard.writeText(command);
      setCopyMessage('Copied');
    } catch {
      setCopyMessage('Could not copy. Select the command and copy it manually.');
    }
  }

  const status = order?.status;
  let title = 'Loading your order…';
  let message = '';
  let icon = '◷';
  if (status === 'pending') {
    title = remaining === 0 ? 'Checking payment status…' : 'Waiting for payment';
    message = 'Your items are held while you complete payment.';
  } else if (status === 'paid') {
    title = 'Payment received ✓';
    message = `Collect your order from the locker. Order ID: ${id}`;
    icon = '✓';
  } else if (status === 'picked_up') {
    title = 'Order collected';
    icon = '✓';
  } else if (status === 'expired') {
    title = 'Your hold expired';
    message = 'Your hold expired and the items were released.';
    icon = '⌛';
  } else if (status === 'needs_review') {
    title = 'Payment needs review';
    message = reviewMessages[order?.reviewReason ?? ''] ?? 'Staff will review your payment. Please contact the counter.';
    icon = '!';
  } else if (error) {
    title = 'Unable to load your order';
    message = error;
    icon = '!';
  }

  return (
    <main className="order-page">
      <header className="page-header">
        <Link href="/" className="back-link">← Menu</Link>
        <p className="eyebrow">Pickup Counter</p>
        <h1>Your order</h1>
        <p className="muted order-id">Order ID: {id}</p>
      </header>

      <section className={`status-panel status-${status ?? 'loading'}`} aria-live="polite" aria-atomic="true">
        <span className="status-icon" aria-hidden="true">{icon}</span>
        <div>
          <h2>{title}</h2>
          {status === 'pending' && remaining !== null && remaining > 0 && (
            <p className="countdown" aria-label={`${remaining} seconds remaining`}>{formatCountdown(remaining)}</p>
          )}
          {message && <p>{message}</p>}
          {reconnecting && <p className="small muted">Reconnecting…</p>}
          {status === 'expired' && <Link className="primary-button" href="/">Back to menu</Link>}
        </div>
      </section>

      {error && order && <p className="error-note" role="alert">{error}</p>}
      {!order && error && <Link className="back-link" href="/">Back to menu</Link>}

      {order && (
        <div className="payment-layout">
          <section className="panel" aria-labelledby="summary-heading">
            <h2 id="summary-heading">Order summary</h2>
            <ul className="summary-list">
              {order.items.map((item) => <li key={item.productId}>
                <span>{item.quantity} × {item.name}<small className="muted">{formatPaise(item.unitPricePaise)} each</small></span>
                <span>{formatPaise(item.quantity * item.unitPricePaise)}</span>
              </li>)}
            </ul>
            <p className="total-row"><span>Total</span><strong>{formatPaise(order.totalPaise)}</strong></p>
          </section>

          {status === 'pending' && (
            <section className="panel payment-panel" aria-labelledby="payment-heading">
              <h2 id="payment-heading">Pay {formatPaise(order.totalPaise)} via UPI</h2>
              <div className="qr-placeholder"><span aria-hidden="true">▦</span><strong>UPI QR placeholder</strong><span className="small">Demo only. No real payment.</span></div>
              <div className="developer-hint">
                <h3>Developer: simulate payment</h3>
                <p className="muted small">Run this command from the project root.</p>
                <code>{command}</code>
                <button type="button" onClick={() => void copyCommand()}>Copy command</button>
                <p className="small" role="status">{copyMessage}</p>
              </div>
            </section>
          )}
          {status === 'paid' && (
            <section className="panel developer-hint" aria-labelledby="pickup-heading">
              <h2 id="pickup-heading">Developer: claim pickup</h2>
              <code>{pickupCommand}</code>
              <p className="muted small">Run from a terminal. This page updates after collection.</p>
            </section>
          )}
        </div>
      )}
    </main>
  );
}
