import { Hono } from 'hono';
import { ZodError } from 'zod';

import type { ApiDeps } from '../deps.js';
import { invalidRequest } from '../errors.js';

export function manualJobsRoutes({ manualRunner }: ApiDeps) {
  return new Hono().post('/', async (c) => {
    const body: unknown = await c.req.json().catch(() => undefined);
    try {
      const { jobId } = await manualRunner.start(body);
      return c.json({ jobId }, 202);
    } catch (error) {
      if (error instanceof ZodError) return invalidRequest(c, error.message);
      throw error;
    }
  });
}
