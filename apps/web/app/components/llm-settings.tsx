import { isApiError, saveLlmSettings, useLlmSettings } from '@drawroid/swr';
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
    <fieldset>
      <legend>{label}</legend>
      <label>
        provider{' '}
        <input
          type="text"
          value={values.provider}
          onChange={(event) => onChange({ ...values, provider: event.target.value })}
          aria-label={`${label}の provider`}
          list="llm-provider-names"
        />
      </label>{' '}
      <label>
        モデル{' '}
        <input
          type="text"
          value={values.model}
          onChange={(event) => onChange({ ...values, model: event.target.value })}
          aria-label={`${label}のモデル`}
        />
      </label>
      <br />
      <label>
        文脈の上限（トークン）{' '}
        <input
          type="text"
          inputMode="numeric"
          value={values.contextTokens}
          onChange={(event) => onChange({ ...values, contextTokens: event.target.value })}
          aria-label={`${label}の文脈の上限`}
          placeholder="8192"
          size={8}
        />
      </label>{' '}
      <label>
        出力の上限（トークン）{' '}
        <input
          type="text"
          inputMode="numeric"
          value={values.maxOutputTokens}
          onChange={(event) => onChange({ ...values, maxOutputTokens: event.target.value })}
          aria-label={`${label}の出力の上限`}
          placeholder="4096"
          size={8}
        />
      </label>
      <br />
      <label>
        構造化出力{' '}
        <select
          value={values.structuredOutput}
          onChange={(event) =>
            onChange({ ...values, structuredOutput: event.target.value as StructuredOutputMode })
          }
          aria-label={`${label}の構造化出力`}
        >
          {STRUCTURED_OUTPUT_MODES.map((mode) => (
            <option key={mode} value={mode}>
              {mode}
            </option>
          ))}
        </select>
      </label>{' '}
      <label>
        <input
          type="checkbox"
          checked={values.imageInput}
          onChange={(event) => onChange({ ...values, imageInput: event.target.checked })}
        />
        画像を読める
      </label>
    </fieldset>
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
    <section>
      <h2>LLM の設定</h2>
      {error !== undefined && <p role="alert">設定を読めない: {error.message}</p>}
      {data !== undefined && stored === null && (
        <p>まだ LLM が設定されていない。provider と、考える役のモデルを入れて保存する。</p>
      )}
      {values !== undefined && (
        <form onSubmit={(event) => void save(event)}>
          <h3>provider</h3>
          <p>API キーは環境変数に置き、ここには変数の名前だけを書く。</p>
          {values.providers.map((row, index) => {
            const name = providerName(row, index);
            const status = keyStatus[row.key.trim()];
            return (
              <fieldset key={index}>
                <legend>provider {name}</legend>
                <label>
                  名前{' '}
                  <input
                    type="text"
                    value={row.key}
                    onChange={(event) => changeProvider(index, { ...row, key: event.target.value })}
                    aria-label={`provider ${name} の名前`}
                  />
                </label>{' '}
                <label>
                  種類{' '}
                  <select
                    value={row.type}
                    onChange={(event) =>
                      changeProvider(index, { ...row, type: event.target.value as ProviderType })
                    }
                    aria-label={`provider ${name} の種類`}
                  >
                    {PROVIDER_TYPES.map((type) => (
                      <option key={type} value={type}>
                        {type}
                      </option>
                    ))}
                  </select>
                </label>
                <br />
                <label>
                  接続先（baseURL）{' '}
                  <input
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
                    size={40}
                  />
                </label>
                <br />
                <label>
                  API キーの環境変数{' '}
                  <input
                    type="text"
                    value={row.apiKeyEnv}
                    onChange={(event) =>
                      changeProvider(index, { ...row, apiKeyEnv: event.target.value })
                    }
                    aria-label={`provider ${name} の API キーの環境変数`}
                    placeholder="ANTHROPIC_API_KEY"
                  />
                </label>{' '}
                {/* 確かめたのは保存されている名前だけなので、書き換えた名前には状態を出さない */}
                {status !== undefined && status.name === row.apiKeyEnv.trim() && (
                  <span>
                    {status.name} は{status.set ? '入っている' : '入っていない'}
                  </span>
                )}{' '}
                <button
                  type="button"
                  onClick={() =>
                    change({ providers: values.providers.filter((_, i) => i !== index) })
                  }
                >
                  provider {name} を外す
                </button>
              </fieldset>
            );
          })}
          <button
            type="button"
            onClick={() => change({ providers: [...values.providers, emptyProviderRow()] })}
          >
            provider を足す
          </button>
          <datalist id="llm-provider-names">
            {values.providers.map((row, index) => (
              <option key={index} value={row.key.trim()} />
            ))}
          </datalist>
          <h3>役ごとのモデル</h3>
          <RoleFields role="think" values={values.think} onChange={(think) => change({ think })} />
          <label>
            <input
              type="checkbox"
              checked={values.judgeSameAsThink}
              onChange={(event) => change({ judgeSameAsThink: event.target.checked })}
            />
            見る役も考える役と同じモデルを使う
          </label>
          {!values.judgeSameAsThink && (
            <RoleFields
              role="judge"
              values={values.judge}
              onChange={(judge) => change({ judge })}
            />
          )}
          <p>
            <button type="submit" disabled={saving}>
              LLM の設定を保存
            </button>
          </p>
        </form>
      )}
      {saveError !== undefined && <p role="alert">保存できない: {saveError}</p>}
    </section>
  );
}
