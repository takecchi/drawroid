import type { StopConditionsDraft } from '@drawroid/core';

/** LLM が未設定で、自然言語を変換できないことを表す。API は 409 で返す */
export class LlmNotConfiguredError extends Error {
  constructor(message = 'LLM が未設定') {
    super(message);
    this.name = 'LlmNotConfiguredError';
  }
}

export interface StopConditionParser {
  /** LLM が未設定なら LlmNotConfiguredError を投げる。何も確定させない */
  parse(text: string, signal: AbortSignal): Promise<StopConditionsDraft>;
}
