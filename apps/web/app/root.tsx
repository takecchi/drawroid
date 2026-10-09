import { Links, Meta, Outlet, Scripts, ScrollRestoration } from 'react-router';
import { MAIN_CONTENT_ID, SkipLink } from '@drawroid/ui';
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
        <SkipLink />
        {/* 広い画面では行き先を左の脇に、本文をその右に並べる。狭い画面では上の帯の下に本文を積む */}
        <div className="md:flex">
          <SiteNav />
          {/* 本文へ移動の行き先。tabIndex で焦点を受けられるようにし、輪は出さない（本文全体を囲む輪は位置の手がかりにならないため） */}
          <div id={MAIN_CONTENT_ID} tabIndex={-1} className="min-w-0 flex-1 outline-none">
            {children}
          </div>
        </div>
        <ScrollRestoration />
        <Scripts />
      </body>
    </html>
  );
}

export default function App() {
  return <Outlet />;
}
