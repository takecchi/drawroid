import { isApiError, saveBackendSettings, useBackendSettings } from '@drawroid/swr';
import { Button, ErrorNote, Input, OkNote, Section, Select } from '@drawroid/ui';
import { useState, type FormEvent } from 'react';

import { BACKEND_KIND_LABELS, type BackendKind } from '../lib/backend-error';

const BACKEND_KINDS = Object.keys(BACKEND_KIND_LABELS) as BackendKind[];
// 設定を読めるまでの見かけの値。保存は読めた（data がある）あとにしか意味を持たない
const DEFAULT_KIND: BackendKind = 'forge';

const SOURCE_LABELS = {
  cli: '起動の引数',
  config: 'config.json',
  default: '既定値',
} as const;

export function BackendUrlSettings() {
  const { data, error } = useBackendSettings();
  // 触るまでは、いま繋いでいる URL を欄に出す: 空の欄に既定の見本だけがあると、いまの URL が既定に見えるため
  const [edited, setEdited] = useState<string | undefined>();
  const input = edited ?? data?.url ?? '';
  // 種類も同じく、触るまではいま使っている種類を出す
  const [editedKind, setEditedKind] = useState<BackendKind | undefined>();
  const kind = editedKind ?? data?.kind ?? DEFAULT_KIND;
  const [saveError, setSaveError] = useState<string | undefined>();
  const [saving, setSaving] = useState(false);
  // 保存した種類と URL。保存しても欄の見た目は変わらないので、効いたことを知らせる
  const [saved, setSaved] = useState<{ kind: BackendKind; url: string } | undefined>();

  async function save(event: FormEvent) {
    event.preventDefault();
    setSaving(true);
    setSaveError(undefined);
    setSaved(undefined);
    try {
      const url = input.trim();
      // 種類は触ったときだけ送る: 触っていない種類（--backend で起動した種類など）を config.json に書かないため
      await saveBackendSettings({ url, ...(editedKind !== undefined && { kind: editedKind }) });
      setEdited(undefined);
      setEditedKind(undefined);
      setSaved({ kind, url });
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
            種類: {BACKEND_KIND_LABELS[data.kind]}（{SOURCE_LABELS[data.kindSource]}）
          </p>
          {data.kindSource === 'cli' && (
            <p>
              注意: 起動時に --backend
              で指定されている。ここで保存した種類はいまの起動中だけ効き、次に起動したときも同じ
              --backend を付ければ、そちらが勝つ。
            </p>
          )}
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
        <Select
          value={kind}
          onChange={(event) => {
            setEditedKind(event.target.value as BackendKind);
            setSaved(undefined);
          }}
          aria-label="バックエンドの種類"
        >
          {BACKEND_KINDS.map((value) => (
            <option key={value} value={value}>
              {BACKEND_KIND_LABELS[value]}
            </option>
          ))}
        </Select>
        <Input
          type="text"
          value={input}
          onChange={(event) => {
            setEdited(event.target.value);
            setSaved(undefined);
          }}
          placeholder="http://127.0.0.1:7860"
          aria-label="バックエンドの URL"
          className="w-80"
        />
        <Button type="submit" variant="primary" disabled={saving || input.trim() === ''}>
          保存
        </Button>
      </form>
      {saved !== undefined && (
        <OkNote focus>
          保存した。{BACKEND_KIND_LABELS[saved.kind]} の {saved.url} に繋ぐ。
        </OkNote>
      )}
      {saveError !== undefined && <ErrorNote>保存できない: {saveError}</ErrorNote>}
    </Section>
  );
}
