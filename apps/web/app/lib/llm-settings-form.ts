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
}

export function emptyProviderRow(): ProviderRow {
  return { key: '', type: 'openai-compatible', baseURL: '', apiKeyEnv: '' };
}

function roleToValues(role: StoredRole | undefined): RoleValues {
  return {
    provider: role?.provider ?? '',
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
  };
}

// 空欄は送らない: 既定値のある欄は、省けばサーバの既定値になるため
function optionalNumber(text: string): number | undefined {
  const trimmed = text.trim();
  return trimmed === '' ? undefined : Number(trimmed);
}

function buildRole(values: RoleValues): LlmSettingsInput['roles']['think'] {
  const contextTokens = optionalNumber(values.contextTokens);
  const maxOutputTokens = optionalNumber(values.maxOutputTokens);
  return {
    provider: values.provider.trim(),
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

/**
 * 画面の欄の値から、保存する設定を組む。画面に出していない欄（再試行の回数など）は、保存されていた値を保つ。
 */
// 形の誤り（接続先の URL・数・provider の有無）は、ここで直さずにそのまま送る: サーバの検証が理由付きの 400 を返し、画面はそれを出す
export function buildLlmSettings(
  values: LlmSettingsFormValues,
  previous: StoredLlmConfig | null,
): LlmSettingsInput {
  const providers = Object.fromEntries(
    values.providers.map((row) => [row.key.trim(), buildProvider(row)]),
  );
  const think = buildRole(values.think);
  return {
    ...(previous === null
      ? {}
      : {
          validationRetries: previous.validationRetries,
          networkRetries: previous.networkRetries,
        }),
    providers,
    roles: {
      think,
      ...(values.judgeSameAsThink ? {} : { judge: buildRole(values.judge) }),
      ...(values.talkSameAsThink ? {} : { talk: buildRole(values.talk) }),
    },
  };
}
