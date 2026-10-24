import { z } from 'zod';

export const WEBHOOK_SECRET = z.string().refine((value) => value.trim().length > 0,
  'WEBHOOK_SECRET must be set and non-empty').parse(process.env.WEBHOOK_SECRET);

// make_interval accepts a PostgreSQL integer number of seconds.
export const HOLD_SECONDS = z.coerce.number().int().positive().max(2_147_483_647)
  .parse(process.env.HOLD_SECONDS ?? 120);
