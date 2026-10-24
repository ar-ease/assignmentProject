import type { ErrorRequestHandler } from 'express';
import { ZodError } from 'zod';

export class AppError extends Error {
  constructor(public readonly status: number, public readonly code: string, message: string) {
    super(message);
    this.name = 'AppError';
  }
}

export const errorHandler: ErrorRequestHandler = (error: unknown, _req, res, _next) => {
  if (error instanceof Error && 'type' in error && error.type === 'entity.too.large') {
    res.status(413).json({ error: { code: 'PAYLOAD_TOO_LARGE', message: 'Request body exceeds the allowed size' } });
    return;
  }
  if (error instanceof Error && 'type' in error && error.type === 'encoding.unsupported') {
    res.status(415).json({ error: { code: 'UNSUPPORTED_ENCODING', message: 'Compressed request bodies are not supported' } });
    return;
  }
  if (error instanceof ZodError) {
    res.status(400).json({ error: {
      code: 'VALIDATION_ERROR',
      message: error.issues.map((issue) => `${issue.path.join('.') || 'request'}: ${issue.message}`).join('; '),
    } });
    return;
  }
  if (error instanceof SyntaxError && 'type' in error && error.type === 'entity.parse.failed') {
    res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'Request body must be valid JSON' } });
    return;
  }
  if (error instanceof AppError) {
    res.status(error.status).json({ error: { code: error.code, message: error.message } });
    return;
  }
  console.error(error);
  res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'An unexpected error occurred' } });
};
