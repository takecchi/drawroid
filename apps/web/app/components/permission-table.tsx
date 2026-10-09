import { PARAM_KEYS, type CandidateKind, type ParamKey, type Permission } from '@drawroid/core';
import { useBackendStatus, useCandidates } from '@drawroid/swr';

import {
  candidateKindOf,
  describePermission,
  fixedValueKindOf,
  isRequired,
  PARAM_LABELS,
  type Row,
  type Rows,
} from '../lib/permission-form';

const MODES = ['default', 'auto', 'fixed', 'off'] as const satisfies readonly Row['mode'][];
const MODE_LABELS: Record<Exclude<Row['mode'], 'default'>, string> = {
  auto: 'AI に任せる',
  fixed: '固定',
  off: '使わない',
};

/** 「書かない」行の言葉。option は選ぶ欄の言葉、note は今の許可に添える言葉 */
export interface DefaultWords {
  option: string;
  note: string;
}

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
  defaults,
  onChange,
}: {
  param: ParamKey;
  row: Row;
  effective: Permission | undefined;
  unavailable: string | undefined;
  defaults: DefaultWords;
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
          `${describePermission(effective)}${row.mode === 'default' ? `（${defaults.note}）` : ''}`}
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
          {MODES.map((mode) => (
            <option key={mode} value={mode} disabled={mode === 'off' && isRequired(param)}>
              {mode === 'default' ? defaults.option : MODE_LABELS[mode]}
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
 * パラメータごとの許可の表。全体の既定の許可と、ジョブごとの上書きで共有する。
 * effective は「書かない」ときに効く許可（全体の既定の画面では土台、投入の画面では全体の既定）。
 */
export function PermissionTable({
  rows,
  effective,
  defaults,
  onChange,
}: {
  rows: Rows;
  effective: Partial<Record<ParamKey, Permission>>;
  defaults: DefaultWords;
  onChange: (rows: Rows) => void;
}) {
  const backend = useBackendStatus();
  const unavailable = new Map(
    (backend.data?.capabilities.unavailable ?? []).map(({ feature, reason }) => [
      feature as ParamKey,
      reason,
    ]),
  );
  return (
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
            effective={effective[param]}
            unavailable={unavailable.get(param)}
            defaults={defaults}
            onChange={(row) => onChange({ ...rows, [param]: row })}
          />
        ))}
      </tbody>
    </table>
  );
}
