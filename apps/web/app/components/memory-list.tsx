import { useMemoryList } from '@drawroid/swr';
import { Link } from 'react-router';

import { bodyHead } from '../lib/memory-form';

export function MemoryList() {
  const { data, error } = useMemoryList();
  return (
    <section>
      <h2>記憶</h2>
      {error !== undefined && <p role="alert">一覧を読めない: {error.message}</p>}
      {data?.items.length === 0 && <p>まだ無い。</p>}
      <ul>
        {data?.items.map((item) => (
          <li key={item.id}>
            <Link to={`/memory/${encodeURIComponent(item.id)}`}>{bodyHead(item.body)}</Link> [
            {item.scope}] {item.tags.map((tag) => `#${tag}`).join(' ')}{' '}
            {new Date(item.updatedAt).toLocaleString('ja-JP')} 学んだジョブ {item.sources.length}件
          </li>
        ))}
      </ul>
      {data !== undefined && data.invalid.length > 0 && (
        <>
          <h3>読めない項目</h3>
          <ul>
            {data.invalid.map(({ id, reason }) => (
              <li key={id}>
                <code>{id}</code>: {reason}
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
