'use client';

import { useEffect, useState } from 'react';

type Product = { id: number; name: string; pricePaise: number; stock: number; availableUnits: number };

function formatPaise(paise: number): string {
  return `₹${Math.trunc(paise / 100)}.${String(paise % 100).padStart(2, '0')}`;
}

export default function Home() {
  const [products, setProducts] = useState<Product[] | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    const controller = new AbortController();
    fetch(`${process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000'}/products`, { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error('API request failed');
        return response.json() as Promise<Product[]>;
      })
      .then(setProducts)
      .catch((cause: unknown) => {
        if (!controller.signal.aborted) setError('Unable to load snacks. Please try again later.');
      });
    return () => controller.abort();
  }, []);

  return (
    <main>
      <h1>Pickup Counter</h1>
      <p>Snacks available at the counter</p>
      {error ? <p role="alert">{error}</p> : products === null ? <p role="status">Loading snacks…</p> : (
        <ul>{products.map((product) => (
          <li key={product.id}>
            <h2>{product.name}</h2>
            <p>{formatPaise(product.pricePaise)}</p>
            <p>{product.availableUnits} available</p>
          </li>
        ))}</ul>
      )}
    </main>
  );
}
