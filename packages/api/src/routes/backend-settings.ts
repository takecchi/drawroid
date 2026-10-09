import { Hono } from 'hono';

import { backendSettingsViewSchema, updateBackendSettingsSchema } from '../backend-settings.js';
import type { ApiDeps } from '../deps.js';
import { invalidRequest } from '../errors.js';

// 実装が返した値をスキーマに通してから返す: 実装が秘密（パスワード）を余分に載せても、HTTP には出ないようにするため
const toView = (value: unknown) => backendSettingsViewSchema.parse(value);

export function backendSettingsRoutes({ backendSettings }: ApiDeps) {
  return new Hono()
    .get('/', async (c) => c.json(toView(await backendSettings.read()), 200))
    .put('/', async (c) => {
      const body: unknown = await c.req.json().catch(() => undefined);
      const input = updateBackendSettingsSchema.safeParse(body);
      if (!input.success) return invalidRequest(c, input.error.message);
      return c.json(toView(await backendSettings.write(input.data)), 200);
    });
}
