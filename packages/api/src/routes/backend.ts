import { candidateKindSchema } from '@drawroid/core';
import { Hono } from 'hono';

import type { ApiDeps } from '../deps.js';
import { backendFailure, invalidRequest } from '../errors.js';

export function backendRoutes({ backend }: ApiDeps) {
  return new Hono()
    .get('/', async (c) => {
      try {
        return c.json({ capabilities: await backend.probe() }, 200);
      } catch (error) {
        return backendFailure(c, error);
      }
    })
    .get('/candidates/:kind', async (c) => {
      const kind = candidateKindSchema.safeParse(c.req.param('kind'));
      if (!kind.success) return invalidRequest(c, `候補の種類が違う: ${c.req.param('kind')}`);
      try {
        return c.json({ candidates: await backend.listCandidates(kind.data) }, 200);
      } catch (error) {
        return backendFailure(c, error);
      }
    });
}
