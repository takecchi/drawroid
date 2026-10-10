import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import type {
  BackendKind,
  BackendSettingsPort,
  DoctorItem,
  DoctorPort,
  DoctorReport,
  DoctorSection,
} from '@drawroid/api';
import {
  DEFAULT_BUDGET,
  isBackendError,
  readBudgetOverrides,
  readDrawingStopConditions,
  readPermissionOverrides,
  resolveBudgets,
  sealMessages,
  generationProgressSettingsSchema,
  type BackendCapabilities,
  type ImagePart,
  type LlmPort,
  type LlmRole,
  type TextPart,
  type ImageBackend,
  type ToolSpec,
} from '@drawroid/core';
import {
  createLlm,
  llmConfigSchema,
  resolveRoles,
  sentImageMediaType,
  type LlmConfig,
  type RoleConfig,
} from '@drawroid/llm';
import { makePreview, PREVIEW_MEDIA_TYPE } from '@drawroid/storage-fs';
import sharp from 'sharp';
import { z } from 'zod';

import { BACKEND_LABELS, backendFactory } from './backend-factory.js';
import { backendOptions } from './backend-settings.js';
import { devWebUrl } from './dev-mode.js';
import {
  configSchema,
  DEFAULT_BACKEND_KIND,
  resolveBackendUrlWithSource,
  type Config,
} from './config.js';

/**
 * drawroid doctor: 実機（Forge / A1111・ローカルの LLM）で試す前に、つまずく所を一度に確かめる。
 * 確かめるのは、設定ファイル・バックエンド・LLM・web の配り先の4つ。何も書き換えない。
 */

// 返す形（DoctorReport）は api に置く: 設定の画面の「確かめる」（POST /api/doctor）と同じ形で返すため
export interface DoctorOptions {
  configPath: string;
  // CLI 引数。優先順位は起動と同じく CLI 引数 > config.json > 既定
  backendKind: BackendKind | undefined;
  backendUrl: string | undefined;
  // backendUrl をどこから得たか。省けば CLI 引数とみなす（走っている drawroid は、画面で繋ぎ直した値を渡す）
  backendUrlSource?: keyof typeof URL_SOURCES;
  // drawroid doctor から呼んだか、設定の画面の「確かめる」から呼んだか。doctor の打ち方の案内は CLI にだけ出す
  caller: 'cli' | 'screen';
  env: Readonly<Record<string, string | undefined>>;
  webRoot: () => string;
  backendTimeoutMs?: number;
  // ローカルの LLM は、初めの呼び出しでモデルを読み込むので長めに待つ
  llmTimeoutMs?: number;
}

const DEFAULT_BACKEND_TIMEOUT_MS = 10_000;
const DEFAULT_LLM_TIMEOUT_MS = 120_000;
const SAMPLE_NAMES = 3;
const REPLY_EXCERPT = 80;

/**
 * 設定の画面の「確かめる」（POST /api/doctor）。バックエンドは、いま使っている種類と URL（画面で繋ぎ直した値を含む）で確かめる
 */
export function screenDoctor({
  backendSettings,
  ...options
}: Omit<DoctorOptions, 'backendKind' | 'backendUrl' | 'backendUrlSource' | 'caller'> & {
  backendSettings: BackendSettingsPort;
}): DoctorPort {
  return {
    run: async () => {
      const inUse = await backendSettings.read();
      return runDoctor({
        ...options,
        backendKind: inUse.kind,
        backendUrl: inUse.url,
        backendUrlSource: inUse.urlSource,
        caller: 'screen',
      });
    },
  };
}

export async function runDoctor(options: DoctorOptions): Promise<DoctorReport> {
  const config = await checkConfig(options.configPath);
  const sections = [
    config.section,
    await checkBackend(options, config.backend),
    await checkLlm(options, config.llm, config.imageLongEdge ?? DEFAULT_BUDGET.imageLongEdge),
    checkWeb(options.webRoot, devWebUrl(options.env)),
  ];
  const secrets = apiKeyValues(config.llm, options.env);
  const redacted = sections.map((section) => ({
    title: section.title,
    items: section.items.map((item) => ({
      ...item,
      what: redact(item.what, secrets),
      ...(item.todo !== undefined && { todo: redact(item.todo, secrets) }),
    })),
  }));
  return {
    sections: redacted,
    lacking: redacted.flatMap((section) => section.items).filter((item) => !item.ok).length,
  };
}

export function formatDoctorReport(report: DoctorReport): string {
  const lines: string[] = [];
  for (const section of report.sections) {
    lines.push('', `■ ${section.title}`);
    for (const item of section.items) {
      lines.push(`  ${item.ok ? 'よい    ' : '足りない'}  ${item.what}`);
      if (item.todo !== undefined) lines.push(`            → ${item.todo}`);
    }
  }
  lines.push(
    '',
    report.lacking === 0
      ? 'すべてよい。drawroid を起動して試せる'
      : `足りないものが ${report.lacking} つある。「→」の行を上から順に直して、もう一度 drawroid doctor で確かめる`,
  );
  return `${lines.join('\n')}\n`;
}

// --- 設定ファイル -------------------------------------------------------------

type LlmState = { state: 'unset' } | { state: 'invalid' } | { state: 'ok'; config: LlmConfig };

interface ConfigCheck {
  section: DoctorSection;
  // 読めなかった欄は undefined にして、既定で続ける（起動と同じ値で確かめるため）
  backend: Config['backend'];
  llm: LlmState;
  /**
   * 見る役に渡す縮小版の長辺（予算の imageLongEdge）。設定ファイルが読めたときだけ載せる。無ければ既定で動く（起動と同じ）。
   * 読めない欄は readBudgetOverrides が外すので、そのときも既定になる
   */
  imageLongEdge?: number;
}

async function checkConfig(path: string): Promise<ConfigCheck> {
  const title = '設定ファイル';
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return {
        section: {
          title,
          items: [{ ok: true, what: `まだ無い（${path}）。無くても既定の値で動く` }],
        },
        backend: undefined,
        llm: { state: 'unset' },
      };
    }
    return {
      section: {
        title,
        items: [
          {
            ok: false,
            what: `読めない（${path}）: ${(error as Error).message}`,
            todo: 'ファイルの読み取りの権限を確かめる',
          },
        ],
      },
      backend: undefined,
      llm: { state: 'invalid' },
    };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    return {
      section: {
        title,
        items: [
          {
            ok: false,
            what: `JSON として読めない（${path}）: ${(error as Error).message}`,
            todo: '書き損じ（カンマ・引用符・括弧）を直す。直せなければ別の名前へ退け、画面の「設定」から入れ直す',
          },
        ],
      },
      backend: undefined,
      llm: { state: 'invalid' },
    };
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return {
      section: {
        title,
        items: [
          {
            ok: false,
            what: `中身が欄の集まり（{ … }）になっていない（${path}）`,
            todo: '{ } で囲んだ形に直す',
          },
        ],
      },
      backend: undefined,
      llm: { state: 'invalid' },
    };
  }
  const record = raw as Record<string, unknown>;
  const items: DoctorItem[] = [];

  const backend = configSchema.safeParse({ backend: record.backend });
  if (!backend.success) {
    items.push(
      ...backend.error.issues.map((issue) => ({
        ok: false,
        what: `${issuePath(issue.path)}: ${issue.message}`,
        todo: 'config.json の backend を直す。直すまで drawroid は起動しない',
      })),
    );
  }

  let llm: LlmState = { state: 'unset' };
  if (record.llm !== undefined) {
    const parsed = llmConfigSchema.safeParse(record.llm);
    if (parsed.success) {
      llm = { state: 'ok', config: parsed.data };
    } else {
      llm = { state: 'invalid' };
      items.push(
        ...parsed.error.issues.map((issue) => ({
          ok: false,
          what: `${issuePath(['llm', ...issue.path])}: ${issue.message}`,
          todo: '画面の「設定」の「LLM の設定」で入れ直すか、config.json の llm を直す。直すまで LLM は未設定として扱われる',
        })),
      );
    }
  }

  for (const { path: field, reason } of readBudgetOverrides(record.budgets).invalid) {
    items.push({
      ok: false,
      what: `budgets.${field}: ${reason}`,
      todo: '直すまで、この欄は既定の値で動く。画面の「設定」の「詳しい設定」で直せる',
    });
  }
  for (const { param, reason } of readPermissionOverrides(record.permissions).invalid) {
    items.push({
      ok: false,
      what: `permissions.${param}: ${reason}`,
      todo: '直すまで、この許可は既定に戻る。config.json の permissions を直す',
    });
  }
  if (record.generationProgress !== undefined) {
    const parsed = generationProgressSettingsSchema.safeParse(record.generationProgress);
    if (!parsed.success) {
      items.push(
        ...parsed.error.issues.map((issue) => ({
          ok: false,
          what: `${issuePath(['generationProgress', ...issue.path])}: ${issue.message}`,
          todo: '直すまで、生成の進み具合が読めない。config.json の generationProgress を直すか消す',
        })),
      );
    }
  }
  const stop = readDrawingStopConditions(record.conversations).problem;
  if (stop !== undefined) {
    items.push({
      ok: false,
      what: stop,
      todo: '直すまで、既定の止める条件で描く。config.json の conversations を直す',
    });
  }

  if (items.length === 0) items.push({ ok: true, what: `読める（${path}）` });
  return {
    section: { title, items },
    backend: backend.success ? backend.data.backend : undefined,
    llm,
    imageLongEdge: resolveBudgets(readBudgetOverrides(record.budgets).overrides).imageLongEdge,
  };
}

function issuePath(path: readonly PropertyKey[]): string {
  return path.map(String).join('.') || '(全体)';
}

// --- バックエンド -------------------------------------------------------------

const URL_SOURCES = {
  cli: '--backend-url で指定',
  config: 'config.json の backend.url',
  default: '既定',
} as const;

async function checkBackend(
  options: DoctorOptions,
  backendConfig: Config['backend'],
): Promise<DoctorSection> {
  const kind = options.backendKind ?? backendConfig?.kind ?? DEFAULT_BACKEND_KIND;
  const label = BACKEND_LABELS[kind];
  const resolved = resolveBackendUrlWithSource(options.backendUrl, { backend: backendConfig });
  const { url } = resolved;
  const source =
    options.backendUrl === undefined
      ? resolved.source
      : (options.backendUrlSource ?? resolved.source);
  const section: DoctorSection = { title: `画像のバックエンド（${label}）`, items: [] };
  const timeoutMs = options.backendTimeoutMs ?? DEFAULT_BACKEND_TIMEOUT_MS;
  const signal = () => AbortSignal.timeout(timeoutMs);
  const backend = backendFactory(kind)(backendOptions(url, backendConfig));
  const where = `${safeUrl(url)}（${URL_SOURCES[source]}）`;

  let capabilities: BackendCapabilities;
  try {
    capabilities = await backend.probe(signal());
  } catch (error) {
    section.items.push({
      ok: false,
      what: `繋がらない: ${where}: ${messageOf(error)}`,
      todo: backendTodo(error, label, source, options.caller),
    });
    return section;
  }
  section.items.push({ ok: true, what: `繋がる: ${where}` });

  section.items.push(await checkProduct(url, backendConfig, kind, signal));
  section.items.push(
    await checkCandidates(backend, 'checkpoint', 'チェックポイント', signal, {
      todo: `${label} の models/Stable-diffusion にチェックポイントを置き、${label} の画面でチェックポイントの一覧を読み直す`,
    }),
  );
  section.items.push(
    await checkCandidates(backend, 'sampler', 'サンプラ', signal, {
      todo: `${label} の版が古いか、起動に失敗している。${label} を起動したときの出力を確かめる`,
    }),
  );
  section.items.push(await checkControlNet(backend, capabilities, signal));
  return section;
}

function backendTodo(
  error: unknown,
  label: string,
  source: keyof typeof URL_SOURCES,
  caller: DoctorOptions['caller'],
): string {
  const kind = isBackendError(error) ? error.kind : undefined;
  switch (kind) {
    case 'unreachable':
      return `${label} を --api を付けて起動する。別の場所で動いているなら、--backend-url か画面の「設定」の「バックエンド」で URL を直す${
        // 既定の URL を見ているときだけ足す: drawroid doctor は待ち受け中の drawroid に聞かず、自分の引数と config.json から
        // URL を決める。起動にだけ付けた --backend-url は見えず、言われたとおりに直しても同じ所に戻ってくる。
        // 画面の「確かめる」には足さない: 待ち受け中の drawroid が使っている URL そのものを確かめるので、doctor の引数は関わらない
        caller === 'cli' && source === 'default'
          ? '。drawroid を --backend-url を付けて起動しているなら、drawroid doctor にも同じ --backend-url を付ける'
          : ''
      }`;
    case 'unauthorized':
      return `${label} を --api-auth を付けて起動しているなら、config.json の backend.auth に username と password を入れる`;
    case 'not_found':
      return `${label} を --api を付けて起動しているか、URL が ${label} の画面の URL（例: http://127.0.0.1:7860）かを確かめる`;
    case 'timeout':
      return `${label} が起動の途中か、ほかの仕事で手が塞がっている。少し待ってから、もう一度確かめる`;
    default:
      return `URL が Forge か A1111 を指しているかを確かめる`;
  }
}

// A1111 のアダプタが対応する版の下限（packages/backend-a1111 の fixtures の README）
const A1111_MIN = { major: 1, minor: 9 };

/**
 * どちらの製品か・版は何かを見る。
 * 製品は /sdapi/v1/sd-modules で見分ける: Forge にあって A1111 に無い口（packages/backend-a1111 の fixtures の README）。
 * 版は /internal/sysinfo の Version から読む。
 */
// 実機では未確認: /internal/sysinfo の Version の欄は A1111 1.6 以降・Forge のソース（modules/sysinfo.py）を読んだうえでの推測。
// 取れなければ「版は分からない」とだけ出し、足りないとはしない
async function checkProduct(
  url: string,
  backendConfig: Config['backend'],
  kind: BackendKind,
  signal: () => AbortSignal,
): Promise<DoctorItem> {
  const headers = authHeaders(backendConfig);
  const modules = await fetchStatus(new URL('/sdapi/v1/sd-modules', url), headers, signal());
  const product: BackendKind | undefined =
    modules.status === 200 ? 'forge' : modules.status === 404 ? 'a1111' : undefined;
  const version = await readVersion(new URL('/internal/sysinfo', url), headers, signal());
  const versionText = version === undefined ? '版は分からない' : `版 ${version}`;
  if (product === undefined) {
    return {
      ok: true,
      what: `製品を見分けられなかった（${versionText}）。設定どおり ${BACKEND_LABELS[kind]} として扱う`,
    };
  }
  if (product !== kind) {
    return {
      ok: false,
      what: `${BACKEND_LABELS[product]} が動いている（${versionText}）が、${BACKEND_LABELS[kind]} として繋ごうとしている`,
      todo: `--backend ${product} を付けて起動するか、config.json の backend.kind を "${product}" にする`,
    };
  }
  if (product === 'a1111' && version !== undefined) {
    const match = /^v?(\d+)\.(\d+)/.exec(version);
    if (
      match !== null &&
      (Number(match[1]) < A1111_MIN.major ||
        (Number(match[1]) === A1111_MIN.major && Number(match[2]) < A1111_MIN.minor))
    ) {
      return {
        ok: false,
        what: `A1111 の${versionText}は古い（${A1111_MIN.major}.${A1111_MIN.minor} 以降に対応）`,
        todo: `A1111 を ${A1111_MIN.major}.${A1111_MIN.minor} 以降に上げる`,
      };
    }
  }
  return { ok: true, what: `${BACKEND_LABELS[product]}（${versionText}）` };
}

function authHeaders(backendConfig: Config['backend']): Record<string, string> {
  const auth = backendConfig?.auth;
  if (auth === undefined) return {};
  const token = Buffer.from(`${auth.username}:${auth.password}`).toString('base64');
  return { authorization: `Basic ${token}` };
}

async function fetchStatus(
  url: URL,
  headers: Record<string, string>,
  signal: AbortSignal,
): Promise<{ status: number | undefined }> {
  try {
    const response = await fetch(url, { headers, signal });
    await response.body?.cancel();
    return { status: response.status };
  } catch {
    return { status: undefined };
  }
}

async function readVersion(
  url: URL,
  headers: Record<string, string>,
  signal: AbortSignal,
): Promise<string | undefined> {
  try {
    const response = await fetch(url, { headers, signal });
    if (response.status !== 200) {
      await response.body?.cancel();
      return undefined;
    }
    const parsed = z.looseObject({ Version: z.string().min(1) }).safeParse(await response.json());
    return parsed.success ? parsed.data.Version : undefined;
  } catch {
    return undefined;
  }
}

async function checkCandidates(
  backend: ImageBackend,
  kind: 'checkpoint' | 'sampler',
  name: string,
  signal: () => AbortSignal,
  { todo }: { todo: string },
): Promise<DoctorItem> {
  try {
    const candidates = await backend.listCandidates(kind, signal());
    if (candidates.length === 0) return { ok: false, what: `${name}が1つも無い`, todo };
    return { ok: true, what: `${name}: ${countWithSamples(candidates)}` };
  } catch (error) {
    return {
      ok: false,
      what: `${name}の一覧を取れない: ${messageOf(error)}`,
      todo: 'バックエンドの出力にエラーが出ていないかを確かめる',
    };
  }
}

async function checkControlNet(
  backend: ImageBackend,
  capabilities: BackendCapabilities,
  signal: () => AbortSignal,
): Promise<DoctorItem> {
  // ControlNet は無くても描ける: 使えないときも「よい」とし、理由だけを見せる
  const unavailable = capabilities.unavailable.find((entry) => entry.feature === 'controlnet');
  if (unavailable !== undefined) {
    return {
      ok: true,
      what: `ControlNet は使えない（使わないなら、このままでよい）: ${unavailable.reason}`,
    };
  }
  try {
    const [models, modules] = await Promise.all([
      backend.listCandidates('controlnetModel', signal()),
      backend.listCandidates('controlnetModule', signal()),
    ]);
    const units = capabilities.limits?.controlnetUnits;
    return {
      ok: true,
      what:
        `ControlNet: モデル ${countWithSamples(models)}、前処理 ${modules.length} 件` +
        (units === undefined ? '' : `、1回に ${units} ユニットまで`) +
        (models.length === 0 ? '（使うなら、モデルを models/ControlNet に置く）' : ''),
    };
  } catch (error) {
    return {
      ok: false,
      what: `ControlNet の候補を取れない: ${messageOf(error)}`,
      todo: 'バックエンドの出力にエラーが出ていないかを確かめる',
    };
  }
}

function countWithSamples(candidates: readonly { name: string }[]): string {
  const samples = candidates.slice(0, SAMPLE_NAMES).map((candidate) => candidate.name);
  return `${candidates.length} 件${samples.length === 0 ? '' : `（例: ${samples.join('、')}）`}`;
}

// --- LLM ----------------------------------------------------------------------

const PING_TOOL: ToolSpec = {
  name: 'doctor_ping',
  description: '接続の確かめ。頼まれたら、引数なしで1回だけ呼ぶ',
  inputSchema: z.object({}),
};
const PING_SYSTEM =
  'これは drawroid の接続の確かめです。doctor_ping を引数なしで1回だけ呼んでください。文では返さないでください。';
const PING_USER = '確かめのため、doctor_ping を呼んでください。';

async function checkLlm(
  options: DoctorOptions,
  llm: LlmState,
  imageLongEdge: number,
): Promise<DoctorSection> {
  const section: DoctorSection = { title: 'LLM', items: [] };
  if (llm.state === 'unset') {
    section.items.push({
      ok: false,
      what: 'まだ設定していない',
      todo: 'drawroid を起動し、画面の「設定」の「LLM の設定」（/settings#llm）で provider と考える役のモデルを入れる',
    });
    return section;
  }
  if (llm.state === 'invalid') {
    section.items.push({
      ok: false,
      what: 'config.json の llm が読めないので確かめられない（「設定ファイル」の項を見る）',
      todo: '「設定ファイル」の項の llm の欄を直す',
    });
    return section;
  }
  const { config } = llm;
  for (const [name, provider] of Object.entries(config.providers)) {
    const where = provider.baseURL === undefined ? '' : `、${safeUrl(provider.baseURL)}`;
    const head = `provider ${name}（${provider.type}${where}）`;
    // 鍵の値は出さない: 環境変数の名前と、入っているかだけ
    if (provider.apiKeyEnv === undefined) {
      section.items.push({
        ok: provider.type === 'openai-compatible',
        what: `${head}: API キーの環境変数を指していない`,
        ...(provider.type !== 'openai-compatible' && {
          todo: `LLM の設定で、provider ${name} の apiKeyEnv に API キーの環境変数の名前を入れる`,
        }),
      });
    } else if ((options.env[provider.apiKeyEnv] ?? '') === '') {
      section.items.push({
        ok: false,
        what: `${head}: API キーの環境変数 ${provider.apiKeyEnv} が入っていない`,
        todo: `${provider.apiKeyEnv} に API キーを入れた端末から drawroid を起動する`,
      });
    } else {
      section.items.push({
        ok: true,
        what: `${head}: API キーの環境変数 ${provider.apiKeyEnv} は入っている`,
      });
    }
  }
  section.items.push(...(await roundTrips(options, config, imageLongEdge)));
  return section;
}

const ROLE_NAMES = { think: '考える役', judge: '見る役', talk: '話す役' } as const;

/**
 * 役ごとに1往復を確かめる。話す役はツールを1つ呼ばせ、考える役・見る役は構造化出力で1往復する。見る役には小さな画像を1枚渡す。
 * 考える役と見る役は、割り当て（provider とモデル）と構造化出力の出し方が同じなら、見る役の確かめ（画像あり）1回で済ませる
 */
// 見る役は、話す役と同じ割り当てでも別に確かめる: 話す役の確かめは画像を渡さないので、画像を読めないモデルを見逃すため。
// 考える役を話す役の確かめにまとめない: 考える役はツールを呼ばず構造化出力で答えるので、ツールの1往復では、ジョブで使う出し方を確かめられないため
async function roundTrips(
  options: DoctorOptions,
  config: LlmConfig,
  imageLongEdge: number,
): Promise<DoctorItem[]> {
  const roles = resolveRoles(config);
  const thinkWithJudge =
    roles.think.provider === roles.judge.provider &&
    roles.think.model === roles.judge.model &&
    roles.think.structuredOutput === roles.judge.structuredOutput;
  const items = [await toolRoundTrip(options, config)];
  // 考える役 → 見る役の順に出す
  if (!thinkWithJudge) {
    items.push(await structuredRoundTrip(options, config, ['think'], 'think', imageLongEdge));
  }
  items.push(
    await structuredRoundTrip(
      options,
      config,
      thinkWithJudge ? ['think', 'judge'] : ['judge'],
      'judge',
      imageLongEdge,
    ),
  );
  return items;
}

function rolesLabel(group: readonly LlmRole[]): string {
  return group.map((role) => ROLE_NAMES[role]).join('・');
}

/**
 * 話す役にツールを呼ばせる回数。全部の回で呼べたときだけ「よい」にし、崩れた回で止める
 */
// 1回で決めない: 小さいモデルは同じ頼み方でも、呼んだり文で返したりする。話す役は会話の1ターンで何度もツールを呼ぶので、
// 1回通っただけで「よい」と出すと、会話で崩れるモデルを通してしまうため。
// 崩れた回で止める: 結果はもう「足りない」と決まるので、崩れるモデルで待ち時間を延ばさないため
const TALK_PING_ROUNDS = 3;

type ToolPing = { called: boolean; text: string; thought: boolean; failure?: string };

async function toolPingOnce(llm: LlmPort, timeoutMs: number): Promise<ToolPing> {
  const ping: ToolPing = { called: false, text: '', thought: false };
  try {
    for await (const part of llm.streamStep({
      role: 'talk',
      messages: sealMessages(PING_SYSTEM, [{ type: 'text', text: PING_USER }], {
        estimatedInputTokens: 0,
        inputTokenLimit: 0,
        notes: [],
      }),
      tools: [PING_TOOL],
      signal: AbortSignal.timeout(timeoutMs),
    })) {
      if (part.type === 'tool-call' && part.name === PING_TOOL.name) ping.called = true;
      else if (part.type === 'text-delta') ping.text += part.text;
      else if (part.type === 'reasoning-delta') ping.thought = true;
      else if (part.type === 'finish' && part.failure !== undefined) ping.failure = part.failure;
    }
  } catch (error) {
    ping.failure =
      error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')
        ? `${Math.round(timeoutMs / 1000)} 秒待っても返事が終わらなかった`
        : messageOf(error);
  }
  return ping;
}

async function toolRoundTrip(options: DoctorOptions, config: LlmConfig): Promise<DoctorItem> {
  const role = resolveRoles(config).talk;
  const who = `${ROLE_NAMES.talk}（${role.provider} の ${role.model}、toolCalling: ${role.toolCalling}、reasoning: ${role.reasoning}）`;
  const timeoutMs = options.llmTimeoutMs ?? DEFAULT_LLM_TIMEOUT_MS;
  const started = Date.now();
  let thought = false;
  let llm: LlmPort;
  try {
    llm = createLlm(config, { env: options.env });
  } catch (error) {
    const failure = messageOf(error);
    return {
      ok: false,
      what: `${who}と1往復できない: ${failure}`,
      todo: llmTodo(failure, role.toolCalling === 'native' ? TOOL_CALLING_HINT : ''),
    };
  }
  for (let round = 1; round <= TALK_PING_ROUNDS; round += 1) {
    const { called, text, failure, ...ping } = await toolPingOnce(llm, timeoutMs);
    thought ||= ping.thought;
    const at = `${TALK_PING_ROUNDS}回のうち${round}回目`;
    if (failure !== undefined) {
      return {
        ok: false,
        what: `${who}と1往復できない（${at}）: ${failure}`,
        todo: llmTodo(failure, role.toolCalling === 'native' ? TOOL_CALLING_HINT : ''),
      };
    }
    if (!called) {
      const said = text.trim();
      return {
        ok: false,
        what:
          said === ''
            ? `${who}が、${at}で、ツールを呼ばず、文も返さなかった（空の応答）`
            : `${who}が、${at}で、ツールを呼ばずに文で返した: 「${clip(said, REPLY_EXCERPT)}」`,
        todo: notCalledTodo(role),
      };
    }
  }
  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  const thinking =
    role.reasoning === 'none' ? '' : thought ? '。思考を受け取った' : '。思考は流れてこなかった';
  return {
    ok: true,
    what: `${who}と、${TALK_PING_ROUNDS}回続けて1往復できた（計 ${seconds} 秒${thinking}）`,
  };
}

// json でも structuredOutput が native なら、先に json を勧める: llama.cpp などは、native の構造化出力のスキーマを
// 出力の縛りにだけ使い、指示文に載せない。モデルからは、どのツールがあり何をするのかが見えず、返答に逃げる
function notCalledTodo(role: RoleConfig): string {
  if (role.toolCalling === 'native') {
    return 'ツールの呼び出しに弱いモデルかもしれない。LLM の設定で、話す役（無ければ考える役）の toolCalling を json にする';
  }
  if (role.structuredOutput === 'native') {
    return 'LLM の設定で、話す役（無ければ考える役）の structuredOutput を json にする（native では、サーバによってはツールの一覧がモデルに見えない）';
  }
  return '指示に従えるモデルに変える';
}

const TOOL_CALLING_HINT = '。ツールの呼び出しに弱いモデルなら、toolCalling を json にする';
const STRUCTURED_HINT =
  '。JSON をうまく出せないモデルなら、structuredOutput を json か text にする';

const THINK_PING_SCHEMA = z.object({ ok: z.boolean() });
const JUDGE_PING_SCHEMA = z.object({ color: z.string().min(1) });
const STRUCTURED_SYSTEM =
  'これは drawroid の接続の確かめです。指示どおりの JSON だけを返してください。';

/**
 * 画像を読めるかを確かめるための、赤一色の画像。ジョブが見る役に渡す縮小版と同じ変換を通し、同じ大きさにする:
 * 元は長辺ぶんの正方形で作る（縮小版は元より大きくしないので、小さく作ると、予算の長辺によらず小さいまま渡るため）。
 * 大きな画像で落ちるサーバ（入力の上限が小さいなど）を、ジョブを走らせる前に見つけるため
 */
async function probeImage(longEdge: number): Promise<ImagePart> {
  const source = await sharp({
    create: {
      width: longEdge,
      height: longEdge,
      channels: 3,
      background: { r: 200, g: 40, b: 40 },
    },
  })
    .png()
    .toBuffer();
  return {
    type: 'image',
    key: 'doctor-probe',
    data: await makePreview(source, longEdge),
    mediaType: PREVIEW_MEDIA_TYPE,
  };
}

async function structuredOnce(
  options: DoctorOptions,
  config: LlmConfig,
  role: 'think' | 'judge',
  image: ImagePart | undefined,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const timeoutMs = options.llmTimeoutMs ?? DEFAULT_LLM_TIMEOUT_MS;
  const user: (TextPart | ImagePart)[] =
    image === undefined
      ? [
          {
            type: 'text',
            text:
              role === 'judge'
                ? 'color に "red" を入れた JSON を返してください。'
                : 'ok に true を入れた JSON を返してください。',
          },
        ]
      : [
          {
            type: 'text',
            text: '画像の主な色を英語の1語で、color に入れた JSON を返してください。',
          },
          image,
        ];
  try {
    const outcome = await createLlm(config, { env: options.env }).generateStructured<unknown>({
      role,
      purpose: role,
      schema: role === 'judge' ? JUDGE_PING_SCHEMA : THINK_PING_SCHEMA,
      messages: sealMessages(STRUCTURED_SYSTEM, user, {
        estimatedInputTokens: 0,
        inputTokenLimit: 0,
        notes: [],
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    return outcome.ok ? { ok: true } : { ok: false, reason: outcome.reason };
  } catch (error) {
    return {
      ok: false,
      reason:
        error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')
          ? `${Math.round(timeoutMs / 1000)} 秒待っても返事が終わらなかった`
          : messageOf(error),
    };
  }
}

async function structuredRoundTrip(
  options: DoctorOptions,
  config: LlmConfig,
  group: readonly LlmRole[],
  role: 'think' | 'judge',
  /** 見る役に渡す縮小版の長辺（設定した予算）。本番と同じ大きさで確かめる */
  imageLongEdge: number,
): Promise<DoctorItem> {
  const rc = resolveRoles(config)[role];
  const who = `${rolesLabel(group)}（${rc.provider} の ${rc.model}、structuredOutput: ${rc.structuredOutput}、reasoning: ${rc.reasoning}）`;
  const started = Date.now();
  if (role === 'judge') {
    if (!rc.imageInput) {
      return {
        ok: false,
        what: `${who}は、LLM の設定で画像を読めない（imageInput: false）とされている。見る役は画像を見て評価する`,
        todo: '見る役に画像を読めるモデルを割り当て、LLM の設定で imageInput を有効にする',
      };
    }
    const withImage = await structuredOnce(options, config, role, await probeImage(imageLongEdge));
    if (withImage.ok) {
      const seconds = ((Date.now() - started) / 1000).toFixed(1);
      return { ok: true, what: `${who}と、画像を1枚渡して1往復できた（${seconds} 秒）` };
    }
    // 画像なしで通るなら、画像が原因と分かる
    const withoutImage = await structuredOnce(options, config, role, undefined);
    if (withoutImage.ok) {
      return {
        ok: false,
        what: `${who}は、画像（${sentImageMediaType(PREVIEW_MEDIA_TYPE)}。ジョブが見る役に渡すのと同じ形式）を渡すと返事が来ない（画像なしなら返事が来る）。このモデルは画像を読めない可能性がある（読めるモデルなら、サーバがこの形式を読めない）: ${withImage.reason}`,
        todo: '見る役に、画像を読めるモデル（vision に対応したもの）を割り当てる。LLM のサーバ側で、画像の入力やこの形式を読めるようにする設定が要ることもある',
      };
    }
    return {
      ok: false,
      what: `${who}と1往復できない: ${withoutImage.reason}`,
      todo: llmTodo(withoutImage.reason, STRUCTURED_HINT),
    };
  }
  const result = await structuredOnce(options, config, role, undefined);
  if (!result.ok) {
    return {
      ok: false,
      what: `${who}と1往復できない: ${result.reason}`,
      todo: llmTodo(result.reason, STRUCTURED_HINT),
    };
  }
  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  return { ok: true, what: `${who}と1往復できた（${seconds} 秒）` };
}

function llmTodo(failure: string, hint: string): string {
  if (/ECONNREFUSED|ENOTFOUND|EAI_AGAIN|fetch failed|Cannot connect/i.test(failure)) {
    return 'LLM のサーバを起動するか、LLM の設定の provider の baseURL を直す';
  }
  if (/401|403|unauthori[sz]ed|api key|apikey/i.test(failure)) {
    return 'API キーの環境変数に、正しいキーが入っているかを確かめる';
  }
  if (/404|not found|does not exist/i.test(failure)) {
    return 'モデルの名前が、LLM のサーバにあるものと合っているかを確かめる';
  }
  return `baseURL・モデルの名前・API キーを確かめる${hint}`;
}

// --- web の配り先 -------------------------------------------------------------

function checkWeb(webRoot: () => string, devUrl: string | undefined): DoctorSection {
  const title = 'web の配り先';
  if (devUrl !== undefined) {
    return { title, items: [{ ok: true, what: `開発中は Vite（${devUrl}）が画面を配っている` }] };
  }
  let root: string;
  try {
    root = webRoot();
  } catch (error) {
    return {
      title,
      items: [
        {
          ok: false,
          what: `見つからない: ${messageOf(error)}`,
          todo: 'drawroid を入れ直す（手元で作ったなら pnpm build で web を作る）',
        },
      ],
    };
  }
  if (!existsSync(join(root, 'index.html'))) {
    return {
      title,
      items: [
        {
          ok: false,
          what: `${root} に index.html が無い`,
          todo: 'drawroid を入れ直す（手元で作ったなら pnpm build で web を作る）',
        },
      ],
    };
  }
  return { title, items: [{ ok: true, what: `ある（${root}）` }] };
}

// --- 共通 ---------------------------------------------------------------------

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}

// URL に書いた利用者名・パスワード（http://user:pass@host）は出さない
function safeUrl(raw: string): string {
  try {
    const url = new URL(raw);
    url.username = '';
    url.password = '';
    return url.toString().replace(/\/$/, '');
  } catch {
    return raw;
  }
}

function apiKeyValues(llm: LlmState, env: DoctorOptions['env']): string[] {
  if (llm.state !== 'ok') return [];
  return Object.values(llm.config.providers)
    .map((provider) => (provider.apiKeyEnv === undefined ? '' : (env[provider.apiKeyEnv] ?? '')))
    .filter((value) => value.length >= 4);
}

// 念のため、エラーの文に鍵の値が混ざっても出さない
function redact(text: string, secrets: readonly string[]): string {
  return secrets.reduce((out, secret) => out.split(secret).join('（鍵）'), text);
}
