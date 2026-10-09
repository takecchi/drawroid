import { mergePermissions, permissionOverridesSchema, type Permissions } from '@drawroid/core';
import { Hono } from 'hono';

import type { ApiDeps } from '../deps.js';
import { describeIssues, invalidConfig } from '../errors.js';
import { jsonBody } from '../validate.js';

/**
 * 全体の既定の許可。書いた欄（overrides）と、土台に重ねた実際の許可（permissions）を返す。
 * 書いた許可は、走行中のジョブにも次の回の境目から効く。ジョブごとの上書き（job.json）は変わらない。
 */
export function permissionSettingsRoutes({ permissionSettings }: ApiDeps) {
  const view = (overrides: Partial<Permissions>) => ({
    overrides,
    permissions: mergePermissions(permissionSettings.base, overrides),
  });

  return new Hono()
    .get('/', async (c) => {
      const stored = permissionOverridesSchema.safeParse((await permissionSettings.read()) ?? {});
      // 読めない許可を、土台だけで答えない: 人間が書いたはずの許可が効いていないことが見えなくなるため
      if (!stored.success) return invalidConfig(c, describeIssues(stored.error));
      return c.json(view(stored.data), 200);
    })
    .put('/', jsonBody(permissionOverridesSchema), async (c) => {
      const overrides = c.req.valid('json');
      await permissionSettings.write(overrides);
      return c.json(view(overrides), 200);
    });
}
