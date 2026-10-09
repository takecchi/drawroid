import type { IterationsResponse } from '@drawroid/swr';

import { readJudge, readThink } from '../lib/stage-output';
import { LlmCallList, type LlmCallSummary } from './llm-call-view';

export type Iteration = IterationsResponse['iterations'][number];

const PARAM_LABELS = {
  prompt: 'prompt',
  negativePrompt: 'negative prompt',
  seed: 'seed',
  steps: 'steps',
  cfg: 'cfg',
} as const;

function ThinkSection({ think }: { think: unknown }) {
  const read = readThink(think);
  if (read === undefined) {
    return (
      <section>
        <h4>考える役の決定</h4>
        <pre>{JSON.stringify(think, null, 2)}</pre>
      </section>
    );
  }
  const entries = Object.entries(PARAM_LABELS).flatMap(([key, label]) => {
    const value = read.params[key as keyof typeof PARAM_LABELS];
    return value === undefined ? [] : [[label, value] as const];
  });
  return (
    <section>
      <h4>考える役の決定</h4>
      <dl>
        {entries.map(([label, value]) => (
          <div key={label}>
            <dt>{label}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>
      <p>理由: {read.rationale}</p>
    </section>
  );
}

function JudgeSection({ judge, read }: { judge: unknown; read: ReturnType<typeof readJudge> }) {
  if (read === undefined) {
    return (
      <section>
        <h4>見る役の評価</h4>
        <pre>{JSON.stringify(judge, null, 2)}</pre>
      </section>
    );
  }
  return (
    <section>
      <h4>見る役の評価</h4>
      <dl>
        <dt>次に変えること</dt>
        <dd>{read.nextChange}</dd>
        <dt>止めてよいか</dt>
        <dd>{read.canStop ? '止めてよい' : '止めない'}</dd>
      </dl>
    </section>
  );
}

// 回ごとの表示をここに閉じる: 口出しが読めるようになったとき、足す場所をこの部品に限るため
export function IterationView({
  jobId,
  iteration,
  calls,
}: {
  jobId: string;
  iteration: Iteration;
  calls: LlmCallSummary[];
}) {
  const judge = readJudge(iteration.judge);
  return (
    <article>
      <h3>{iteration.iteration} 回目</h3>
      {iteration.think !== null && <ThinkSection think={iteration.think} />}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
        {iteration.images.map((image) => {
          // 評価の並びは画像の並びと同じ: 見る役の出力が画像の枚数ぶんをちょうど返すため
          const evaluation = judge?.images[image.index];
          return (
            <figure key={image.index} style={{ margin: 0 }}>
              <a href={image.url}>
                <img src={image.previewUrl} alt={`seed ${image.seed}`} style={{ maxWidth: 320 }} />
              </a>
              <figcaption>
                seed {image.seed ?? '不明'}
                {evaluation !== undefined && (
                  <>
                    <br />
                    score {evaluation.score}
                    {evaluation.issues.length > 0 && (
                      <ul>
                        {evaluation.issues.map((issue, i) => (
                          <li key={i}>{issue}</li>
                        ))}
                      </ul>
                    )}
                  </>
                )}
              </figcaption>
            </figure>
          );
        })}
      </div>
      {iteration.judge !== null && <JudgeSection judge={iteration.judge} read={judge} />}
      <details>
        <summary>request</summary>
        <pre>{JSON.stringify(iteration.request, null, 2)}</pre>
      </details>
      {calls.length > 0 && <LlmCallList jobId={jobId} calls={calls} />}
    </article>
  );
}

export function IterationList({
  jobId,
  heading,
  iterations,
  calls,
}: {
  jobId: string;
  heading: string;
  iterations: Iteration[];
  calls: LlmCallSummary[];
}) {
  return (
    <section>
      <h2>{heading}</h2>
      {iterations.length === 0 && <p>まだ画像は無い。</p>}
      {iterations.map((iteration) => (
        <IterationView
          key={iteration.iteration}
          jobId={jobId}
          iteration={iteration}
          calls={calls.filter((call) => call.iteration === iteration.iteration)}
        />
      ))}
    </section>
  );
}
