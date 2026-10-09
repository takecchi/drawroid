import { isApiError, saveBackendSettings, useBackendSettings } from '@drawroid/swr';
import { Button, ErrorNote, Input, Section } from '@drawroid/ui';
import { useState, type FormEvent } from 'react';

import { BACKEND_KIND_LABELS } from '../lib/backend-error';

const SOURCE_LABELS = {
  cli: '起動の引数',
  config: 'config.json',
  default: '既定値',
} as const;

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
    <Section title="バックエンドの URL">
      {error !== undefined && <ErrorNote>設定を読めない: {error.message}</ErrorNote>}
      {data !== undefined && (
        <>
          <p>
            種類: {BACKEND_KIND_LABELS[data.kind]}（起動時の --backend か config.json の
            backend.kind で変える）
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
      <form onSubmit={(event) => void save(event)} className="flex flex-wrap items-center gap-2">
        <Input
          type="text"
          value={input}
          onChange={(event) => setInput(event.target.value)}
          placeholder="http://127.0.0.1:7860"
          aria-label="バックエンドの URL"
          className="w-80"
        />
        <Button type="submit" variant="primary" disabled={saving || input.trim() === ''}>
          保存
        </Button>
      </form>
      {saveError !== undefined && <ErrorNote>保存できない: {saveError}</ErrorNote>}
    </Section>
  );
}
