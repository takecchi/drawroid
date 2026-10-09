import { isApiError, saveLlmSettings, useLlmSettings } from '@drawroid/swr';
import {
  Button,
  CheckboxField,
  ErrorNote,
  Field,
  FieldRow,
  FieldSet,
  Input,
  Muted,
  Section,
  Select,
  SubSection,
} from '@drawroid/ui';
import { useState, type FormEvent } from 'react';

import {
  buildLlmSettings,
  emptyProviderRow,
  PROVIDER_TYPES,
  STRUCTURED_OUTPUT_MODES,
  toFormValues,
  type LlmSettingsFormValues,
  type ProviderRow,
  type ProviderType,
  type RoleValues,
  type StructuredOutputMode,
} from '../lib/llm-settings-form';

// 種類ごとの見本: openai-compatible はローカルの LLM が多く、鍵を要らないことが多いので、名前の見本ではなく空でよいことを示す
const API_KEY_ENV_PLACEHOLDERS: Record<ProviderType, string> = {
  anthropic: 'ANTHROPIC_API_KEY',
  openai: 'OPENAI_API_KEY',
  'openai-compatible': '鍵が要らなければ空',
};

const ROLE_LABELS = { think: '考える役', judge: '見る役' } as const;

function providerName(row: ProviderRow, index: number): string {
  return row.key.trim() === '' ? `${index + 1}番目` : row.key.trim();
}

function RoleFields({
  role,
  values,
  onChange,
}: {
  role: keyof typeof ROLE_LABELS;
  values: RoleValues;
  onChange: (values: RoleValues) => void;
}) {
  const label = ROLE_LABELS[role];
  return (
    <FieldSet legend={label}>
      <FieldRow>
        <Field label="provider">
          <Input
            type="text"
            value={values.provider}
            onChange={(event) => onChange({ ...values, provider: event.target.value })}
            aria-label={`${label}の provider`}
            list="llm-provider-names"
            className="w-56"
          />
        </Field>
        <Field label="モデル">
          <Input
            type="text"
            value={values.model}
            onChange={(event) => onChange({ ...values, model: event.target.value })}
            aria-label={`${label}のモデル`}
            className="w-64"
          />
        </Field>
      </FieldRow>
      <FieldRow>
        <Field label="文脈の上限（トークン）">
          <Input
            type="text"
            inputMode="numeric"
            value={values.contextTokens}
            onChange={(event) => onChange({ ...values, contextTokens: event.target.value })}
            aria-label={`${label}の文脈の上限`}
            placeholder="自動"
            className="w-32"
          />
        </Field>
        <Field label="出力の上限（トークン）">
          <Input
            type="text"
            inputMode="numeric"
            value={values.maxOutputTokens}
            onChange={(event) => onChange({ ...values, maxOutputTokens: event.target.value })}
            aria-label={`${label}の出力の上限`}
            placeholder="なし"
            className="w-32"
          />
        </Field>
      </FieldRow>
      <FieldRow className="items-end">
        <Field label="構造化出力">
          <Select
            value={values.structuredOutput}
            onChange={(event) =>
              onChange({ ...values, structuredOutput: event.target.value as StructuredOutputMode })
            }
            aria-label={`${label}の構造化出力`}
            className="w-40"
          >
            {STRUCTURED_OUTPUT_MODES.map((mode) => (
              <option key={mode} value={mode}>
                {mode}
              </option>
            ))}
          </Select>
        </Field>
        <CheckboxField
          label="画像を読める"
          checked={values.imageInput}
          onChange={(event) => onChange({ ...values, imageInput: event.target.checked })}
          className="pb-2"
        />
      </FieldRow>
    </FieldSet>
  );
}

export function LlmSettings() {
  const { data, error } = useLlmSettings();
  // 触るまでは保存されている設定をそのまま出す: 読み込みが後から届いても、欄が空のまま残らないようにするため
  const [edited, setEdited] = useState<LlmSettingsFormValues | undefined>();
  const [saveError, setSaveError] = useState<string | undefined>();
  const [saving, setSaving] = useState(false);

  const stored = data?.config ?? null;
  const keyStatus = data !== undefined && 'apiKeyEnv' in data ? data.apiKeyEnv : {};
  const values = edited ?? (data === undefined ? undefined : toFormValues(stored));

  function change(next: Partial<LlmSettingsFormValues>) {
    if (values === undefined) return;
    setEdited({ ...values, ...next });
  }

  function changeProvider(index: number, row: ProviderRow) {
    if (values === undefined) return;
    change({ providers: values.providers.map((current, i) => (i === index ? row : current)) });
  }

  async function save(event: FormEvent) {
    event.preventDefault();
    if (values === undefined) return;
    setSaving(true);
    setSaveError(undefined);
    try {
      await saveLlmSettings(buildLlmSettings(values, stored));
      setEdited(undefined);
    } catch (caught) {
      if (!isApiError(caught)) throw caught;
      setSaveError(caught.message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Section title="LLM の設定">
      {error !== undefined && <ErrorNote>設定を読めない: {error.message}</ErrorNote>}
      {data !== undefined && stored === null && (
        <Muted>まだ LLM が設定されていない。provider と、考える役のモデルを入れて保存する。</Muted>
      )}
      {values !== undefined && (
        <form onSubmit={(event) => void save(event)} className="space-y-4">
          <SubSection title="provider">
            <Muted>API キーは環境変数に置き、ここには変数の名前だけを書く。</Muted>
            {values.providers.map((row, index) => {
              const name = providerName(row, index);
              const status = keyStatus[row.key.trim()];
              return (
                <FieldSet key={index} legend={`provider ${name}`}>
                  <FieldRow>
                    <Field label="名前">
                      <Input
                        type="text"
                        value={row.key}
                        onChange={(event) =>
                          changeProvider(index, { ...row, key: event.target.value })
                        }
                        aria-label={`provider ${name} の名前`}
                        className="w-56"
                      />
                    </Field>
                    <Field label="種類">
                      <Select
                        value={row.type}
                        onChange={(event) =>
                          changeProvider(index, {
                            ...row,
                            type: event.target.value as ProviderType,
                          })
                        }
                        aria-label={`provider ${name} の種類`}
                        className="w-56"
                      >
                        {PROVIDER_TYPES.map((type) => (
                          <option key={type} value={type}>
                            {type}
                          </option>
                        ))}
                      </Select>
                    </Field>
                  </FieldRow>
                  <Field label="接続先（baseURL）">
                    <Input
                      type="text"
                      value={row.baseURL}
                      onChange={(event) =>
                        changeProvider(index, { ...row, baseURL: event.target.value })
                      }
                      aria-label={`provider ${name} の接続先（baseURL）`}
                      placeholder={
                        row.type === 'openai-compatible'
                          ? 'http://127.0.0.1:11434/v1'
                          : '既定の接続先'
                      }
                      className="w-80"
                    />
                  </Field>
                  <FieldRow className="items-end">
                    <Field label="API キーの環境変数">
                      <Input
                        type="text"
                        value={row.apiKeyEnv}
                        onChange={(event) =>
                          changeProvider(index, { ...row, apiKeyEnv: event.target.value })
                        }
                        aria-label={`provider ${name} の API キーの環境変数`}
                        placeholder={API_KEY_ENV_PLACEHOLDERS[row.type]}
                        className="w-64"
                      />
                    </Field>
                    {/* 確かめたのは保存されている名前だけなので、書き換えた名前には状態を出さない */}
                    {status !== undefined && status.name === row.apiKeyEnv.trim() && (
                      <span className="pb-2 text-sm text-muted-foreground">
                        {status.name} は{status.set ? '入っている' : '入っていない'}
                      </span>
                    )}
                    <Button
                      onClick={() =>
                        change({ providers: values.providers.filter((_, i) => i !== index) })
                      }
                    >
                      provider {name} を外す
                    </Button>
                  </FieldRow>
                </FieldSet>
              );
            })}
            <Button
              onClick={() => change({ providers: [...values.providers, emptyProviderRow()] })}
            >
              provider を足す
            </Button>
            <datalist id="llm-provider-names">
              {values.providers.map((row, index) => (
                <option key={index} value={row.key.trim()} />
              ))}
            </datalist>
          </SubSection>
          <SubSection title="役ごとのモデル">
            <RoleFields
              role="think"
              values={values.think}
              onChange={(think) => change({ think })}
            />
            <CheckboxField
              label="見る役も考える役と同じモデルを使う"
              checked={values.judgeSameAsThink}
              onChange={(event) => change({ judgeSameAsThink: event.target.checked })}
            />
            {!values.judgeSameAsThink && (
              <RoleFields
                role="judge"
                values={values.judge}
                onChange={(judge) => change({ judge })}
              />
            )}
          </SubSection>
          <Button type="submit" variant="primary" disabled={saving}>
            LLM の設定を保存
          </Button>
        </form>
      )}
      {saveError !== undefined && <ErrorNote>保存できない: {saveError}</ErrorNote>}
    </Section>
  );
}
