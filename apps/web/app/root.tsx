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
    // colorScheme: CSS が届く前の一瞬も、ブラウザの既定の白で光らせないため
    <html lang="ja" className="dark" style={{ colorScheme: 'dark' }}>
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
          <div id={MAIN_CONTENT_ID} className="min-w-0 flex-1 outline-none">
            {children}
          </div>
        </div>
        <ScrollRestoration />
        <Scripts />
      </body>
    </html>
  );
}

/**
 * JS を読み込んで画面を組み立てるまでの間に出す。SPA なので、最初に配る HTML の本文はこれだけになる。
 * 読み込みが止まった・失敗したときに本文が空のまま（真っ白）にならないよう、時間が経ったら次にすることを出す。
 * 時間の経過は CSS だけで出す（JS が動かないときにも出るように）
 */
export function HydrateFallback() {
  return (
    <div role="status" className="space-y-2 p-6 text-sm text-muted-foreground">
      <p>読み込んでいます…</p>
      <p className="hydrate-slow-hint">
        読み込みに時間がかかっている。ページを再読み込みするか、drawroid
        を起動したターミナルにエラーが出ていないかを確かめる。
      </p>
      <noscript>
        <p>この画面は JavaScript で動く。ブラウザで JavaScript を有効にして開き直す。</p>
      </noscript>
    </div>
  );
}

export default function App() {
  return <Outlet />;
}
