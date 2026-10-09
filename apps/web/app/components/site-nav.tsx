import {
  AppSidebar,
  Drawer,
  MobileTopBar,
  type AppSidebarItem,
  type AppSidebarRenderLink,
} from '@drawroid/ui';
import {
  Brain,
  Images,
  ListTodo,
  MessageSquare,
  ScrollText,
  Settings2,
  ShieldCheck,
  Tags,
  Wand2,
} from 'lucide-react';
import { useEffect, useState, useSyncExternalStore } from 'react';
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
const ITEMS: AppSidebarItem[] = [
  { to: '/', label: '会話', icon: MessageSquare },
  { to: '/jobs/new', label: '依頼', icon: Images, section: '描く' },
  { to: '/jobs', label: 'ジョブ', icon: ListTodo, section: '描く' },
  { to: '/generate', label: '手動で生成', icon: Wand2, section: '描く' },
  { to: '/memory', label: '記憶', icon: Brain, section: '覚えること' },
  { to: '/candidates', label: '候補の説明', icon: Tags, section: '覚えること' },
  { to: '/settings', label: '設定', icon: Settings2, section: '設定' },
  { to: '/permissions', label: '許可', icon: ShieldCheck, section: '設定' },
  { to: '/llm-calls', label: 'LLM の記録', icon: ScrollText, section: '設定' },
];

/**
 * 行き先。広い画面では左の脇に置き、狭い画面では上の帯のボタンからドロワーで開く。
 * 脇とドロワーの中身は同じ `AppSidebar` で、行き先は `ITEMS` の1か所にある。
 */
export function SiteNav() {
  const hydrated = useHydrated();
  const { pathname } = useLocation();
  const [open, setOpen] = useState(false);
  // 行き先を選んだら閉じる: 開いたままだと、移った先の頁がドロワーの下に隠れたままになるため
  useEffect(() => setOpen(false), [pathname]);

  // 会話は一覧（/）と各会話（/conversations/:id）が別の道にあるので、NavLink の一致では片方しか光らない
  const inConversations = pathname === '/' || pathname.startsWith('/conversations/');
  const renderLink: AppSidebarRenderLink = (item, slot) => {
    if (item.to === '/') {
      return (
        <Link
          to="/"
          className={slot.className(inConversations)}
          aria-current={inConversations ? 'page' : undefined}
        >
          {slot.children}
        </Link>
      );
    }
    // `/jobs` に end を付ける: 付けないと `/jobs/new` や `/jobs/:id` のような下の頁でも光ってしまうため
    return (
      <NavLink
        to={item.to}
        end={item.to === '/jobs'}
        className={({ isActive }) => slot.className(isActive)}
      >
        {slot.children}
      </NavLink>
    );
  };

  return (
    // key を変えて作り直す: 同じ要素のまま描き直しても、React は前に描いた値としか比べず、焼かれた class が残るため
    <div key={hydrated ? 'client' : 'prerendered'} className="contents">
      <AppSidebar
        items={ITEMS}
        renderLink={renderLink}
        className="sticky top-0 hidden h-dvh md:flex"
      />
      <div className="md:hidden">
        <MobileTopBar onOpenNav={() => setOpen(true)} />
      </div>
      <Drawer open={open} onClose={() => setOpen(false)} label="行き先">
        <AppSidebar items={ITEMS} renderLink={renderLink} inDrawer />
      </Drawer>
    </div>
  );
}
