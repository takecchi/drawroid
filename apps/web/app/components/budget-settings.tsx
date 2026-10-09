import { isApiError, saveBudgetSettings, useBudgetSettings } from '@drawroid/swr';
import { useState, type FormEvent } from 'react';

import {
  budgetLeaves,
  buildBudgetOverrides,
  toBudgetFormValues,
  type BudgetFormValues,
} from '../lib/budget-form';

/** 予算の設定。空欄は上書きしない（既定のまま）。保存した予算は、そのあとに投入するジョブから効く */
export function BudgetSettings() {
  const { data, error } = useBudgetSettings();
  // 触るまでは保存されている設定をそのまま出す: 読み込みが後から届いても、欄が空のまま残らないようにするため
  const [edited, setEdited] = useState<BudgetFormValues | undefined>();
  const [problems, setProblems] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);

  const values = edited ?? (data === undefined ? undefined : toBudgetFormValues(data.overrides));

  async function save(event: FormEvent) {
    event.preventDefault();
    if (values === undefined) return;
    const built = buildBudgetOverrides(values);
    if (!built.ok) {
      setProblems(built.errors.map((e) => `${e.path}: ${e.reason}`));
      return;
    }
    setSaving(true);
    setProblems([]);
    try {
      await saveBudgetSettings(built.overrides);
      setEdited(undefined);
    } catch (caught) {
      if (!isApiError(caught)) throw caught;
      setProblems([caught.message]);
    } finally {
      setSaving(false);
    }
  }

  return (
    <section>
      <h2>予算の設定</h2>
      <p>1回の LLM 呼び出しに載せてよい量の上限。空欄は既定のまま。</p>
      <p>保存した値は、次に投入するジョブから効く。走っているジョブは変わらない。</p>
      {error !== undefined && <p role="alert">予算を読めない: {error.message}</p>}
      {data !== undefined && values !== undefined && (
        <form onSubmit={(event) => void save(event)}>
          {budgetLeaves(data.defaults).map(({ path, defaultValue }) => (
            <div key={path}>
              <label>
                {path}{' '}
                <input
                  type="text"
                  inputMode="numeric"
                  value={values[path] ?? ''}
                  onChange={(event) => setEdited({ ...values, [path]: event.target.value })}
                  aria-label={path}
                  placeholder={String(defaultValue)}
                  size={8}
                />
              </label>
            </div>
          ))}
          {problems.length > 0 && (
            <ul role="alert">
              {problems.map((problem) => (
                <li key={problem}>{problem}</li>
              ))}
            </ul>
          )}
          <button type="submit" disabled={saving}>
            予算を保存
          </button>
        </form>
      )}
    </section>
  );
}
