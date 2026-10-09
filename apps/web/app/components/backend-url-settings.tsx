import { isApiError, saveBackendSettings, useBackendSettings } from '@drawroid/swr';
import { useState, type FormEvent } from 'react';

const SOURCE_LABELS = {
  cli: '起動の引数',
  config: 'config.json',
  default: '既定値',
} as const;

const KIND_LABELS = { forge: 'Forge', a1111: 'A1111' } as const;

export function BackendUrlSettings() {
  const { data, error } = useBackendSettings();
  const [input, setInput] = useState('');
  const [saveError, setSaveError] = useState<string | undefined>();
  const [saving, setSaving] = useState(false);

  async function save(event: FormEvent) {
    event.preventDefault();
    setSaving(true);
    setSaveError(undefined);
    try {
      await saveBackendSettings({ url: input.trim() });
      setInput('');
    } catch (caught) {
      if (!isApiError(caught)) throw caught;
      setSaveError(caught.message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <section>
      <h2>バックエンドの URL</h2>
      {error !== undefined && <p role="alert">設定を読めない: {error.message}</p>}
      {data !== undefined && (
        <>
          <p>
            種類: {KIND_LABELS[data.kind]}（起動時の --backend か config.json の backend.kind
            で変える）
          </p>
          <p>
            いまの URL: <code>{data.url}</code>（{SOURCE_LABELS[data.urlSource]}）
          </p>
          {data.urlSource === 'cli' && (
            <p>
              注意: 起動時に --backend-url（古い名前 --forge-url）で指定されている。ここで保存した
              URL はいまの起動中だけ効き、次に起動したときも同じ引数を付ければ、そちらが勝つ。
            </p>
          )}
        </>
      )}
      <form onSubmit={(event) => void save(event)}>
        <input
          type="text"
          value={input}
          onChange={(event) => setInput(event.target.value)}
          placeholder="http://127.0.0.1:7860"
          aria-label="バックエンドの URL"
          size={40}
        />{' '}
        <button type="submit" disabled={saving || input.trim() === ''}>
          保存
        </button>
      </form>
      {saveError !== undefined && <p role="alert">保存できない: {saveError}</p>}
    </section>
  );
}
