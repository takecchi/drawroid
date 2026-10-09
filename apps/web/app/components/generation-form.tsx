import type { CandidateKind } from '@drawroid/core';
import { isApiError, startManualJob, useCandidates } from '@drawroid/swr';
import {
  Button,
  ErrorNote,
  Field,
  FieldRow,
  FieldSet,
  Input,
  Item,
  ItemList,
  Section,
  Select,
  Textarea,
} from '@drawroid/ui';
import { useState, type FormEvent } from 'react';

import {
  buildGenerationRequest,
  DEFAULT_FORM_VALUES,
  DEFAULT_LORA_WEIGHT,
  type GenerationFormValues,
} from '../lib/generation-form';

// 候補を取れないときは data が無く、選択肢は「既定」だけになる。理由は「バックエンドの状態」が出す
function CandidateSelect({
  kind,
  label,
  value,
  onChange,
}: {
  kind: Exclude<CandidateKind, 'lora'>;
  label: string;
  value: string;
  onChange: (value: string) => void;
}) {
  const { data } = useCandidates(kind);
  return (
    <Field label={label}>
      <Select value={value} onChange={(event) => onChange(event.target.value)} className="w-56">
        <option value="">Forge の既定</option>
        {data?.candidates.map((candidate) => (
          <option key={candidate.name} value={candidate.name}>
            {candidate.label ?? candidate.name}
          </option>
        ))}
      </Select>
    </Field>
  );
}

function LoraPicker({
  loras,
  onChange,
}: {
  loras: GenerationFormValues['loras'];
  onChange: (loras: GenerationFormValues['loras']) => void;
}) {
  const { data } = useCandidates('lora');
  const [name, setName] = useState('');
  const [weight, setWeight] = useState(DEFAULT_LORA_WEIGHT);
  return (
    <FieldSet legend="LoRA">
      <ItemList>
        {loras.map((lora, index) => (
          <Item key={`${lora.name}-${index}`}>
            {lora.name}（重み {lora.weight}）{' '}
            <Button
              className="h-7 px-2 text-xs"
              onClick={() => onChange(loras.filter((_, i) => i !== index))}
            >
              外す
            </Button>
          </Item>
        ))}
      </ItemList>
      <FieldRow className="items-center">
        <Select
          value={name}
          onChange={(event) => setName(event.target.value)}
          aria-label="LoRA"
          className="w-56"
        >
          <option value="">選ぶ</option>
          {data?.candidates.map((candidate) => (
            <option key={candidate.name} value={candidate.name}>
              {candidate.label ?? candidate.name}
            </option>
          ))}
        </Select>
        <Input
          type="text"
          inputMode="decimal"
          value={weight}
          onChange={(event) => setWeight(event.target.value)}
          aria-label="LoRA の重み"
          className="w-24"
        />
        <Button
          disabled={name === ''}
          onClick={() => {
            onChange([...loras, { name, weight }]);
            setName('');
          }}
        >
          足す
        </Button>
      </FieldRow>
    </FieldSet>
  );
}

export function GenerationForm({ onStarted }: { onStarted: (jobId: string) => void }) {
  const [values, setValues] = useState(DEFAULT_FORM_VALUES);
  const [error, setError] = useState<string | undefined>();
  const [sending, setSending] = useState(false);

  const set = <K extends keyof GenerationFormValues>(key: K, value: GenerationFormValues[K]) =>
    setValues((current) => ({ ...current, [key]: value }));
  const text = (key: Exclude<keyof GenerationFormValues, 'loras'>) => ({
    value: values[key],
    onChange: (event: { target: { value: string } }) => set(key, event.target.value),
  });

  async function submit(event: FormEvent) {
    event.preventDefault();
    setSending(true);
    setError(undefined);
    try {
      const { jobId } = await startManualJob(buildGenerationRequest(values));
      onStarted(jobId);
    } catch (caught) {
      if (!isApiError(caught)) throw caught;
      setError(caught.message);
    } finally {
      setSending(false);
    }
  }

  return (
    <Section title="生成">
      <form onSubmit={(event) => void submit(event)} className="space-y-3">
        <Field label="prompt" wide>
          <Textarea {...text('prompt')} rows={3} />
        </Field>
        <Field label="negativePrompt" wide>
          <Textarea {...text('negativePrompt')} rows={2} />
        </Field>
        <FieldRow>
          <CandidateSelect
            kind="checkpoint"
            label="checkpoint"
            value={values.checkpoint}
            onChange={(v) => set('checkpoint', v)}
          />
          <CandidateSelect
            kind="vae"
            label="vae"
            value={values.vae}
            onChange={(v) => set('vae', v)}
          />
        </FieldRow>
        <FieldRow>
          <CandidateSelect
            kind="sampler"
            label="sampler"
            value={values.sampler}
            onChange={(v) => set('sampler', v)}
          />
          <CandidateSelect
            kind="scheduler"
            label="scheduler"
            value={values.scheduler}
            onChange={(v) => set('scheduler', v)}
          />
        </FieldRow>
        <LoraPicker loras={values.loras} onChange={(loras) => set('loras', loras)} />
        <FieldRow>
          <Field label="steps">
            <Input {...text('steps')} inputMode="numeric" className="w-24" />
          </Field>
          <Field label="cfgScale">
            <Input {...text('cfgScale')} inputMode="decimal" className="w-24" />
          </Field>
          <Field label="batchSize">
            <Input {...text('batchSize')} inputMode="numeric" className="w-24" />
          </Field>
        </FieldRow>
        <FieldRow>
          <Field label="width">
            <Input {...text('width')} inputMode="numeric" className="w-24" />
          </Field>
          <Field label="height">
            <Input {...text('height')} inputMode="numeric" className="w-24" />
          </Field>
          <Field label="seed">
            <Input {...text('seed')} inputMode="numeric" placeholder="ランダム" className="w-40" />
          </Field>
        </FieldRow>
        <Button type="submit" variant="primary" disabled={sending}>
          生成する
        </Button>
      </form>
      {error !== undefined && <ErrorNote>送れない: {error}</ErrorNote>}
    </Section>
  );
}
