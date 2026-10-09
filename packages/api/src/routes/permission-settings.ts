import {
  mergePermissions,
  permissionOverridesSchema,
  readPermissionOverrides,
  type InvalidPermission,
  type Permissions,
} from '@drawroid/core';
import { Hono } from 'hono';

import type { ApiDeps } from '../deps.js';
import { jsonBody } from '../validate.js';

/**
 * 全体の既定の許可。書いた欄（overrides）と、土台に重ねた実際の許可（permissions）を返す。
 * 書いた許可は、走行中のジョブにも次の回の境目から効く。ジョブごとの上書き（job.json）は変わらない。
 */
export function permissionSettingsRoutes({ permissionSettings }: ApiDeps) {
  const view = (overrides: Partial<Permissions>, invalid: InvalidPermission[]) => ({
    overrides,
    permissions: mergePermissions(permissionSettings.base, overrides),
    invalid,
  });

  return new Hono()
    .get('/', async (c) => {
      // 読めない行は外して、理由と一緒に返す: 1行の書き損じで画面が丸ごと読めなくならないように。
      // 外した行は、ループの側でも同じく土台に戻る（CLI が同じ読み方をする）
      const { overrides, invalid } = readPermissionOverrides(await permissionSettings.read());
      return c.json(view(overrides, invalid), 200);
    })
    .put('/', jsonBody(permissionOverridesSchema), async (c) => {
      const overrides = c.req.valid('json');
      await permissionSettings.write(overrides);
      return c.json(view(overrides, []), 200);
    });
}
