import { PARAM_KEYS, type CandidateKind, type ParamKey, type Permission } from '@drawroid/core';
import {
  isApiError,
  savePermissionSettings,
  useBackendStatus,
  useCandidates,
  usePermissionSettings,
} from '@drawroid/swr';
import { useState, type FormEvent } from 'react';

import {
  buildOverrides,
  candidateKindOf,
  describePermission,
  fixedValueKindOf,
  isRequired,
  PARAM_LABELS,
  toRows,
  type Row,
  type Rows,
} from '../lib/permission-form';

const MODE_LABELS: Record<Row['mode'], string> = {
  default: '既定のまま',
  auto: 'AI に任せる',
  fixed: '固定',
  off: '使わない',
};

function ChoicesField({
  kind,
  label,
  choices,
  onChange,
}: {
  kind: CandidateKind;
  label: string;
  choices: string[] | undefined;
  onChange: (choices: string[] | undefined) => void;
}) {
  const { data, error } = useCandidates(kind);
  const names = (data?.candidates ?? []).map((candidate) => candidate.name);
  // 今の候補に無い名前も残して見せる: バックエンドから消えた候補を、絞り込みから黙って落とさないため
  const shown = [...names, ...(choices ?? []).filter((name) => !names.includes(name))];
  return (
    <div>
      <label>
        <input
          type="checkbox"
          checked={choices !== undefined}
          onChange={(event) => onChange(event.target.checked ? [] : undefined)}
        />
        候補を絞る
      </label>
      {error !== undefined && (
        <p role="alert">
          {label}の候補を読めない: {error.message}
        </p>
      )}
      {choices !== undefined && (
        <ul style={{ listStyle: 'none', paddingLeft: 16, margin: 0 }}>
          {shown.map((name) => (
            <li key={name}>
              <label>
                <input
                  type="checkbox"
                  checked={choices.includes(name)}
                  onChange={(event) =>
                    onChange(
                      event.target.checked
                        ? [...choices, name]
                        : choices.filter((chosen) => chosen !== name),
                    )
                  }
                />
                {name}
                {!names.includes(name) && '（今の候補に無い）'}
              </label>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function FixedField({
  param,
  text,
  onChange,
}: {
  param: ParamKey;
  text: string;
  onChange: (text: string) => void;
}) {
  const label = `${PARAM_LABELS[param]} の固定の値`;
  if (fixedValueKindOf(param) === 'json') {
    return (
      <textarea
        aria-label={label}
        value={text}
        onChange={(event) => onChange(event.target.value)}
        rows={3}
        cols={40}
        placeholder="JSON で書く"
      />
    );
  }
  return (
    <input
      type="text"
      inputMode={fixedValueKindOf(param) === 'number' ? 'decimal' : undefined}
      aria-label={label}
      value={text}
      onChange={(event) => onChange(event.target.value)}
    />
  );
}

function PermissionRow({
  param,
  row,
  effective,
  unavailable,
  onChange,
}: {
  param: ParamKey;
  row: Row;
  effective: Permission | undefined;
  unavailable: string | undefined;
  onChange: (row: Row) => void;
}) {
  const label = PARAM_LABELS[param];
  const kind = candidateKindOf(param);
  return (
    <tr>
      <th scope="row" style={{ textAlign: 'left', verticalAlign: 'top' }}>
        {label}
      </th>
      <td style={{ verticalAlign: 'top' }}>
        {effective !== undefined &&
          `${describePermission(effective)}${row.mode === 'default' ? '（既定）' : ''}`}
        {unavailable !== undefined && (
          <p style={{ margin: '4px 0' }}>
            バックエンドで使えない: {unavailable}（許可しても AI の選択肢から外れる）
          </p>
        )}
        {param === 'inpaint' && (
          <p style={{ margin: '4px 0' }}>マスクを塗った回だけ、AI の選択肢に出る</p>
        )}
      </td>
      <td style={{ verticalAlign: 'top' }}>
        <select
          aria-label={`${label} の許可`}
          value={row.mode}
          onChange={(event) => onChange({ ...row, mode: event.target.value as Row['mode'] })}
        >
          {(Object.keys(MODE_LABELS) as Row['mode'][]).map((mode) => (
            <option key={mode} value={mode} disabled={mode === 'off' && isRequired(param)}>
              {MODE_LABELS[mode]}
            </option>
          ))}
        </select>
        {row.mode === 'auto' && kind !== undefined && (
          <ChoicesField
            kind={kind}
            label={label}
            choices={row.choices}
            onChange={(choices) => onChange({ ...row, choices })}
          />
        )}
        {row.mode === 'fixed' && (
          <FixedField
            param={param}
            text={row.fixedText}
            onChange={(fixedText) => onChange({ ...row, fixedText })}
          />
        )}
      </td>
    </tr>
  );
}

/**
 * 全体の既定の許可。パラメータごとに、AI に任せる（候補の絞り込み付き）・固定・使わないを選ぶ。
 * 保存した許可は、走行中のジョブにも次の回の境目から効く。
 */
export function PermissionSettings() {
  const { data, error } = usePermissionSettings();
  const backend = useBackendStatus();
  // 触るまでは保存されている許可をそのまま出す: 読み込みが後から届いても、欄が空のまま残らないようにするため
  const [edited, setEdited] = useState<Rows | undefined>();
  const [problem, setProblem] = useState<string | undefined>();
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  const rows = edited ?? (data === undefined ? undefined : toRows(data.overrides));
  const unavailable = new Map(
    (backend.data?.capabilities.unavailable ?? []).map(({ feature, reason }) => [
      feature as ParamKey,
      reason,
    ]),
  );

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
          <table>
            <thead>
              <tr>
                <th scope="col">パラメータ</th>
                <th scope="col">いま</th>
                <th scope="col">変える</th>
              </tr>
            </thead>
            <tbody>
              {PARAM_KEYS.map((param) => (
                <PermissionRow
                  key={param}
                  param={param}
                  row={rows[param]}
                  effective={(data.permissions as Partial<Record<ParamKey, Permission>>)[param]}
                  unavailable={unavailable.get(param)}
                  onChange={(row) => setEdited({ ...rows, [param]: row })}
                />
              ))}
            </tbody>
          </table>
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
