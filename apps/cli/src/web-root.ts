import { existsSync } from 'node:fs';
import { join } from 'node:path';

export function pickWebRoot(bundledRoot: string, resolveWorkspaceRoot: () => string): string {
  return existsSync(join(bundledRoot, 'index.html')) ? bundledRoot : resolveWorkspaceRoot();
}
