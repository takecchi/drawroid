import { SiteHeader, siteNavLinkClass } from '@drawroid/ui';
import { useSyncExternalStore } from 'react';
import { Link, NavLink, useLocation } from 'react-router';

const subscribeNothing = () => () => {};

// 水和の間は false、終えたら true。SPA の index.html は `/` で描いた帯を持ち、直に開いた頁でも
// 水和は属性（class・aria-current）の食い違いを直さないので、終えたあとに帯を作り直すのに使う
function useHydrated(): boolean {
  return useSyncExternalStore(
    subscribeNothing,
    () => true,
    () => false,
  );
}

// 行き先は1か所に並べる: 画面ごとに足していくと、同じ名前で別の行き先を指す段が増えるため
// `/jobs` に end を付ける: 付けないと `/jobs/new` や `/jobs/:id` のような下の頁でも光ってしまうため
export function SiteNav() {
  const hydrated = useHydrated();
  const { pathname } = useLocation();
  // 会話は一覧（/）と各会話（/conversations/:id）が別の道にあるので、NavLink の一致では片方しか光らない
  const inConversations = pathname === '/' || pathname.startsWith('/conversations/');
  return (
    // key を変えて作り直す: 同じ要素のまま描き直しても、React は前に描いた値としか比べず、焼かれた class が残るため
    <SiteHeader key={hydrated ? 'client' : 'prerendered'} brand="drawroid">
      <Link
        to="/"
        className={siteNavLinkClass({ isActive: inConversations })}
        aria-current={inConversations ? 'page' : undefined}
      >
        会話
      </Link>
      <NavLink to="/generate" className={siteNavLinkClass}>
        生成と設定
      </NavLink>
      <NavLink to="/jobs/new" className={siteNavLinkClass}>
        依頼
      </NavLink>
      <NavLink to="/jobs" end className={siteNavLinkClass}>
        ジョブ
      </NavLink>
      <NavLink to="/memory" className={siteNavLinkClass}>
        記憶
      </NavLink>
      <NavLink to="/permissions" className={siteNavLinkClass}>
        許可
      </NavLink>
      <NavLink to="/candidates" className={siteNavLinkClass}>
        候補の説明
      </NavLink>
    </SiteHeader>
  );
}
