import {
  isApiError,
  saveGenerationProgressSettings,
  useGenerationProgressSettings,
} from '@drawroid/swr';
import { CheckboxField, ErrorNote, Muted, OkNote, Section } from '@drawroid/ui';
import { useState } from 'react';

/**
 * 生成の途中の画像を、会話の進み具合のカードに出すか（config.json の generationProgress.includePreview）。
 * 既定は出さない（docs/design/conversational-agent.md の「推奨で進める点」の13）。既定の値は変えず、ここで有効にできるようにする
 */
// 押したらすぐ保存する: 欄は1つだけで、保存のボタンを別に押させると、押し忘れて効いていないことに気づけないため
export function GenerationProgressSettings() {
  const { data, error } = useGenerationProgressSettings();
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [saveError, setSaveError] = useState<string | undefined>();
  // 押した値を、保存が済むまで欄に映す（済んだら読んだ値に戻す。失敗すれば元の値に戻る）
  const [pending, setPending] = useState<boolean | undefined>();

  async function change(includePreview: boolean) {
    setPending(includePreview);
    setSaving(true);
    setSaved(false);
    setSaveError(undefined);
    try {
      await saveGenerationProgressSettings({ includePreview });
      setSaved(true);
    } catch (caught) {
      if (!isApiError(caught)) throw caught;
      setSaveError(caught.message);
    } finally {
      setPending(undefined);
      setSaving(false);
    }
  }

  return (
    <Section title="生成の途中の画像">
      <Muted>
        描いている間、会話の進み具合のカードに、途中の画像を出す。有効にすると、生成の間は1秒ごとに画像のバックエンドから途中の画像を取るので、そのぶん負荷がかかる。既定では出さず、進み具合（割合・ステップ・残り時間）だけを出す。
      </Muted>
      {error !== undefined ? (
        <ErrorNote>設定を読めない: {error.message}</ErrorNote>
      ) : data === undefined ? (
        <Muted>読み込んでいます。</Muted>
      ) : (
        <CheckboxField
          label="生成の途中の画像を出す"
          checked={pending ?? data.includePreview}
          disabled={saving}
          onChange={(event) => void change(event.target.checked)}
        />
      )}
      {saveError !== undefined && <ErrorNote>保存できない: {saveError}</ErrorNote>}
      {saved && <OkNote focus>保存した。次に始まる生成から効く。</OkNote>}
    </Section>
  );
}
