import { PARAM_KEYS, type ParamKey, type Permission } from '@drawroid/core';
import { isApiError, savePermissionSettings, usePermissionSettings } from '@drawroid/swr';
import { Button, ErrorNote, Muted, OkNote, Section } from '@drawroid/ui';
import { useState, type FormEvent } from 'react';

import { buildOverrides, toRows, type Rows } from '../lib/permission-form';
import { PermissionTable } from './permission-table';

/**
 * 全体の既定の許可。パラメータごとに、AI に任せる（候補の絞り込み付き）・固定・使わないを選ぶ。
 * 保存した許可は、走行中のジョブにも次の回の境目から効く。
 */
export function PermissionSettings() {
  const { data, error } = usePermissionSettings();
  // 触るまでは保存されている許可をそのまま出す: 読み込みが後から届いても、欄が空のまま残らないようにするため
  const [edited, setEdited] = useState<Rows | undefined>();
  const [problem, setProblem] = useState<string | undefined>();
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  const rows = edited ?? (data === undefined ? undefined : toRows(data.overrides));
  // 読めなかった行は、表の行に出せるもの（知っているパラメータ）と、表の外に出すもの（知らない名前・全体）に分ける
  const invalid = data?.invalid ?? [];
  const known = (param: string) => (PARAM_KEYS as readonly string[]).includes(param);
  const invalidRows = new Map(
    invalid.filter(({ param }) => known(param)).map(({ param, reason }) => [param, reason]),
  );
  const otherInvalid = invalid.filter(({ param }) => !known(param));

  async function save(event: FormEvent) {
    event.preventDefault();
    if (rows === undefined) return;
    setProblem(undefined);
    setSaved(false);
    const overrides = buildOverrides(rows);
    if (!overrides.ok) {
      setProblem(overrides.reason);
      return;
    }
    setSaving(true);
    try {
      await savePermissionSettings(overrides.value);
      setEdited(undefined);
      setSaved(true);
    } catch (caught) {
      if (!isApiError(caught)) throw caught;
      setProblem(caught.message);
    } finally {
      setSaving(false);
    }
  }

  return (
    // 画面の頭の見出しにする（h1）: この部品は許可の画面にだけ置かれ、画面にほかの h1 が無いため
    <Section title="許可" level={1}>
      <Muted>
        パラメータごとに、AI
        に任せるか・人間が固定するか・使わないかを決める。保存すると、走行中のジョブにも次の回から効く。
      </Muted>
      {error !== undefined && <ErrorNote>許可を読めない: {error.message}</ErrorNote>}
      {rows !== undefined && data !== undefined && (
        <form onSubmit={(event) => void save(event)} className="space-y-3">
          {otherInvalid.length > 0 && (
            <ErrorNote>
              読めない許可がある（既定に戻っている）:{' '}
              {otherInvalid.map(({ param, reason }) => `${param}（${reason}）`).join('、')}。
              保存すると、読めない行は書いた内容から消える。
            </ErrorNote>
          )}
          <PermissionTable
            rows={rows}
            effective={data.permissions as Partial<Record<ParamKey, Permission>>}
            invalid={invalidRows}
            defaults={{ option: '既定のまま', note: '既定' }}
            onChange={setEdited}
          />
          <Button type="submit" variant="primary" disabled={saving}>
            許可を保存
          </Button>
        </form>
      )}
      {saved && <OkNote focus>保存した。走行中のジョブにも次の回から効く。</OkNote>}
      {problem !== undefined && <ErrorNote>保存できない: {problem}</ErrorNote>}
    </Section>
  );
}
