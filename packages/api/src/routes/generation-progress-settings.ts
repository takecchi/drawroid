import { generationProgressSettingsSchema } from '@drawroid/core';
import { Hono } from 'hono';

import type { ApiDeps } from '../deps.js';
import { invalidConfig } from '../errors.js';
import { jsonBody } from '../validate.js';

/** 生成の進み具合の設定。途中の画像を流すかどうか（既定は流さない） */
export function generationProgressSettingsRoutes({ generationProgressSettings }: ApiDeps) {
  return new Hono()
    .get('/', async (c) => {
      try {
        return c.json(await generationProgressSettings.read(), 200);
      } catch (error) {
        return invalidConfig(c, error instanceof Error ? error.message : String(error));
      }
    })
    .put('/', jsonBody(generationProgressSettingsSchema), async (c) => {
      const settings = c.req.valid('json');
      await generationProgressSettings.write(settings);
      return c.json(settings, 200);
    });
}
