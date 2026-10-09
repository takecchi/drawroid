import { Link } from 'react-router';

// 行き先は1か所に並べる: 画面ごとに足していくと、同じ名前で別の行き先を指す段が増えるため
export function SiteNav() {
  return (
    <nav style={{ display: 'flex', gap: 16, padding: '8px 16px' }}>
      <Link to="/">生成</Link>
      <Link to="/jobs/new">依頼</Link>
      <Link to="/jobs">ジョブ</Link>
      <Link to="/memory">記憶</Link>
      <Link to="/permissions">許可</Link>
      <Link to="/candidates">候補の説明</Link>
    </nav>
  );
}
