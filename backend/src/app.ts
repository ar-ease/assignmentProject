import express from 'express';
import cors from 'cors';
import { AppError, errorHandler } from './errors.js';
import { productsRouter } from './routes/products.js';

export const app = express();
app.use(cors({ origin: 'http://localhost:3000' }));
// Mount express.json() per future JSON router. /payments/webhook needs
// express.raw() first so HMAC verification receives the original bytes.
app.get('/health', (_req, res) => res.json({ status: 'ok' }));
app.use('/products', productsRouter);
app.use((_req, _res, next) => next(new AppError(404, 'NOT_FOUND', 'Route not found')));
app.use(errorHandler);
