import express from 'express';
import cors from 'cors';
import { AppError, errorHandler } from './errors.js';
import { productsRouter } from './routes/products.js';
import { ordersRouter } from './routes/orders.js';
import { paymentWebhook } from './routes/payments.js';

export const app = express();
app.use(cors({ origin: 'http://localhost:3000' }));
// HMAC covers the exact received bytes: mount raw parsing before any JSON parser can consume them.
app.post('/payments/webhook', express.raw({ type: 'application/json', limit: '10kb', inflate: false }), paymentWebhook);
app.get('/health', (_req, res) => res.json({ status: 'ok' }));
app.use('/products', productsRouter);
app.use('/orders', ordersRouter);
app.use((_req, _res, next) => next(new AppError(404, 'NOT_FOUND', 'Route not found')));
app.use(errorHandler);
