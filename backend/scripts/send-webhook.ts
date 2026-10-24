import { createHmac, randomUUID } from 'node:crypto';
import { parseArgs } from 'node:util';
import { z } from 'zod';

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      amount: { type: 'string' }, event: { type: 'string' }, status: { type: 'string' },
      'bad-signature': { type: 'boolean' },
    },
  });
  if (positionals.length !== 1) {
    throw new Error('Usage: npm run send-webhook -- <orderId> [--amount <paise>] [--event <id>] [--status <status>] [--bad-signature]');
  }
  const [orderId] = positionals;
  const baseUrl = process.env.API_URL ?? 'http://localhost:4000';
  const secret = z.string().refine((value) => value.trim().length > 0, 'WEBHOOK_SECRET must be non-empty')
    .parse(process.env.WEBHOOK_SECRET ?? 'local-development-webhook-secret');
  const paise = z.number().int().nonnegative();
  let amountPaise: number;
  if (values.amount !== undefined) {
    amountPaise = paise.parse(Number(z.string().regex(/^\d+$/, 'Amount must be integer paise').parse(values.amount)));
  } else {
    const order = await fetch(`${baseUrl}/orders/${encodeURIComponent(orderId)}`);
    if (!order.ok) throw new Error(`GET /orders failed: HTTP ${order.status} ${await order.text()}`);
    amountPaise = z.object({ totalPaise: paise }).parse(await order.json()).totalPaise;
  }
  const eventId = z.string().min(1).parse(values.event ?? `evt_${randomUUID()}`);
  const body = JSON.stringify({ eventId, orderId, amountPaise, status: values.status ?? 'captured' });
  let signature = createHmac('sha256', secret).update(body).digest('hex');
  if (values['bad-signature']) signature = (signature[0] === '0' ? '1' : '0') + signature.slice(1);
  console.log(`eventId: ${eventId}`);
  const response = await fetch(`${baseUrl}/payments/webhook`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Signature': signature }, body,
  });
  console.log(`HTTP ${response.status}`);
  console.log(await response.text());
  if (!response.ok) process.exitCode = 1;
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
