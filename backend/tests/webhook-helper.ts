import { createHmac } from 'node:crypto';
import request from 'supertest';
import { app } from '../src/app.js';

export function signPayload(raw: string): string {
  return createHmac('sha256', process.env.WEBHOOK_SECRET!).update(raw).digest('hex');
}

export function sendWebhook(payload: unknown) {
  const raw = JSON.stringify(payload);
  return request(app).post('/payments/webhook').set('Content-Type', 'application/json')
    .set('X-Signature', signPayload(raw)).send(raw);
}
