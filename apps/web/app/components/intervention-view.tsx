import type { InterventionsResponse } from '@drawroid/swr';
import type { CSSProperties } from 'react';

import { formatTime } from '../lib/job-labels';

export type Intervention = InterventionsResponse['interventions'][number];
type StopConditionsIntervention = Extract<Intervention, { kind: 'stopConditions' }>;

const MS_PER_MINUTE = 60_000;

// 枠の色と左の線で分ける: 人間の指示と AI の判断が並ぶ記録で、文字を読まなくてもどちらかが分かるようにするため
const MARK_COLORS = { human: '#d97706', ai: '#2563eb' } as const;

export function markStyle(author: keyof typeof MARK_COLORS): CSSProperties {
  return {
    borderLeft: `4px solid ${MARK_COLORS[author]}`,
    paddingLeft: 8,
    marginBottom: 8,
  };
}

export function AuthorLabel({ author, children }: { author: 'human' | 'ai'; children: string }) {
  return <strong style={{ color: MARK_COLORS[author], fontSize: '0.85em' }}>{children}</strong>;
}

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
}: {
  intervention: Intervention;
  /** 回の中では取り込んだ回が自明なので、取り込みの状態を省ける */
  showStatus?: boolean;
}) {
  return (
    <div style={markStyle('human')}>
      <AuthorLabel author="human">人間の指示</AuthorLabel> {formatTime(intervention.receivedAt)}
      {intervention.kind === 'instruction' ? (
        <>
          <p style={{ whiteSpace: 'pre-wrap', margin: '4px 0' }}>{intervention.text}</p>
          {showStatus && (
            <p style={{ margin: '4px 0' }}>
              {intervention.appliedInIteration === undefined
                ? '次の回の境目で取り込む'
                : `${intervention.appliedInIteration} 回目の「考える」に取り込んだ`}
            </p>
          )}
        </>
      ) : intervention.kind === 'mask' ? (
        <>
          <p style={{ margin: '4px 0' }}>
            {intervention.image.iteration} 回目の画像 {intervention.image.index} にマスクを塗った
          </p>
          {showStatus && (
            <p style={{ margin: '4px 0' }}>
              {intervention.usedInIteration === undefined
                ? 'まだ inpaint に使っていない'
                : `${intervention.usedInIteration} 回目の inpaint に使った`}
            </p>
          )}
        </>
      ) : (
        <>
          <p style={{ margin: '4px 0' }}>止める条件を変えた</p>
          <ul style={{ margin: '4px 0' }}>
            {describeStopConditionsChange(intervention).map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

// 受けた順に並べ直さない: ストアが受けた順で返す約束で、ここで時刻の文字列を比べ直すと形式の違いで崩れるため
export function InterventionList({ interventions }: { interventions: Intervention[] }) {
  return (
    <section>
      <h2>人間の指示（{interventions.length}）</h2>
      {interventions.length === 0 && <p>まだ人間の指示は無い。</p>}
      {interventions.map((intervention) => (
        <InterventionItem key={intervention.interventionId} intervention={intervention} />
      ))}
    </section>
  );
}
