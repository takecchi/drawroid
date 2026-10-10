import { useMemoryList } from '@drawroid/swr';
import { EmptyState, ErrorNote, Item, ItemList, Section, SubSection } from '@drawroid/ui';
import { Link } from 'react-router';

import { bodyHead } from '../lib/memory-form';

export function MemoryList() {
  const { data, error } = useMemoryList();
  return (
    // 画面の頭の見出しにする（h1）: この一覧は記憶の画面にだけ置かれ、画面にほかの h1 が無いため
    <Section title="記憶" level={1}>
      {/* 何がいつここに入るのか: 空のままだと、覚える仕組みがあることも、いつ増えるのかも分からないため */}
      <p className="text-sm text-muted-foreground">
        {
          '描いたジョブが止まったときと、止まったあとに選び直したときに、選んだ画像と人間の指示から好みを整理してここに覚える。次に描くとき、考える役・見る役・話す役がこれを読む。'
        }
      </p>
      {error !== undefined && <ErrorNote>一覧を読めない: {error.message}</ErrorNote>}
      {data?.items.length === 0 && <EmptyState title="まだ無い。" />}
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
            {new Date(item.updatedAt).toLocaleString('ja-JP')} 学んだ元 {item.sources.length}件
          </Item>
        ))}
      </ItemList>
      {data !== undefined && data.invalid.length > 0 && (
        <SubSection title="読めない項目" level={2}>
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
