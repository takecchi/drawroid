import type { CandidateKind } from '@drawroid/core';
import { isApiError, startManualJob, useCandidates } from '@drawroid/swr';
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
    <label>
      {label}{' '}
      <select value={value} onChange={(event) => onChange(event.target.value)}>
        <option value="">Forge の既定</option>
        {data?.candidates.map((candidate) => (
          <option key={candidate.name} value={candidate.name}>
            {candidate.label ?? candidate.name}
          </option>
        ))}
      </select>
    </label>
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
    <fieldset>
      <legend>LoRA</legend>
      <ul>
        {loras.map((lora, index) => (
          <li key={`${lora.name}-${index}`}>
            {lora.name}（重み {lora.weight}）{' '}
            <button type="button" onClick={() => onChange(loras.filter((_, i) => i !== index))}>
              外す
            </button>
          </li>
        ))}
      </ul>
      <select value={name} onChange={(event) => setName(event.target.value)} aria-label="LoRA">
        <option value="">選ぶ</option>
        {data?.candidates.map((candidate) => (
          <option key={candidate.name} value={candidate.name}>
            {candidate.label ?? candidate.name}
          </option>
        ))}
      </select>{' '}
      <input
        type="text"
        inputMode="decimal"
        value={weight}
        onChange={(event) => setWeight(event.target.value)}
        aria-label="LoRA の重み"
        size={4}
      />{' '}
      <button
        type="button"
        disabled={name === ''}
        onClick={() => {
          onChange([...loras, { name, weight }]);
          setName('');
        }}
      >
        足す
      </button>
    </fieldset>
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
    <section>
      <h2>生成</h2>
      <form onSubmit={(event) => void submit(event)}>
        <p>
          <label>
            prompt
            <br />
            <textarea {...text('prompt')} rows={3} cols={60} />
          </label>
        </p>
        <p>
          <label>
            negativePrompt
            <br />
            <textarea {...text('negativePrompt')} rows={2} cols={60} />
          </label>
        </p>
        <p>
          <CandidateSelect
            kind="checkpoint"
            label="checkpoint"
            value={values.checkpoint}
            onChange={(v) => set('checkpoint', v)}
          />{' '}
          <CandidateSelect
            kind="vae"
            label="vae"
            value={values.vae}
            onChange={(v) => set('vae', v)}
          />
        </p>
        <p>
          <CandidateSelect
            kind="sampler"
            label="sampler"
            value={values.sampler}
            onChange={(v) => set('sampler', v)}
          />{' '}
          <CandidateSelect
            kind="scheduler"
            label="scheduler"
            value={values.scheduler}
            onChange={(v) => set('scheduler', v)}
          />
        </p>
        <LoraPicker loras={values.loras} onChange={(loras) => set('loras', loras)} />
        <p>
          <label>
            steps <input {...text('steps')} inputMode="numeric" size={5} />
          </label>{' '}
          <label>
            cfgScale <input {...text('cfgScale')} inputMode="decimal" size={5} />
          </label>{' '}
          <label>
            batchSize <input {...text('batchSize')} inputMode="numeric" size={5} />
          </label>
        </p>
        <p>
          <label>
            width <input {...text('width')} inputMode="numeric" size={5} />
          </label>{' '}
          <label>
            height <input {...text('height')} inputMode="numeric" size={5} />
          </label>{' '}
          <label>
            seed <input {...text('seed')} inputMode="numeric" placeholder="ランダム" size={12} />
          </label>
        </p>
        <button type="submit" disabled={sending}>
          生成する
        </button>
      </form>
      {error !== undefined && <p role="alert">送れない: {error}</p>}
    </section>
  );
}
