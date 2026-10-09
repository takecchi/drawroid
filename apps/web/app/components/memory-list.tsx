import { useMemoryList } from '@drawroid/swr';
import { ErrorNote, Item, ItemList, Muted, Section, SubSection } from '@drawroid/ui';
import { Link } from 'react-router';

import { bodyHead } from '../lib/memory-form';

export function MemoryList() {
  const { data, error } = useMemoryList();
  return (
    <Section title="記憶">
      {error !== undefined && <ErrorNote>一覧を読めない: {error.message}</ErrorNote>}
      {data?.items.length === 0 && <Muted>まだ無い。</Muted>}
      <ItemList>
        {data?.items.map((item) => (
          <Item key={item.id}>
            <Link
              to={`/memory/${encodeURIComponent(item.id)}`}
              className="underline underline-offset-2"
            >
              {bodyHead(item.body)}
            </Link>{' '}
            [{item.scope}] {item.tags.map((tag) => `#${tag}`).join(' ')}{' '}
            {new Date(item.updatedAt).toLocaleString('ja-JP')} 学んだジョブ {item.sources.length}件
          </Item>
        ))}
      </ItemList>
      {data !== undefined && data.invalid.length > 0 && (
        <SubSection title="読めない項目">
          <ItemList>
            {data.invalid.map(({ id, reason }) => (
              <Item key={id}>
                <code>{id}</code>: {reason}
              </Item>
            ))}
          </ItemList>
        </SubSection>
      )}
    </Section>
  );
}
