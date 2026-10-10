/** pnpm dev の起動（dev:serve）が dev.env で渡す、Vite が画面を配っている URL。本番の起動では無い */
export const DEV_WEB_URL_ENV = 'DRAWROID_DEV_WEB_URL';

export function devWebUrl(env: Readonly<Record<string, string | undefined>>): string | undefined {
  const url = env[DEV_WEB_URL_ENV];
  return url === undefined || url === '' ? undefined : url;
}

/** 起動の最後の行。開発中は drawroid の URL が API だけなので、画面を開く先として Vite の URL を添える */
export function listeningLine(
  address: { address: string; port: number },
  env: Readonly<Record<string, string | undefined>>,
): string {
  const url = `http://${address.address}:${address.port}/`;
  const dev = devWebUrl(env);
  return dev === undefined ? `drawroid: ${url}` : `drawroid: API ${url}（画面は ${dev} を開く）`;
}
