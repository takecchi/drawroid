import type { InterventionsResponse } from '@drawroid/swr';
import { AuthorMark, BulletList, EmptyState, Section } from '@drawroid/ui';

import { formatTime } from '../lib/job-labels';

export type Intervention = InterventionsResponse['interventions'][number];
type StopConditionsIntervention = Extract<Intervention, { kind: 'stopConditions' }>;

const MS_PER_MINUTE = 60_000;

// 上限の null は「外した」と出す: 欄を省いた変更（触っていない）と、上限を外した変更を見分けられるようにするため
function describeLimit(label: string, value: number | null, unit: string): string {
  return value === null ? `${label}: 外した` : `${label}: ${value} ${unit}`;
}

function describeStopConditionsChange({
  stopConditions: change,
}: StopConditionsIntervention): string[] {
  const lines: string[] = [];
  if (change.aiJudgement !== undefined) {
    lines.push(`AI の判断で止める: ${change.aiJudgement ? 'する' : 'しない'}`);
  }
  if (change.maxIterations !== undefined) {
    lines.push(describeLimit('回数の上限', change.maxIterations, '回'));
  }
  if (change.maxImages !== undefined) {
    lines.push(describeLimit('枚数の上限', change.maxImages, '枚'));
  }
  if (change.maxDurationMs !== undefined) {
    lines.push(
      describeLimit(
        '時間の上限',
        change.maxDurationMs === null ? null : change.maxDurationMs / MS_PER_MINUTE,
        '分',
      ),
    );
  }
  return lines;
}

export function InterventionItem({
  intervention,
  showStatus = true,
  stopped = false,
}: {
  intervention: Intervention;
  /** ジョブが止まった。まだ取り込んでいない・使っていない指示は、もう取り込まれない */
  stopped?: boolean;
  /** 回の中では取り込んだ回が自明なので、取り込みの状態を省ける */
  showStatus?: boolean;
}) {
  return (
    <AuthorMark author="human" label="人間の指示" meta={formatTime(intervention.receivedAt)}>
      {intervention.kind === 'instruction' ? (
        <>
          <p className="whitespace-pre-wrap">{intervention.text}</p>
          {showStatus && (
            <p>
              {intervention.appliedInIteration === undefined
                ? stopped
                  ? '取り込まずに止まった'
                  : '次の回の境目で取り込む'
                : `${intervention.appliedInIteration} 回目の「考える」に取り込んだ`}
            </p>
          )}
        </>
      ) : intervention.kind === 'mask' ? (
        <>
          <p>
            {/* 1 から数える: ほかの画面の呼び方（「N 回目の画像 M 番」）にそろえる */}
            {intervention.image.iteration} 回目の画像 {intervention.image.index + 1}{' '}
            番にマスクを塗った
          </p>
          {showStatus && (
            <p>
              {intervention.usedInIteration === undefined
                ? stopped
                  ? '使わずに止まった'
                  : 'まだ描き直しに使っていない'
                : `${intervention.usedInIteration} 回目の描き直しに使った`}
            </p>
          )}
        </>
      ) : intervention.kind === 'adopt' ? (
        <p>
          {intervention.image.iteration} 回目の画像 {intervention.image.index + 1} 番を選んだ
        </p>
      ) : (
        <>
          <p>止める条件を変えた</p>
          <BulletList>
            {describeStopConditionsChange(intervention).map((line) => (
              <li key={line}>{line}</li>
            ))}
          </BulletList>
        </>
      )}
    </AuthorMark>
  );
}

// 受けた順に並べ直さない: ストアが受けた順で返す約束で、ここで時刻の文字列を比べ直すと形式の違いで崩れるため
export function InterventionList({
  interventions,
  stopped = false,
}: {
  interventions: Intervention[];
  /** ジョブが止まった（まだ取り込んでいない指示を、そう書かないため） */
  stopped?: boolean;
}) {
  return (
    <Section title={`人間の指示（${interventions.length}）`}>
      {interventions.length === 0 && <EmptyState title="まだ人間の指示は無い。" />}
      {interventions.map((intervention) => (
        <InterventionItem
          key={intervention.interventionId}
          intervention={intervention}
          stopped={stopped}
        />
      ))}
    </Section>
  );
}
