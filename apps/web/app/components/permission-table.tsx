import { PARAM_KEYS, type CandidateKind, type ParamKey, type Permission } from '@drawroid/core';
import { useBackendStatus, useCandidates } from '@drawroid/swr';
import { CheckboxField, ErrorNote, Input, Select, Textarea } from '@drawroid/ui';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@drawroid/ui/shadcn';

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
    <div className="space-y-1">
      <CheckboxField
        label="候補を絞る"
        checked={choices !== undefined}
        onChange={(event) => onChange(event.target.checked ? [] : undefined)}
      />
      {error !== undefined && (
        <ErrorNote>
          {label}の候補を読めない: {error.message}
        </ErrorNote>
      )}
      {choices !== undefined && (
        <ul className="space-y-1 pl-4">
          {shown.map((name) => (
            <li key={name}>
              <CheckboxField
                label={
                  <>
                    {name}
                    {!names.includes(name) && '（今の候補に無い）'}
                  </>
                }
                checked={choices.includes(name)}
                onChange={(event) =>
                  onChange(
                    event.target.checked
                      ? [...choices, name]
                      : choices.filter((chosen) => chosen !== name),
                  )
                }
              />
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
      <Textarea
        aria-label={label}
        value={text}
        onChange={(event) => onChange(event.target.value)}
        rows={3}
        placeholder="JSON で書く"
        className="w-80"
      />
    );
  }
  return (
    <Input
      type="text"
      inputMode={fixedValueKindOf(param) === 'number' ? 'decimal' : undefined}
      aria-label={label}
      value={text}
      onChange={(event) => onChange(event.target.value)}
      className="w-64"
    />
  );
}

function PermissionRow({
  param,
  row,
  effective,
  unavailable,
  invalid,
  defaults,
  onChange,
}: {
  param: ParamKey;
  row: Row;
  effective: Permission | undefined;
  unavailable: string | undefined;
  invalid: string | undefined;
  defaults: DefaultWords;
  onChange: (row: Row) => void;
}) {
  const label = PARAM_LABELS[param];
  const kind = candidateKindOf(param);
  return (
    // 上で揃え、文字の列は上の余白を選択欄（h-8）との差の半分だけ足す: 固定の値の欄が開いて行が高くなっても、名前が1行目の選択欄の横に留まるように
    <TableRow className="align-top">
      <TableHead scope="row" className="h-auto pt-3.5 pb-2 align-top">
        {label}
      </TableHead>
      <TableCell className="pt-3.5 align-top whitespace-normal">
        {effective !== undefined &&
          `${describePermission(effective)}${row.mode === 'default' ? `（${defaults.note}）` : ''}`}
        {invalid !== undefined && <ErrorNote>無効（既定に戻る）: {invalid}</ErrorNote>}
        {unavailable !== undefined && (
          <p className="my-1">
            バックエンドで使えない: {unavailable}（許可しても AI の選択肢から外れる）
          </p>
        )}
        {param === 'inpaint' && <p className="my-1">マスクを塗った回だけ、AI の選択肢に出る</p>}
      </TableCell>
      <TableCell className="space-y-2 align-top whitespace-normal">
        <Select
          aria-label={`${label} の許可`}
          value={row.mode}
          onChange={(event) => onChange({ ...row, mode: event.target.value as Row['mode'] })}
          className="w-48"
        >
          {MODES.map((mode) => (
            <option key={mode} value={mode} disabled={mode === 'off' && isRequired(param)}>
              {mode === 'default' ? defaults.option : MODE_LABELS[mode]}
            </option>
          ))}
        </Select>
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
      </TableCell>
    </TableRow>
  );
}

/**
 * パラメータごとの許可の表。全体の既定の許可と、ジョブごとの上書きで共有する。
 * effective は「書かない」ときに効く許可（全体の既定の画面では土台、投入の画面では全体の既定）。
 */
export function PermissionTable({
  rows,
  effective,
  invalid = new Map(),
  defaults,
  onChange,
}: {
  rows: Rows;
  effective: Partial<Record<ParamKey, Permission>>;
  /** 書かれていたが読めなかった行（パラメータ → 理由）。その行は既定に戻っている */
  invalid?: ReadonlyMap<string, string>;
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
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead scope="col">パラメータ</TableHead>
          <TableHead scope="col">いま</TableHead>
          <TableHead scope="col">変える</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {PARAM_KEYS.map((param) => (
          <PermissionRow
            key={param}
            param={param}
            row={rows[param]}
            effective={effective[param]}
            unavailable={unavailable.get(param)}
            invalid={invalid.get(param)}
            defaults={defaults}
            onChange={(row) => onChange({ ...rows, [param]: row })}
          />
        ))}
      </TableBody>
    </Table>
  );
}
