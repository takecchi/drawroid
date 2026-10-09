import { Link, Links, Meta, Outlet, Scripts, ScrollRestoration } from 'react-router';
import type { ReactNode } from 'react';

export function meta() {
  return [{ title: 'drawroid' }, { name: 'robots', content: 'noindex, nofollow' }];
}

export function Layout({ children }: { children: ReactNode }) {
  return (
    <html lang="ja">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <Meta />
        <Links />
      </head>
      <body>
        <nav style={{ display: 'flex', gap: 16, padding: '8px 16px' }}>
          <Link to="/">生成</Link>
          <Link to="/jobs/new">依頼</Link>
          <Link to="/jobs">ジョブ</Link>
        </nav>
        {children}
        <ScrollRestoration />
        <Scripts />
      </body>
    </html>
  );
}

export default function App() {
  return (
    <>
      <nav style={{ maxWidth: 960, margin: '0 auto', padding: '8px 16px' }}>
        <Link to="/">ジョブ</Link> <Link to="/memory">記憶</Link>
      </nav>
      <Outlet />
    </>
  );
}
