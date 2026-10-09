import { LlmNotConfiguredError, type StopConditionParser } from '@drawroid/api';
import { defaultCallId, parseStopConditions, type JobStore, type LlmPort } from '@drawroid/core';

export type StopConditionParserOptions = {
  store: Pick<JobStore, 'writeLlmCall'>;
  /** 呼ぶたびに今の LLM を引く */
  currentLlm: () => LlmPort | undefined;
  now?: () => Date;
};

// LLM を作成時に束ねない: 設定は PUT /api/settings/llm で実行中に変わるため、呼ぶたびに今のものを引く
export function createStopConditionParser(
  options: StopConditionParserOptions,
): StopConditionParser {
  const now = options.now ?? (() => new Date());
  return {
    async parse(text, signal) {
      const llm = options.currentLlm();
      if (llm === undefined) throw new LlmNotConfiguredError();
      return parseStopConditions({
        llm,
        text,
        signal,
        now,
        newCallId: defaultCallId,
        record: (record) => options.store.writeLlmCall(record),
      });
    },
  };
}
