/** pnpm dev の起動（dev:serve）が dev.env で渡す、Vite が画面を配っている URL。本番の起動では無い */
export const DEV_WEB_URL_ENV = 'DRAWROID_DEV_WEB_URL';

export function devWebUrl(env: Readonly<Record<string, string | undefined>>): string | undefined {
  const url = env[DEV_WEB_URL_ENV];
  return url === undefined || url === '' ? undefined : url;
}
