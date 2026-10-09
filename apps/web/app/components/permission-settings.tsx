import type { ParamKey, Permission } from '@drawroid/core';
import { isApiError, savePermissionSettings, usePermissionSettings } from '@drawroid/swr';
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
    <section>
      <h2>許可</h2>
      <p>
        パラメータごとに、AI
        に任せるか・人間が固定するか・使わないかを決める。保存すると、走行中のジョブにも次の回から効く。
      </p>
      {error !== undefined && <p role="alert">許可を読めない: {error.message}</p>}
      {rows !== undefined && data !== undefined && (
        <form onSubmit={(event) => void save(event)}>
          <PermissionTable
            rows={rows}
            effective={data.permissions as Partial<Record<ParamKey, Permission>>}
            defaults={{ option: '既定のまま', note: '既定' }}
            onChange={setEdited}
          />
          <button type="submit" disabled={saving}>
            許可を保存
          </button>
        </form>
      )}
      {saved && <p>保存した。走行中のジョブにも次の回から効く。</p>}
      {problem !== undefined && <p role="alert">保存できない: {problem}</p>}
    </section>
  );
}
