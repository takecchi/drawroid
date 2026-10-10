import type { LlmSettingsInput, LlmSettingsResponse } from '@drawroid/swr';

export type StoredLlmConfig = NonNullable<LlmSettingsResponse['config']>;
type StoredProvider = StoredLlmConfig['providers'][string];
type StoredRole = StoredLlmConfig['roles']['think'];

export const PROVIDER_TYPES = ['openai-compatible', 'openai', 'anthropic'] as const;
export type ProviderType = (typeof PROVIDER_TYPES)[number];
export const STRUCTURED_OUTPUT_MODES = ['native', 'json', 'text'] as const;
export type StructuredOutputMode = (typeof STRUCTURED_OUTPUT_MODES)[number];
/** native = サーバが分けて返す思考 / think-tag = 本文の <think> を思考に分ける / none = 受け取らない */
export const REASONING_MODES = ['native', 'think-tag', 'none'] as const;
export type ReasoningMode = (typeof REASONING_MODES)[number];
/** native = モデルのツール呼び出し / json = ツールの呼び出しを構造化出力で代える（呼び出しに弱いモデルの逃げ道） */
export const TOOL_CALLING_MODES = ['native', 'json'] as const;
export type ToolCallingMode = (typeof TOOL_CALLING_MODES)[number];

// 文字列で持つ: 入力の途中の空欄や数字でない文字を、数に直すと消えてしまうため
export interface ProviderRow {
  key: string;
  type: ProviderType;
  baseURL: string;
  apiKeyEnv: string;
}

export interface RoleValues {
  provider: string;
  /** provider を画面が自動で持たせたか（2つ目の名前が付いたとき）。人が選んだ値と分けるための画面の中だけの印で、保存しない */
  providerPinned: boolean;
  model: string;
  contextTokens: string;
  maxOutputTokens: string;
  structuredOutput: StructuredOutputMode;
  reasoning: ReasoningMode;
  toolCalling: ToolCallingMode;
  imageInput: boolean;
}

export interface LlmSettingsFormValues {
  providers: ProviderRow[];
  think: RoleValues;
  /** 見る役も考える役と同じモデルを使う（roles.judge を省く） */
  judgeSameAsThink: boolean;
  judge: RoleValues;
  /** 話す役も考える役と同じモデルを使う（roles.talk を省く） */
  talkSameAsThink: boolean;
  talk: RoleValues;
  /** スキーマに合わない出力を出し直させる回数（空ならサーバの既定） */
  validationRetries: string;
  /** 繋がらない・429 などのときに呼び直す回数（空ならサーバの既定） */
  networkRetries: string;
  /** LLM が何も返さないまま待つ上限（秒。空ならサーバの既定） */
  callTimeoutSeconds: string;
}

export function emptyProviderRow(): ProviderRow {
  return { key: '', type: 'openai-compatible', baseURL: '', apiKeyEnv: '' };
}

function roleToValues(role: StoredRole | undefined): RoleValues {
  return {
    provider: role?.provider ?? '',
    providerPinned: false,
    model: role?.model ?? '',
    contextTokens: role?.contextTokens === undefined ? '' : String(role.contextTokens),
    maxOutputTokens: role?.maxOutputTokens === undefined ? '' : String(role.maxOutputTokens),
    structuredOutput: role?.structuredOutput ?? 'native',
    reasoning: role?.reasoning ?? 'native',
    toolCalling: role?.toolCalling ?? 'native',
    imageInput: role?.imageInput ?? true,
  };
}

function providerToRow(key: string, provider: StoredProvider): ProviderRow {
  return {
    key,
    type: provider.type,
    baseURL: provider.baseURL ?? '',
    apiKeyEnv: provider.apiKeyEnv ?? '',
  };
}

/** 保存されている設定を、画面の欄の値にする。まだ無ければ、最初の設定のための空の欄にする */
export function toFormValues(config: StoredLlmConfig | null): LlmSettingsFormValues {
  if (config === null) {
    return {
      providers: [emptyProviderRow()],
      think: roleToValues(undefined),
      judgeSameAsThink: true,
      judge: roleToValues(undefined),
      talkSameAsThink: true,
      talk: roleToValues(undefined),
      validationRetries: '',
      networkRetries: '',
      callTimeoutSeconds: '',
    };
  }
  return {
    providers: Object.entries(config.providers).map(([key, provider]) =>
      providerToRow(key, provider),
    ),
    think: roleToValues(config.roles.think),
    judgeSameAsThink: config.roles.judge === undefined,
    judge: roleToValues(config.roles.judge ?? config.roles.think),
    talkSameAsThink: config.roles.talk === undefined,
    talk: roleToValues(config.roles.talk ?? config.roles.think),
    validationRetries: String(config.validationRetries),
    networkRetries: String(config.networkRetries),
    callTimeoutSeconds: String(config.callTimeoutSeconds),
  };
}

// 空欄は送らない: 既定値のある欄は、省けばサーバの既定値になるため
function optionalNumber(text: string): number | undefined {
  const trimmed = text.trim();
  return trimmed === '' ? undefined : Number(trimmed);
}

/** 定義した provider の名前（空と重なりを除き、並べた順） */
export function definedProviderNames(providers: readonly ProviderRow[]): string[] {
  return [...new Set(providers.map((row) => row.key.trim()).filter((name) => name !== ''))];
}

/**
 * 2つ以上の行に付いた provider の名前（前後の空白を除いて比べる）。無ければ undefined。
 * サーバに任せずに画面で見る: 保存する形は名前を鍵にしたオブジェクトで、重なりは送る前に後の行で上書きされて届かないため
 */
export function duplicatedProviderName(providers: readonly ProviderRow[]): string | undefined {
  const seen = new Set<string>();
  for (const row of providers) {
    const name = row.key.trim();
    if (name === '') continue;
    if (seen.has(name)) return name;
    seen.add(name);
  }
  return undefined;
}

/** 名前・接続先・鍵の変数のどれも入れていない行（「provider を足す」を押しただけの行）。保存では数えない */
function isBlankProviderRow(row: ProviderRow): boolean {
  return row.key.trim() === '' && row.baseURL.trim() === '' && row.apiKeyEnv.trim() === '';
}

/**
 * 名前が無いのに接続先か鍵の変数が入っている行の、1から数えた番号。無ければ undefined。
 * 黙って捨てない: 入れた接続先が保存されずに消えるため。サーバに任せない: 名前を鍵にして送るので、どの行かが文から読めないため
 */
export function unnamedProviderRowNumber(providers: readonly ProviderRow[]): number | undefined {
  const index = providers.findIndex((row) => row.key.trim() === '' && !isBlankProviderRow(row));
  return index === -1 ? undefined : index + 1;
}

/** 役が使う provider。まだ選んでいなくて、定義した provider が1つだけなら、それを選んだことにする */
export function roleProviderOf(role: RoleValues, names: readonly string[]): string {
  const chosen = role.provider.trim();
  return chosen === '' && names.length === 1 ? (names[0] ?? '') : chosen;
}

/**
 * provider の並びを差し替えた値。名前が1つだけだったところに2つ目の名前が付くなら、既定で選んである provider
 * （1つだけのときの名前）を役の値として持たせる。持たせないと、2つ目の名前が付いた途端に既定が効かなくなり、
 * 選んで見えていた役が「選ぶ」に戻るため。名前が1つ以下に戻ったら、自動で持たせた値は外して既定に戻す
 */
function withProviders(
  values: LlmSettingsFormValues,
  providers: ProviderRow[],
): LlmSettingsFormValues {
  const before = definedProviderNames(values.providers);
  // 名前が1つのまま変わるとき（打ち直し）は持たせない: 持たせると、1文字打つごとに古い名前が「（定義に無い）」で残るため
  if (definedProviderNames(providers).length < 2) {
    return {
      ...values,
      providers,
      think: unpinned(values.think),
      judge: unpinned(values.judge),
      talk: unpinned(values.talk),
    };
  }
  if (before.length !== 1) return { ...values, providers };
  const pin = (role: RoleValues): RoleValues =>
    role.provider.trim() === ''
      ? { ...role, provider: before[0] ?? '', providerPinned: true }
      : role;
  return {
    ...values,
    providers,
    think: pin(values.think),
    judge: pin(values.judge),
    talk: pin(values.talk),
  };
}

// 人が選んだ値は外さない: 定義に無くなっても「（定義に無い）」で見せ、保存でサーバが理由付きで断る
function unpinned(role: RoleValues): RoleValues {
  return role.providerPinned ? { ...role, provider: '', providerPinned: false } : role;
}

export function withProviderAdded(values: LlmSettingsFormValues): LlmSettingsFormValues {
  return withProviders(values, [...values.providers, emptyProviderRow()]);
}

export function withProviderChanged(
  values: LlmSettingsFormValues,
  index: number,
  row: ProviderRow,
): LlmSettingsFormValues {
  return withProviders(
    values,
    values.providers.map((current, i) => (i === index ? row : current)),
  );
}

export function withProviderRemoved(
  values: LlmSettingsFormValues,
  index: number,
): LlmSettingsFormValues {
  return withProviders(
    values,
    values.providers.filter((_, i) => i !== index),
  );
}

function buildRole(
  values: RoleValues,
  names: readonly string[],
): LlmSettingsInput['roles']['think'] {
  const contextTokens = optionalNumber(values.contextTokens);
  const maxOutputTokens = optionalNumber(values.maxOutputTokens);
  return {
    provider: roleProviderOf(values, names),
    model: values.model.trim(),
    ...(contextTokens === undefined ? {} : { contextTokens }),
    ...(maxOutputTokens === undefined ? {} : { maxOutputTokens }),
    structuredOutput: values.structuredOutput,
    reasoning: values.reasoning,
    toolCalling: values.toolCalling,
    imageInput: values.imageInput,
  };
}

function buildProvider(row: ProviderRow): LlmSettingsInput['providers'][string] {
  const baseURL = row.baseURL.trim();
  const apiKeyEnv = row.apiKeyEnv.trim();
  return {
    type: row.type,
    ...(baseURL === '' ? {} : { baseURL }),
    ...(apiKeyEnv === '' ? {} : { apiKeyEnv }),
  } as LlmSettingsInput['providers'][string];
}

/** 画面の欄の値から、保存する設定を組む */
// 形の誤り（接続先の URL・数・provider の有無）は、ここで直さずにそのまま送る: サーバの検証が理由付きの 400 を返し、画面はそれを出す
export function buildLlmSettings(values: LlmSettingsFormValues): LlmSettingsInput {
  const providers = Object.fromEntries(
    values.providers
      .filter((row) => !isBlankProviderRow(row))
      .map((row) => [row.key.trim(), buildProvider(row)]),
  );
  const names = definedProviderNames(values.providers);
  const think = buildRole(values.think, names);
  const validationRetries = optionalNumber(values.validationRetries);
  const networkRetries = optionalNumber(values.networkRetries);
  const callTimeoutSeconds = optionalNumber(values.callTimeoutSeconds);
  return {
    ...(validationRetries === undefined ? {} : { validationRetries }),
    ...(networkRetries === undefined ? {} : { networkRetries }),
    ...(callTimeoutSeconds === undefined ? {} : { callTimeoutSeconds }),
    providers,
    roles: {
      think,
      ...(values.judgeSameAsThink ? {} : { judge: buildRole(values.judge, names) }),
      ...(values.talkSameAsThink ? {} : { talk: buildRole(values.talk, names) }),
    },
  };
}
