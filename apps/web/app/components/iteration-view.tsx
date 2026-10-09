import type { SelectionVerdict } from '@drawroid/core';
import { formatImageKey } from '@drawroid/core';
import type { IterationsResponse } from '@drawroid/swr';
import {
  AuthorMark,
  BulletList,
  CodeBlock,
  DescriptionList,
  Disclosure,
  EmptyState,
  ImageCard,
  ImageGrid,
  ImageViewer,
  Section,
  type ViewerImage,
} from '@drawroid/ui';
import { useMemo, useState } from 'react';

import { describeExcludedReason, describeWanted } from '../lib/excluded-reason';
import { formatScore } from '../lib/format';
import { readJudge, readThink } from '../lib/stage-output';
import { AdoptButton } from './adopt-button';
import { InterventionItem, type Intervention } from './intervention-view';
import { LlmCallList, type LlmCallSummary } from './llm-call-view';
import { MaskPainter } from './mask-painter';
import { SelectionControls } from './selection-controls';

export type Iteration = IterationsResponse['iterations'][number];

const PARAM_LABELS = {
  prompt: 'prompt',
  negativePrompt: 'negative prompt',
  seed: 'seed',
  steps: 'steps',
  cfgScale: 'cfg scale',
} as const;

function ThinkSection({ think }: { think: unknown }) {
  const read = readThink(think);
  if (read === undefined) {
    return (
      <AuthorMark as="section" author="ai" label="AI（考える役）">
        <h4 className="font-semibold">考える役の決定</h4>
        <CodeBlock>{JSON.stringify(think, null, 2)}</CodeBlock>
      </AuthorMark>
    );
  }
  const entries = Object.entries(PARAM_LABELS).flatMap(([key, label]) => {
    const value = read.params[key as keyof typeof PARAM_LABELS];
    return value === undefined ? [] : [[label, value] as const];
  });
  return (
    <AuthorMark as="section" author="ai" label="AI（考える役）">
      <h4 className="font-semibold">考える役の決定</h4>
      <DescriptionList>
        {entries.map(([label, value]) => (
          <div key={label}>
            <dt>{label}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </DescriptionList>
      <p>理由: {read.rationale}</p>
    </AuthorMark>
  );
}

function ExcludedSection({ excluded }: { excluded: NonNullable<Iteration['excluded']> }) {
  return (
    <AuthorMark as="section" author="ai">
      <h4 className="font-semibold">この回に AI の選択肢から外したもの</h4>
      <BulletList>
        {excluded.map((item) => (
          <li key={item.param}>
            {item.param}（{describeWanted(item.wanted)}）: {describeExcludedReason(item.reason)}
          </li>
        ))}
      </BulletList>
    </AuthorMark>
  );
}

function JudgeSection({ judge, read }: { judge: unknown; read: ReturnType<typeof readJudge> }) {
  if (read === undefined) {
    return (
      <AuthorMark as="section" author="ai" label="AI（見る役）">
        <h4 className="font-semibold">見る役の評価</h4>
        <CodeBlock>{JSON.stringify(judge, null, 2)}</CodeBlock>
      </AuthorMark>
    );
  }
  return (
    <AuthorMark as="section" author="ai" label="AI（見る役）">
      <h4 className="font-semibold">見る役の評価</h4>
      <DescriptionList>
        <dt>次に変えること</dt>
        <dd>{read.nextChange}</dd>
        <dt>止めてよいか</dt>
        <dd>{read.canStop ? '止めてよい' : '止めない'}</dd>
      </DescriptionList>
    </AuthorMark>
  );
}

function AdoptedSection({ adopted }: { adopted: NonNullable<Iteration['adopted']> }) {
  return (
    <AuthorMark as="section" author="human" label="人間">
      <h4 className="font-semibold">評価</h4>
      <p>
        人が選んだ（{adopted.image.iteration} 回目の画像 {adopted.image.index + 1} 番）: score{' '}
        {formatScore(adopted.score)}
      </p>
    </AuthorMark>
  );
}

// 回ごとの表示をここに閉じる: 口出しなど回に紐づく記録を足す場所を、この部品に限るため
export function IterationView({
  jobId,
  iteration,
  calls,
  verdicts,
  interventions = [],
  canPaintMask = false,
  adopt,
  open,
}: {
  jobId: string;
  iteration: Iteration;
  calls: LlmCallSummary[];
  verdicts: ReadonlyMap<string, SelectionVerdict>;
  /** この回に取り込んだ人間の指示。考える役の決定の前に出す */
  interventions?: Intervention[];
  /** 画像にマスクを塗って送れるか。自動ジョブで、まだ止まっていないときだけ */
  canPaintMask?: boolean;
  /** 画像を「この画像で決める」で採れるか。自動ジョブだけ。止まったジョブは押せない理由を添える */
  adopt?: { disabledReason?: string };
  /** 画像を大きく見る窓で開く（窓の画像の key）。渡さなければ、画像は原寸への link */
  open?: (viewerKey: string) => void;
}) {
  const judge = readJudge(iteration.judge);
  const adopted = iteration.judge === null ? iteration.adopted : null;
  return (
    <article className="space-y-3 border-t border-border pt-3 first:border-t-0 first:pt-0">
      <h3 className="text-sm font-semibold">{iteration.iteration} 回目</h3>
      {interventions.map((intervention) => (
        <InterventionItem
          key={intervention.interventionId}
          intervention={intervention}
          showStatus={false}
        />
      ))}
      {iteration.excluded !== null && iteration.excluded.length > 0 && (
        <ExcludedSection excluded={iteration.excluded} />
      )}
      {iteration.think !== null && <ThinkSection think={iteration.think} />}
      <ImageGrid>
        {iteration.images.map((image) => {
          // 評価の並びは画像の並びと同じ: 見る役の出力が画像の枚数ぶんをちょうど返すため
          const evaluation = judge?.images[image.index];
          const imageKey = formatImageKey({ iteration: iteration.iteration, index: image.index });
          const verdict = verdicts.get(imageKey) ?? null;
          return (
            <ImageCard
              key={image.index}
              href={image.url}
              src={image.previewUrl}
              // 会話の画像の行と同じ呼び方（1 から数える）: 同じ画像が、画面によって別の名前で読まれないため
              alt={`${imageTitle(iteration.iteration, image.index)}（seed ${image.seed ?? '不明'}）`}
              viewerKey={imageKey}
              {...(open !== undefined && { onOpen: () => open(imageKey) })}
              verdict={verdict}
              caption={
                <>
                  <div>seed {image.seed ?? '不明'}</div>
                  {adopted !== null &&
                    adopted.image.iteration === iteration.iteration &&
                    adopted.image.index === image.index && (
                      <div>人が選んだ / score {formatScore(adopted.score)}</div>
                    )}
                  {evaluation !== undefined && (
                    <>
                      <div>score {formatScore(evaluation.score)}</div>
                      {evaluation.issues.length > 0 && (
                        <BulletList className="text-xs">
                          {evaluation.issues.map((issue, i) => (
                            <li key={i}>{issue}</li>
                          ))}
                        </BulletList>
                      )}
                    </>
                  )}
                </>
              }
            >
              <SelectionControls jobId={jobId} imageKey={imageKey} verdict={verdict} />
              {adopt !== undefined && (
                <AdoptButton
                  jobId={jobId}
                  image={{ iteration: iteration.iteration, index: image.index }}
                  imageLabel={`${iteration.iteration} 回目の画像 ${image.index + 1} 番`}
                  chosen={
                    iteration.adopted !== null &&
                    iteration.adopted.image.iteration === iteration.iteration &&
                    iteration.adopted.image.index === image.index
                  }
                  {...(adopt.disabledReason !== undefined && {
                    disabledReason: adopt.disabledReason,
                  })}
                />
              )}
              {canPaintMask && (
                <MaskPainter
                  jobId={jobId}
                  image={{ iteration: iteration.iteration, index: image.index, url: image.url }}
                />
              )}
            </ImageCard>
          );
        })}
      </ImageGrid>
      {iteration.judge !== null && <JudgeSection judge={iteration.judge} read={judge} />}
      {adopted !== null && <AdoptedSection adopted={adopted} />}
      <Disclosure summary="request">
        <CodeBlock>{JSON.stringify(iteration.request, null, 2)}</CodeBlock>
      </Disclosure>
      {calls.length > 0 && <LlmCallList jobId={jobId} calls={calls} />}
    </article>
  );
}

const imageTitle = (iteration: number, index: number) => `${iteration} 回目の画像 ${index + 1} 番`;

/** ジョブの全部の回の画像を、回の順・番の順に並べる。大きく見る窓の送りはこの順に進む */
function viewerImagesOf(iterations: readonly Iteration[]): ViewerImage[] {
  return iterations.flatMap((iteration) =>
    iteration.images.map((image) => {
      const title = imageTitle(iteration.iteration, image.index);
      return {
        key: formatImageKey({ iteration: iteration.iteration, index: image.index }),
        src: image.url,
        fullSrc: image.url,
        title,
        alt: `${title}（seed ${image.seed ?? '不明'}）`,
      };
    }),
  );
}

export function IterationList({
  jobId,
  heading,
  iterations,
  calls,
  verdicts,
  interventions = [],
  canPaintMask = false,
  adopt,
}: {
  jobId: string;
  heading: string;
  iterations: Iteration[];
  calls: LlmCallSummary[];
  verdicts: ReadonlyMap<string, SelectionVerdict>;
  interventions?: Intervention[];
  canPaintMask?: boolean;
  adopt?: { disabledReason?: string };
}) {
  const [viewing, setViewing] = useState<string | null>(null);
  const viewerImages = useMemo(() => viewerImagesOf(iterations), [iterations]);
  return (
    <Section title={heading}>
      <ImageViewer images={viewerImages} openKey={viewing} onOpenKeyChange={setViewing} />
      {iterations.length === 0 && <EmptyState title="まだ画像は無い。" />}
      {iterations.map((iteration) => (
        <IterationView
          key={iteration.iteration}
          jobId={jobId}
          iteration={iteration}
          verdicts={verdicts}
          canPaintMask={canPaintMask}
          {...(adopt !== undefined && { adopt })}
          open={setViewing}
          interventions={interventions.filter(
            (intervention) =>
              intervention.kind === 'instruction' &&
              intervention.appliedInIteration === iteration.iteration,
          )}
          calls={calls.filter((call) => call.iteration === iteration.iteration)}
        />
      ))}
    </Section>
  );
}
