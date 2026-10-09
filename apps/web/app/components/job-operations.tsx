import type { StopConditions } from '@drawroid/core';
import {
  addInstruction,
  addReference,
  changeStopConditions,
  isApiError,
  stopJob,
  useStopConditions,
  type JobDetail,
} from '@drawroid/swr';
import { useState } from 'react';

import { buildReferenceUpload, type AttachedReference } from '../lib/reference-upload';
import {
  buildStopConditionsChange,
  changedConditions,
  stopConditionsToForm,
  type StopConditionsFormValues,
} from '../lib/stop-conditions-form';
import { ReferenceAttacher } from './reference-attacher';
import { StopConditionsEditor } from './stop-conditions-editor';

function StopButton({ jobId }: { jobId: string }) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | undefined>();

  async function stop() {
    if (!window.confirm('このジョブを止める。走っている回は途中で打ち切られる。よいか')) return;
    setPending(true);
    setError(undefined);
    try {
      await stopJob(jobId);
    } catch (caught) {
      if (!isApiError(caught)) throw caught;
      setError(caught.message);
    } finally {
      setPending(false);
    }
  }

  return (
    <section>
      <h3>止める</h3>
      <button type="button" disabled={pending} onClick={() => void stop()}>
        ジョブを止める
      </button>
      {error !== undefined && <p role="alert">止められない: {error}</p>}
    </section>
  );
}

function InstructionForm({ jobId }: { jobId: string }) {
  const [text, setText] = useState('');
  const [pending, setPending] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | undefined>();

  async function send() {
    setPending(true);
    setError(undefined);
    setSent(false);
    try {
      await addInstruction(jobId, text);
      setText('');
      setSent(true);
    } catch (caught) {
      if (!isApiError(caught)) throw caught;
      setError(caught.message);
    } finally {
      setPending(false);
    }
  }

  return (
    <section>
      <h3>人間の指示</h3>
      <textarea
        value={text}
        onChange={(event) => setText(event.target.value)}
        rows={3}
        cols={60}
        aria-label="人間の指示"
      />
      <br />
      <button type="button" disabled={pending || text.trim() === ''} onClick={() => void send()}>
        送る
      </button>
      {sent && <p>送った。次の回の「考える」から反映される</p>}
      {error !== undefined && <p role="alert">送れない: {error}</p>}
    </section>
  );
}

function ReferenceForm({ jobId }: { jobId: string }) {
  const [items, setItems] = useState<AttachedReference[]>([]);
  const [pending, setPending] = useState(false);
  const [sent, setSent] = useState(0);
  const [error, setError] = useState<string | undefined>();

  // 1枚ずつ送る: 口出しの API が1回に1枚で、途中で断られても送れた分は外し、残りだけを直して送り直せるため
  async function send() {
    setPending(true);
    setError(undefined);
    setSent(0);
    let rest = items;
    try {
      for (const item of items) {
        const upload = await buildReferenceUpload(item);
        if (!upload.ok) {
          setError(upload.reason);
          return;
        }
        await addReference(jobId, upload.value);
        rest = rest.filter((it) => it.id !== item.id);
        setItems(rest);
        setSent((count) => count + 1);
      }
    } catch (caught) {
      if (!isApiError(caught)) throw caught;
      setError(caught.message);
    } finally {
      setPending(false);
    }
  }

  return (
    <section>
      <h3>参照画像を添える</h3>
      <ReferenceAttacher items={items} onChange={setItems} disabled={pending} />
      <button type="button" disabled={pending || items.length === 0} onClick={() => void send()}>
        参照画像を送る
      </button>
      {sent > 0 && (
        <p>
          {sent} 枚送った。次の回の境目で見る役が1度だけ見て要点にする（原寸の画像は毎回は渡さない）
        </p>
      )}
      {error !== undefined && <p role="alert">送れない: {error}</p>}
    </section>
  );
}

function describeConditions(conditions: StopConditions): string[] {
  return [
    ...(conditions.aiJudgement ? ['AI が意図どおりと判断したら'] : []),
    ...(conditions.maxIterations === undefined ? [] : [`${conditions.maxIterations} 回まで`]),
    ...(conditions.maxImages === undefined ? [] : [`${conditions.maxImages} 枚まで`]),
    ...(conditions.maxDurationMs === undefined
      ? []
      : [`${conditions.maxDurationMs / 60_000} 分まで`]),
  ];
}

function StopConditionsChanger({ jobId }: { jobId: string }) {
  // 走行中の画面にだけ出すので live 固定: 別の口出し（別タブ・API）で変わった条件も、取り直して見せるため
  const { data, error: loadError } = useStopConditions(jobId, { live: true });
  // 手で直した分だけを持つ: 取り直した current で毎回上書きすると、入力の途中を消してしまうため
  const [draft, setDraft] = useState<StopConditionsFormValues | undefined>();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | undefined>();

  if (data === undefined) {
    return (
      <section>
        <h3>止める条件を変える</h3>
        {loadError === undefined ? (
          <p>今の止める条件を読み込んでいる</p>
        ) : (
          <p role="alert">今の止める条件を読めない: {loadError.message}</p>
        )}
      </section>
    );
  }

  const { submitted, current } = data;
  const values = draft ?? stopConditionsToForm(current);
  const changed = changedConditions(submitted, current);

  async function change() {
    const change = buildStopConditionsChange(values);
    if (!change.ok) {
      setError(change.reason);
      return;
    }
    setPending(true);
    setError(undefined);
    try {
      // 成功したら下書きを捨てる: changeStopConditions が current を取り直すので、欄は重ねたあとの実際の値になる
      await changeStopConditions(jobId, change.value);
      setDraft(undefined);
    } catch (caught) {
      if (!isApiError(caught)) throw caught;
      setError(caught.message);
    } finally {
      setPending(false);
    }
  }

  return (
    <section>
      <h3>止める条件を変える</h3>
      <div>
        <p>いまの条件（次の回の境目から効く）</p>
        <ul>
          {describeConditions(current).map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      </div>
      {changed.length > 0 && (
        <div>
          <p>投入時から変わった</p>
          <ul>
            {changed.map((field) => (
              <li key={field.label}>
                {field.label}: 投入時 {field.submitted} → いま {field.current}
              </li>
            ))}
          </ul>
        </div>
      )}
      <StopConditionsEditor
        values={values}
        onChange={setDraft}
        confirm={{ label: '条件を変える', pending, onConfirm: () => void change() }}
      />
      {error !== undefined && <p role="alert">変えられない: {error}</p>}
    </section>
  );
}

/** 止まっていない自動ジョブにだけ出す。どれも HTTP API の口出しの経路を呼ぶ */
export function JobOperations({ job }: { job: JobDetail }) {
  const { spec, state } = job;
  if (spec.kind !== 'auto' || state.status === 'stopped') return null;
  return (
    <section>
      <h2>操作</h2>
      <StopButton jobId={spec.jobId} />
      <InstructionForm jobId={spec.jobId} />
      <ReferenceForm jobId={spec.jobId} />
      <StopConditionsChanger jobId={spec.jobId} />
    </section>
  );
}
