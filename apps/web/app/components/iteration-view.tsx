import type { JobDetail } from '@drawroid/swr';

export type Iteration = JobDetail['iterations'][number];

// 回ごとの表示をここに閉じる: 考える役の決定・見る役の評価・口出しが読めるようになったとき、足す場所をこの部品に限るため
export function IterationView({ iteration }: { iteration: Iteration }) {
  return (
    <article>
      <h3>{iteration.iteration} 回目</h3>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
        {iteration.images.map((image) => (
          <figure key={image.index} style={{ margin: 0 }}>
            <img src={image.url} alt={`seed ${image.seed}`} style={{ maxWidth: 320 }} />
            <figcaption>seed {image.seed ?? '不明'}</figcaption>
          </figure>
        ))}
      </div>
      <details>
        <summary>request</summary>
        <pre>{JSON.stringify(iteration.request, null, 2)}</pre>
      </details>
    </article>
  );
}

export function IterationList({ iterations }: { iterations: Iteration[] }) {
  return (
    <section>
      <h2>回</h2>
      {iterations.length === 0 && <p>まだ画像は無い。</p>}
      {iterations.map((iteration) => (
        <IterationView key={iteration.iteration} iteration={iteration} />
      ))}
    </section>
  );
}
