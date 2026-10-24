import { createHmac, timingSafeEqual } from 'node:crypto';
import type { RequestHandler } from 'express';
import { WEBHOOK_SECRET } from '../config.js';
import { AppError } from '../errors.js';
import { processPayment, webhookSchema } from '../payments.js';

export const paymentWebhook: RequestHandler = async (req, res) => {
  const signature = req.get('X-Signature');
  // Validate length before timingSafeEqual, which throws for unequal buffer lengths.
  if (!signature || !/^[a-fA-F0-9]{64}$/.test(signature) || !Buffer.isBuffer(req.body)) {
    throw new AppError(401, 'INVALID_SIGNATURE', 'Invalid webhook signature');
  }
  const expected = createHmac('sha256', WEBHOOK_SECRET).update(req.body).digest();
  if (!timingSafeEqual(Buffer.from(signature, 'hex'), expected)) {
    throw new AppError(401, 'INVALID_SIGNATURE', 'Invalid webhook signature');
  }

  let body: unknown;
  try {
    body = JSON.parse(req.body.toString('utf8'));
  } catch {
    throw new AppError(400, 'VALIDATION_ERROR', 'Request body must be valid JSON');
  }
  res.json(await processPayment(webhookSchema.parse(body)));
};
