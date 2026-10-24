export type Product = {
  id: number;
  name: string;
  pricePaise: number;
  stock: number;
  availableUnits: number;
};

export type OrderItemInput = { productId: number; quantity: number };
export type OrderStatus = 'pending' | 'paid' | 'expired' | 'needs_review' | 'picked_up';
export type Order = {
  id: string;
  status: OrderStatus;
  totalPaise: number;
  reviewReason: string | null;
  items: (OrderItemInput & { name: string; unitPricePaise: number })[];
  expiresAt: string;
  expiresInSeconds: number;
};

export type ApiErrorResponse = { error: { code: string; message: string } };

export class ApiError extends Error {
  constructor(public readonly status: number, public readonly code: string, message: string) {
    super(message);
    this.name = 'ApiError';
  }
}

function isErrorResponse(body: unknown): body is ApiErrorResponse {
  return typeof body === 'object' && body !== null && 'error' in body
    && typeof body.error === 'object' && body.error !== null
    && 'code' in body.error && typeof body.error.code === 'string'
    && 'message' in body.error && typeof body.error.message === 'string';
}

async function request<T>(path: string, init: RequestInit, expectedStatus = 200): Promise<T> {
  const response = await fetch(`${process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000'}${path}`, {
    ...init,
    cache: 'no-store',
  });
  const body: unknown = await response.json().catch(() => null);
  if (response.status !== expectedStatus) {
    throw new ApiError(response.status, isErrorResponse(body) ? body.error.code : 'API_ERROR',
      isErrorResponse(body) ? body.error.message : `The counter returned HTTP ${response.status}. Please try again.`);
  }
  if (body === null) throw new Error('The counter returned an unreadable response. Please try again.');
  return body as T;
}

export const getProducts = (signal: AbortSignal) => request<Product[]>('/products', { signal });
export const getOrder = (id: string, signal: AbortSignal) => request<Order>(`/orders/${encodeURIComponent(id)}`, { signal });
export const createOrder = (items: OrderItemInput[], signal: AbortSignal) => request<Order>('/orders', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ items }),
  signal,
}, 201);

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Something went wrong. Please try again.';
}
