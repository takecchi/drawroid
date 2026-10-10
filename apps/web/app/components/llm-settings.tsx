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
  OkNote,
  Section,
  Select,
  SubSection,
} from '@drawroid/ui';
import { useState, type FormEvent } from 'react';

import {
  buildLlmSettings,
  definedProviderNames,
  duplicatedProviderName,
  PROVIDER_TYPES,
  REASONING_MODES,
  roleProviderOf,
  TOOL_CALLING_MODES,
  STRUCTURED_OUTPUT_MODES,
  toFormValues,
  unnamedProviderRowNumber,
  withProviderAdded,
  withProviderChanged,
  withProviderRemoved,
  type LlmSettingsFormValues,
  type ProviderRow,
  type ProviderType,
  type RoleValues,
  type ReasoningMode,
  type ToolCallingMode,
  type StructuredOutputMode,
} from '../lib/llm-settings-form';

// 種類ごとの見本: openai-compatible はローカルの LLM が多く、鍵を要らないことが多いので、名前の見本ではなく空でよいことを示す
const API_KEY_ENV_PLACEHOLDERS: Record<ProviderType, string> = {
  anthropic: 'ANTHROPIC_API_KEY',
  openai: 'OPENAI_API_KEY',
  'openai-compatible': '鍵が要らなければ空',
};

const ROLE_LABELS = { think: '考える役', judge: '見る役', talk: '話す役' } as const;

function providerName(row: ProviderRow, index: number): string {
  return row.key.trim() === '' ? `${index + 1}番目` : row.key.trim();
}

function RoleFields({
  role,
  values,
  providerNames,
  onChange,
}: {
  role: keyof typeof ROLE_LABELS;
  values: RoleValues;
  /** 上で定義した provider の名前。役の provider はこの中から選ぶ */
  providerNames: readonly string[];
  onChange: (values: RoleValues) => void;
}) {
  const label = ROLE_LABELS[role];
  const provider = roleProviderOf(values, providerNames);
  return (
    <FieldSet legend={label}>
      <FieldRow>
        <Field label="provider">
          <Select
            value={provider}
            onChange={(event) =>
              onChange({ ...values, provider: event.target.value, providerPinned: false })
            }
            aria-label={`${label}の provider`}
            className="w-56"
          >
            {provider === '' && (
              <option value="" disabled>
                {providerNames.length === 0 ? '先に provider を定義する' : '選ぶ'}
              </option>
            )}
            {providerNames.map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
            {/* 定義に無い名前を黙って消さない: 上で名前を変えたときなどに、どの役が古い名前を指しているかを見せるため（保存はサーバが断る） */}
            {provider !== '' && !providerNames.includes(provider) && (
              <option value={provider}>{provider}（定義に無い）</option>
            )}
          </Select>
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
        <Field label="ツールの呼び出し方">
          <Select
            value={values.toolCalling}
            onChange={(event) =>
              onChange({ ...values, toolCalling: event.target.value as ToolCallingMode })
            }
            aria-label={`${label}のツールの呼び出し方`}
            className="w-40"
          >
            {TOOL_CALLING_MODES.map((mode) => (
              <option key={mode} value={mode}>
                {mode}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="思考の受け取り方">
          <Select
            value={values.reasoning}
            onChange={(event) =>
              onChange({ ...values, reasoning: event.target.value as ReasoningMode })
            }
            aria-label={`${label}の思考の受け取り方`}
            className="w-40"
          >
            {REASONING_MODES.map((mode) => (
              <option key={mode} value={mode}>
                {mode}
              </option>
            ))}
          </Select>
        </Field>
        <CheckboxField
          label="画像を読める"
          aria-label={`${label}は画像を読める`}
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
  // 保存できたことを知らせる: 保存しても欄の見た目は変わらないので、押した人が通ったかを分からないため
  const [saved, setSaved] = useState(false);

  const stored = data?.config ?? null;
  const keyStatus = data !== undefined && 'apiKeyEnv' in data ? data.apiKeyEnv : {};
  const values = edited ?? (data === undefined ? undefined : toFormValues(stored));
  const providerNames = definedProviderNames(values?.providers ?? []);

  function change(next: Partial<LlmSettingsFormValues>) {
    if (values === undefined) return;
    setSaved(false);
    setEdited({ ...values, ...next });
  }

  function changeProvider(index: number, row: ProviderRow) {
    if (values === undefined) return;
    change(withProviderChanged(values, index, row));
  }

  async function save(event: FormEvent) {
    event.preventDefault();
    if (values === undefined) return;
    setSaved(false);
    const duplicated = duplicatedProviderName(values.providers);
    if (duplicated !== undefined) {
      setSaveError(`provider の名前「${duplicated}」が2つある。どちらかの名前を変える`);
      return;
    }
    const unnamed = unnamedProviderRowNumber(values.providers);
    if (unnamed !== undefined) {
      setSaveError(`provider ${unnamed}番目 に名前が無い。名前を付けるか、その行を外す`);
      return;
    }
    setSaving(true);
    setSaveError(undefined);
    try {
      await saveLlmSettings(buildLlmSettings(values));
      setEdited(undefined);
      setSaved(true);
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
                      // 狭い画面では枠の幅に収める: 決まった幅のままだと、provider の枠の外へはみ出すため
                      className="w-full max-w-80"
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
                    <Button onClick={() => change(withProviderRemoved(values, index))}>
                      provider {name} を外す
                    </Button>
                  </FieldRow>
                </FieldSet>
              );
            })}
            <Button onClick={() => change(withProviderAdded(values))}>provider を足す</Button>
          </SubSection>
          <SubSection title="役ごとのモデル">
            <RoleFields
              role="think"
              values={values.think}
              providerNames={providerNames}
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
                providerNames={providerNames}
                onChange={(judge) => change({ judge })}
              />
            )}
            <CheckboxField
              label="話す役（会話）も考える役と同じモデルを使う"
              checked={values.talkSameAsThink}
              onChange={(event) => change({ talkSameAsThink: event.target.checked })}
            />
            {!values.talkSameAsThink && (
              <RoleFields
                role="talk"
                values={values.talk}
                providerNames={providerNames}
                onChange={(talk) => change({ talk })}
              />
            )}
          </SubSection>
          <SubSection title="再試行の回数">
            <FieldRow>
              <Field label="出力が形に合わないとき">
                <Input
                  type="text"
                  inputMode="numeric"
                  value={values.validationRetries}
                  onChange={(event) => change({ validationRetries: event.target.value })}
                  aria-label="出力が形に合わないときの再試行の回数"
                  placeholder="既定"
                  className="w-32"
                />
              </Field>
              <Field label="繋がらない・混んでいるとき">
                <Input
                  type="text"
                  inputMode="numeric"
                  value={values.networkRetries}
                  onChange={(event) => change({ networkRetries: event.target.value })}
                  aria-label="繋がらない・混んでいるときの再試行の回数"
                  placeholder="既定"
                  className="w-32"
                />
              </Field>
            </FieldRow>
          </SubSection>
          <SubSection title="応答を待つ時間">
            <Field
              label="応答を待つ上限（秒）"
              hint="LLM が何も返さないまま、この秒数がたったら打ち切る。返し続けている間は打ち切らない。既定は 300 秒"
            >
              <Input
                type="text"
                inputMode="numeric"
                value={values.callTimeoutSeconds}
                onChange={(event) => change({ callTimeoutSeconds: event.target.value })}
                aria-label="応答を待つ上限（秒）"
                placeholder="既定"
                className="w-32"
              />
            </Field>
          </SubSection>
          <Button type="submit" variant="primary" disabled={saving}>
            LLM の設定を保存
          </Button>
        </form>
      )}
      {saveError !== undefined && <ErrorNote>保存できない: {saveError}</ErrorNote>}
      {saved && <OkNote focus>保存した。次に話しかけたときから、この設定を使う。</OkNote>}
    </Section>
  );
}
