'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { createCountdown } from './countdown';

export function useCountdown() {
  const clock = useRef<ReturnType<typeof createCountdown> | null>(null);
  if (clock.current === null) clock.current = createCountdown();
  const [remaining, setRemaining] = useState<number | null>(null);

  const resync = useCallback((expiresInSeconds: number) => {
    clock.current!.sync(expiresInSeconds);
    setRemaining(clock.current!.remaining());
  }, []);

  useEffect(() => {
    // Each server response replaces the deadline using performance.now(), a monotonic
    // clock unaffected by device wall-clock skew. Never compare expiresAt or wall time.
    // Tick every 250ms; zero only means "Checking payment status…" until the server
    // confirms expiry, because a payment may have arrived at the deadline.
    const timer = window.setInterval(() => {
      setRemaining((value) => value === null ? null : clock.current!.remaining());
    }, 250);
    return () => window.clearInterval(timer);
  }, []);

  return { remaining, resync };
}
