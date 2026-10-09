import { z } from 'zod';

import {
  BACKEND_FEATURES,
  CANDIDATE_KINDS,
  type CandidateKind,
  type ImageBackend,
} from '../../backend.js';
import { selectCandidates } from '../../candidates/select.js';
import type { JobStore } from '../../job/store.js';
import type { ToolSpec } from '../../llm/port.js';
import { CANDIDATE_PARAMS } from '../../loop/iteration-permissions.js';
import { selectMemory } from '../../memory/select.js';
import type { MemoryStore } from '../../memory/store.js';
import type { ParamKey } from '../../params/param-key.js';
import type { Permissions } from '../../permissions/permission.js';
import type { ConversationEvent } from '../events.js';
import type { TalkLimits } from './limits.js';

export type TalkToolContext = {
  conversationId: string;
  /** いまのターンの番号（描くツールが、作ったジョブの job.json に残す） */
  turn: number;
  /** その会話の確定したイベント（ターンの始めに読んだもの） */
  events: readonly ConversationEvent[];
  limits: TalkLimits;
  signal: AbortSignal;
};

export type TalkToolOutcome = {
  ok: boolean;
  /** 話す役へ返す結果。実行器が文字数で切る */
  result: string;
  /** 画面に出す短い要約（tool.result の summary） */
  summary: string;
};

/** 話す役が呼ぶツール。定義（名前・説明・引数のスキーマ）と、core が行う実行 */
/** ツールの説明の文字数の上限。説明はツールの数だけ毎ステップ送るので、小さいローカル LLM の窓を食わないように短く保つ */
export const TALK_TOOL_DESCRIPTION_MAX_CHARS = 160;

export type TalkTool = ToolSpec & {
  run(input: unknown, context: TalkToolContext): Promise<TalkToolOutcome>;
};

export type ReadOnlyToolDeps = {
  backend: ImageBackend;
  /** 全体の既定の許可（土台に重ねたもの）。候補は許可されたものだけを対象にする */
  permissions: () => Promise<Permissions>;
  /** 人間が候補に付けた短い説明 */
  candidateNotes?: () => Promise<ReadonlyMap<string, string>>;
  memory?: MemoryStore;
  jobs: JobStore;
};

const FEATURE_LABELS: Record<(typeof BACKEND_FEATURES)[number], string> = {
  hiresFix: 'Hires. fix',
  img2img: 'img2img',
  inpaint: 'inpaint',
  controlnet: 'ControlNet',
};

// 候補の種類から、許可を見るパラメータを引く（ControlNet の前処理はモデルと同じ controlnet の許可に従う）
const PARAM_OF_KIND: Record<CandidateKind, ParamKey> = {
  ...(Object.fromEntries(
    Object.entries(CANDIDATE_PARAMS).map(([param, kind]) => [kind, param]),
  ) as Record<string, ParamKey>),
  controlnetModule: 'controlnet',
} as Record<CandidateKind, ParamKey>;

const searchInput = z.object({
  kind: z.enum(CANDIDATE_KINDS),
  /** 名前・表示名・人間の説明に含まれる語。空なら許可された候補を予算の内で挙げる */
  query: z.string().max(100).default(''),
});
const recallInput = z.object({ query: z.string().min(1).max(200) });
const noInput = z.object({});

/** 副作用の無いツール。描けるかを聞かれて呼んでも、何も始まらない */
export function createReadOnlyTools(deps: ReadOnlyToolDeps): TalkTool[] {
  const describeBackend: TalkTool = {
    name: 'describe_backend',
    description:
      '画像生成のバックエンドで使える機能と、使えない機能とその理由を調べる。描けるか・何ができるかを聞かれたときに使う。描き始めない。',
    inputSchema: noInput,
    async run(_input, { signal }) {
      const capabilities = await deps.backend.probe(signal);
      const unavailable = new Map(capabilities.unavailable.map((u) => [u.feature, u.reason]));
      const lines = BACKEND_FEATURES.map((feature) => {
        const reason = unavailable.get(feature);
        return reason === undefined
          ? `${FEATURE_LABELS[feature]}: 使える`
          : `${FEATURE_LABELS[feature]}: 使えない（${reason}）`;
      });
      const limits = Object.entries(capabilities.limits ?? {}).map(([k, v]) => `${k}=${v}`);
      if (limits.length > 0) lines.push(`上限: ${limits.join(' ')}`);
      return {
        ok: true,
        result: lines.join('\n'),
        summary: `使えない機能 ${capabilities.unavailable.length} 件`,
      };
    },
  };

  const searchCandidates: TalkTool = {
    name: 'search_candidates',
    description:
      'checkpoint・LoRA などの候補を、語で引く。許可された候補だけを対象にする。キャラや画風を描けるかを聞かれたときに使う。描き始めない。',
    inputSchema: searchInput,
    async run(input, { limits, signal }) {
      const { kind, query } = searchInput.parse(input);
      const permission = (await deps.permissions())[PARAM_OF_KIND[kind]];
      if (permission.mode === 'off') {
        return {
          ok: true,
          result: `${kind} は、許可の設定で使わないことになっている`,
          summary: `${kind} は許可で使わない`,
        };
      }
      const all = await deps.backend.listCandidates(kind, signal);
      // 固定なら、その値だけ。任せていて絞り込みがあれば、その中だけ
      const choices =
        permission.mode === 'fixed'
          ? [String(permission.value)]
          : kind === 'controlnetModule'
            ? undefined
            : permission.choices;
      const notes = (await deps.candidateNotes?.()) ?? new Map<string, string>();
      const needle = query.normalize('NFKC').toLowerCase().trim();
      const matched =
        needle === ''
          ? all
          : all.filter((c) =>
              [c.name, c.label ?? '', notes.get(c.name) ?? ''].some((text) =>
                text.normalize('NFKC').toLowerCase().includes(needle),
              ),
            );
      const selection = selectCandidates(matched, choices, notes, query, limits.candidates);
      const lines = selection.shown.map((c) =>
        c.note === undefined ? c.name : `${c.name}: ${c.note}`,
      );
      const left = selection.droppedByBudget.length;
      if (left > 0) lines.push(`（ほかに ${left} 件。語を絞って引き直せる）`);
      return {
        ok: true,
        result: lines.length === 0 ? `${kind} に「${query}」に当たる候補は無い` : lines.join('\n'),
        summary: `${kind} の候補 ${selection.shown.length} 件${left > 0 ? `（ほかに ${left} 件）` : ''}`,
      };
    },
  };

  const recallMemory: TalkTool = {
    name: 'recall_memory',
    description:
      '人間の好みとして覚えている記憶を、語に関係するものだけ引く。記憶は会話をまたいで残る。描き始める前や、好みが関わる質問のときに使う。',
    inputSchema: recallInput,
    async run(input, { limits }) {
      const { query } = recallInput.parse(input);
      if (deps.memory === undefined) {
        return { ok: true, result: '記憶は使えない', summary: '記憶は使えない' };
      }
      const listing = await deps.memory.list();
      const selection = selectMemory(listing.items, query, limits.memory);
      return {
        ok: true,
        result:
          selection.selected.length === 0
            ? '当たる記憶は無い'
            : selection.selected.map((item) => `- ${item.body}`).join('\n'),
        summary: `記憶 ${selection.selected.length} 件`,
      };
    },
  };

  const drawingStatus: TalkTool = {
    name: 'drawing_status',
    description:
      'この会話で描いているジョブの今の状態（回・最良候補の点数）を調べる。人間に「今どう？」と聞かれたときに使う。',
    inputSchema: noInput,
    async run(_input, { events }) {
      const started = events.filter((e) => e.type === 'job.started').at(-1);
      if (started === undefined || started.type !== 'job.started') {
        return { ok: true, result: 'この会話で描いているジョブは無い', summary: 'ジョブは無い' };
      }
      const state = await deps.jobs.readState(started.jobId);
      const carry = state.carry;
      const parts = [`ジョブ ${started.jobId}: ${state.status}`];
      if (carry !== undefined) {
        parts.push(`${carry.completedIterations} 回済み`);
        if (carry.best !== undefined)
          parts.push(`最良は ${carry.best.iteration} 回目（${carry.best.score.toFixed(2)}）`);
      }
      if (state.status === 'stopped') parts.push(`止まった理由: ${state.reason.detail}`);
      return { ok: true, result: parts.join('。'), summary: state.status };
    },
  };

  return [describeBackend, searchCandidates, recallMemory, drawingStatus];
}
