import { Links, Meta, Outlet, Scripts, ScrollRestoration } from 'react-router';
import type { ReactNode } from 'react';

import './app.css';
import { SiteNav } from './components/site-nav';

export function meta() {
  return [{ title: 'drawroid' }, { name: 'robots', content: 'noindex, nofollow' }];
}

export function Layout({ children }: { children: ReactNode }) {
  return (
    // 暗い側を既定にする: テーマ（`@drawroid/ui` の styles.css）は暗い側を主に色を決めてあるため
    <html lang="ja" className="dark">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <Meta />
        <Links />
      </head>
      <body>
        <SiteNav />
        {children}
        <ScrollRestoration />
        <Scripts />
      </body>
    </html>
  );
}

export default function App() {
  return <Outlet />;
}
