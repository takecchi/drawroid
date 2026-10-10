import type { SelectionVerdict } from '@drawroid/core';
import { formatImageKey, parseImageKey } from '@drawroid/core';
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
  Muted,
  Section,
  type ViewerImage,
} from '@drawroid/ui';
import { useMemo, useState } from 'react';

import { describeExcludedReason, describeWanted } from '../lib/excluded-reason';
import { formatScore } from '../lib/format';
import { readJudge, readThink } from '../lib/stage-output';
import { AdoptButton } from './adopt-button';
import { ChooseAsFavorite } from './choose-as-favorite';
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
        {/* 「見る役の点」と書かない: 人が選んだ画像の点は、見る役が付けたものではなく、選んだ印として扱う 1 のため */}
        人が選んだ（{adopted.image.iteration} 回目の画像 {adopted.image.index + 1} 番）: 点{' '}
        {formatScore(adopted.score)}
      </p>
    </AuthorMark>
  );
}

/**
 * 画像の無い回の書き方。回の数と生成した枚数が食い違って見えるので、画像を作らずに止まった回はそう書く。
 * 止まっていないジョブでは、その回を進めている途中である
 */
function noImagesNote(iteration: Iteration, stopped: boolean): string {
  if (!stopped) return 'この回の画像はまだ無い（進めている途中）。';
  return iteration.think === null
    ? '考える前にジョブが止まり、この回は画像を作っていない。'
    : '考える段まで進んだところでジョブが止まり、この回は画像を作っていない。';
}

// 回ごとの表示をここに閉じる: 口出しなど回に紐づく記録を足す場所を、この部品に限るため
export function IterationView({
  jobId,
  iteration,
  calls,
  verdicts,
  interventions = [],
  canPaintMask = false,
  stopped = false,
  adopt,
  open,
}: {
  jobId: string;
  iteration: Iteration;
  calls: LlmCallSummary[];
  verdicts: ReadonlyMap<string, SelectionVerdict>;
  /** この回に取り込んだ人間の指示。考える役の決定の前に出す */
  interventions?: Intervention[];
  /** ジョブが止まったか。画像の無い回を「途中」と書くか「画像を作らずに止まった」と書くかを分ける */
  stopped?: boolean;
  /** 画像にマスクを塗って送れるか。自動ジョブで、まだ止まっていないときだけ */
  canPaintMask?: boolean;
  /** 自動ジョブなら渡す。stopped（止まった）なら、採る口の代わりに「この画像に決める（お気に入りにする）」を出す */
  adopt?: { stopped: boolean };
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
      {iteration.images.length === 0 && <Muted>{noImagesNote(iteration, stopped)}</Muted>}
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
                      <div>人が選んだ / 点 {formatScore(adopted.score)}</div>
                    )}
                  {evaluation !== undefined && (
                    <>
                      <div>見る役の点 {formatScore(evaluation.score)}</div>
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
              <SelectionControls
                jobId={jobId}
                imageKey={imageKey}
                imageLabel={imageTitle(iteration.iteration, image.index)}
                verdict={verdict}
              />
              {adopt !== undefined && (
                <ImageDecision
                  jobId={jobId}
                  iteration={iteration}
                  index={image.index}
                  verdict={verdict}
                  stopped={adopt.stopped}
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
      {iteration.request !== null && (
        <Disclosure summary="生成の要求">
          <CodeBlock>{JSON.stringify(iteration.request, null, 2)}</CodeBlock>
        </Disclosure>
      )}
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

/**
 * 1枚の画像の決め方。走っている自動ジョブでは採る口（この画像に決める。止めて決める）、止まったジョブではお気に入りの口
 * （この画像に決める（お気に入りにする））。人が決めた画像は「この画像に決めた」と出す。画像の枡と大きく見る窓で同じものを使う
 */
function ImageDecision({
  jobId,
  iteration,
  index,
  verdict,
  stopped,
}: {
  jobId: string;
  iteration: Iteration;
  index: number;
  verdict: SelectionVerdict | null;
  stopped: boolean;
}) {
  const chosen =
    iteration.adopted !== null &&
    iteration.adopted.image.iteration === iteration.iteration &&
    iteration.adopted.image.index === index;
  const imageLabel = imageTitle(iteration.iteration, index);
  // ここで決めたら、記録（adopted）が追いつく前にジョブが止まっても、採るボタン（決めた印）のままにする:
  // お気に入りのボタンへ差し替えると、決めた印が作り直され、印へ移したフォーカスが落ちるため
  const [decidedHere, setDecidedHere] = useState(false);
  if (stopped && !chosen && !decidedHere) {
    return (
      <ChooseAsFavorite
        jobId={jobId}
        imageKey={formatImageKey({ iteration: iteration.iteration, index })}
        imageLabel={imageLabel}
        verdict={verdict}
      />
    );
  }
  return (
    <AdoptButton
      jobId={jobId}
      image={{ iteration: iteration.iteration, index }}
      imageLabel={imageLabel}
      chosen={chosen}
      onDecided={() => setDecidedHere(true)}
    />
  );
}

/** 大きく見る窓の画像の下: 見る役の点と言葉、お気に入り・却下、（自動ジョブなら）「この画像に決める」。画像の枡と同じ部品・同じ口 */
function JobViewerDetails({
  jobId,
  iteration,
  index,
  verdicts,
  adopt,
}: {
  jobId: string;
  iteration: Iteration;
  index: number;
  verdicts: ReadonlyMap<string, SelectionVerdict>;
  /** 自動ジョブなら渡す。stopped（止まった）なら、採る口の代わりに「この画像に決める（お気に入りにする）」を出す */
  adopt?: { stopped: boolean };
}) {
  const evaluation = readJudge(iteration.judge)?.images[index];
  const imageKey = formatImageKey({ iteration: iteration.iteration, index });
  return (
    <div className="space-y-2 text-sm">
      {evaluation !== undefined && (
        <div className="space-y-1 text-xs text-muted-foreground">
          <div>見る役の点 {formatScore(evaluation.score)}</div>
          {evaluation.issues.length > 0 && (
            <BulletList className="text-xs">
              {evaluation.issues.map((issue, i) => (
                <li key={i}>{issue}</li>
              ))}
            </BulletList>
          )}
        </div>
      )}
      <SelectionControls
        jobId={jobId}
        imageKey={imageKey}
        imageLabel={imageTitle(iteration.iteration, index)}
        verdict={verdicts.get(imageKey) ?? null}
      />
      {adopt !== undefined && (
        <ImageDecision
          jobId={jobId}
          iteration={iteration}
          index={index}
          verdict={verdicts.get(imageKey) ?? null}
          stopped={adopt.stopped}
        />
      )}
    </div>
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
  stopped = false,
  adopt,
}: {
  jobId: string;
  heading: string;
  iterations: Iteration[];
  calls: LlmCallSummary[];
  verdicts: ReadonlyMap<string, SelectionVerdict>;
  interventions?: Intervention[];
  canPaintMask?: boolean;
  stopped?: boolean;
  /** 自動ジョブなら渡す。stopped（止まった）なら、採る口の代わりに「この画像に決める（お気に入りにする）」を出す */
  adopt?: { stopped: boolean };
}) {
  const [viewing, setViewing] = useState<string | null>(null);
  const viewerImages = useMemo(() => viewerImagesOf(iterations), [iterations]);
  return (
    <Section title={heading}>
      <ImageViewer
        images={viewerImages}
        openKey={viewing}
        onOpenKeyChange={setViewing}
        details={(image) => {
          const at = parseImageKey(image.key);
          const iteration = iterations.find((candidate) => candidate.iteration === at?.iteration);
          if (at === undefined || iteration === undefined) return null;
          return (
            <JobViewerDetails
              jobId={jobId}
              iteration={iteration}
              index={at.index}
              verdicts={verdicts}
              {...(adopt !== undefined && { adopt })}
            />
          );
        }}
      />
      {iterations.length === 0 && <EmptyState title="まだ画像は無い。" />}
      {iterations.map((iteration) => (
        <IterationView
          key={iteration.iteration}
          jobId={jobId}
          iteration={iteration}
          verdicts={verdicts}
          canPaintMask={canPaintMask}
          stopped={stopped}
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
