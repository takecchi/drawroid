import { createAutoJob, isApiError } from '@drawroid/swr';
import { useState, type FormEvent } from 'react';

import { buildReferenceUploads, type AttachedReference } from '../lib/reference-upload';
import {
  buildStopConditions,
  DEFAULT_STOP_CONDITIONS_FORM,
  stopConditionsBlocker,
} from '../lib/stop-conditions-form';
import { ReferenceAttacher } from './reference-attacher';
import { StopConditionsEditor } from './stop-conditions-editor';

const DEFAULT_BATCH_SIZE = '1';

export function AutoJobForm({ onCreated }: { onCreated: (jobId: string) => void }) {
  const [request, setRequest] = useState('');
  const [stopForm, setStopForm] = useState(DEFAULT_STOP_CONDITIONS_FORM);
  const [batchSize, setBatchSize] = useState(DEFAULT_BATCH_SIZE);
  const [references, setReferences] = useState<AttachedReference[]>([]);
  const [error, setError] = useState<string | undefined>();
  const [sending, setSending] = useState(false);

  const stopBlocker = stopConditionsBlocker(stopForm);
  const batch = Number(batchSize.trim());
  const batchValid = Number.isInteger(batch) && batch >= 1 && batch <= 8;

  async function submit(event: FormEvent) {
    event.preventDefault();
    const stopConditions = buildStopConditions(stopForm);
    if (!stopConditions.ok) return;
    // ボタンの disabled だけに任せない: Enter での送信など、ボタンを通らない経路でも止まらないジョブを投入しないため
    if (stopBlocker !== undefined) {
      setError(stopBlocker);
      return;
    }
    setSending(true);
    setError(undefined);
    try {
      const uploads = await buildReferenceUploads(references);
      if (!uploads.ok) {
        setError(uploads.reason);
        return;
      }
      const { jobId } = await createAutoJob({
        request,
        stopConditions: stopConditions.value,
        batchSize: batch,
        // 空のときは載せない: 参照画像の無い投入の body を、これまでと同じ形に保つため
        ...(uploads.value.length === 0 ? {} : { references: uploads.value }),
      });
      onCreated(jobId);
    } catch (caught) {
      if (!isApiError(caught)) throw caught;
      setError(caught.message);
    } finally {
      setSending(false);
    }
  }

  return (
    <form onSubmit={(event) => void submit(event)}>
      <p>
        <label>
          依頼
          <br />
          <textarea
            value={request}
            onChange={(event) => setRequest(event.target.value)}
            rows={4}
            cols={60}
            placeholder="例: 夕暮れの海辺に立つ少女。柔らかい光で"
          />
        </label>
      </p>
      <ReferenceAttacher items={references} onChange={setReferences} disabled={sending} />
      <StopConditionsEditor values={stopForm} onChange={setStopForm} />
      <p>
        <label>
          1回の枚数（1〜8）{' '}
          <input
            value={batchSize}
            onChange={(event) => setBatchSize(event.target.value)}
            inputMode="numeric"
            size={3}
          />
        </label>
        {!batchValid && <span role="alert"> 1〜8 の整数で書く</span>}
      </p>
      <button
        type="submit"
        disabled={sending || request.trim() === '' || stopBlocker !== undefined || !batchValid}
      >
        投入する
      </button>
      {error !== undefined && <p role="alert">送れない: {error}</p>}
    </form>
  );
}
