import type { detectContextTokens } from '@drawroid/llm';

export type Detection = Awaited<ReturnType<typeof detectContextTokens>>;

/**
 * LLM の設定の保存のときに読んだ窓を、そのあとの configureLlm へ渡すために、読んだ入力の設定と組で1つだけ覚える。
 * 入力と同じオブジェクト（===）で聞かれたときだけ返し、聞かれたら忘れる。
 */
// 中身が同じかではなく同じオブジェクトかで見る: 保存の検証に使った設定がそのまま write へ渡るので、別の経路で来た設定には使わせないため。
// 複数は覚えない・聞かれたら忘れる: 断られた保存の読みが残って、あとの configureLlm に古い窓を使わせないため
export function createDetectedOnSave() {
  let remembered: { input: object; detection: Detection } | undefined;
  return {
    remember(input: object, detection: Detection): void {
      remembered = { input, detection };
    },
    recall(input: object): Detection | undefined {
      const found = remembered;
      remembered = undefined;
      return found?.input === input ? found.detection : undefined;
    },
  };
}
