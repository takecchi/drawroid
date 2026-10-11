import {
  addInstruction,
  addReference,
  changeStopConditions,
  isApiError,
  stopJob,
  stopManualJob,
  useStopConditions,
  type JobOverview,
} from '@drawroid/swr';
import {
  BulletList,
  Button,
  ErrorNote,
  Muted,
  OkNote,
  Section,
  SubSection,
  Textarea,
} from '@drawroid/ui';
import { useEffect, useRef, useState } from 'react';

import { buildReferenceUpload, type AttachedReference } from '../lib/reference-upload';
import {
  buildStopConditionsChange,
  changedConditions,
  describeStopConditions,
  stopConditionsToForm,
  type EditedStopConditionFields,
  type StopConditionsFormValues,
} from '../lib/stop-conditions-form';
import { ReferenceAttacher } from './reference-attacher';
import { StopConditionsEditor } from './stop-conditions-editor';

/** 最後に押した操作の断り（断りの知らせと同じ文）。押し直すたびに undefined で消す */
type OnRefused = (refusal: string | undefined) => void;

function StopButton({
  jobId,
  manual = false,
  onRefused,
}: {
  jobId: string;
  manual?: boolean;
  onRefused: OnRefused;
}) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | undefined>();

  async function stop() {
    if (!window.confirm('このジョブを止める。走っている回は途中で打ち切られる。よいか')) return;
    setPending(true);
    setError(undefined);
    onRefused(undefined);
    try {
      await (manual ? stopManualJob(jobId) : stopJob(jobId));
    } catch (caught) {
      if (!isApiError(caught)) throw caught;
      setError(caught.message);
      onRefused(`止められない: ${caught.message}`);
    } finally {
      setPending(false);
    }
  }

  return (
    <SubSection title="止める">
      <Button variant="danger" disabled={pending} onClick={() => void stop()}>
        ジョブを止める
      </Button>
      {/* 押したボタンは送っている間押せなくなり、フォーカスがページの外に落ちるので、断りへ移す（以下の断りも同じ） */}
      {error !== undefined && <ErrorNote focus>止められない: {error}</ErrorNote>}
    </SubSection>
  );
}

function InstructionForm({ jobId, onRefused }: { jobId: string; onRefused: OnRefused }) {
  const [text, setText] = useState('');
  const [pending, setPending] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | undefined>();

  async function send() {
    setPending(true);
    setError(undefined);
    setSent(false);
    onRefused(undefined);
    try {
      await addInstruction(jobId, text);
      setText('');
      setSent(true);
    } catch (caught) {
      if (!isApiError(caught)) throw caught;
      setError(caught.message);
      onRefused(`送れない: ${caught.message}`);
    } finally {
      setPending(false);
    }
  }

  return (
    <SubSection title="人間の指示">
      <Textarea
        value={text}
        onChange={(event) => setText(event.target.value)}
        rows={3}
        aria-label="人間の指示"
      />
      <div>
        <Button disabled={pending || text.trim() === ''} onClick={() => void send()}>
          送る
        </Button>
      </div>
      {/* 送ると欄は空になり、押したボタンも押せなくなってフォーカスが落ちるので、知らせへ移す。送るたびに作り直す（setSent(false)） */}
      {sent && <OkNote focus>送った。次の回の「考える」から反映される</OkNote>}
      {error !== undefined && <ErrorNote focus>送れない: {error}</ErrorNote>}
    </SubSection>
  );
}

function ReferenceForm({ jobId, onRefused }: { jobId: string; onRefused: OnRefused }) {
  const [items, setItems] = useState<AttachedReference[]>([]);
  const [pending, setPending] = useState(false);
  const [sent, setSent] = useState(0);
  const [error, setError] = useState<string | undefined>();

  // 1枚ずつ送る: 口出しの API が1回に1枚で、途中で断られても送れた分は外し、残りだけを直して送り直せるため
  async function send() {
    setPending(true);
    setError(undefined);
    setSent(0);
    onRefused(undefined);
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
      onRefused(`送れない: ${caught.message}`);
    } finally {
      setPending(false);
    }
  }

  return (
    <SubSection title="参照画像を添える">
      <ReferenceAttacher items={items} onChange={setItems} disabled={pending} />
      <div>
        <Button disabled={pending || items.length === 0} onClick={() => void send()}>
          参照画像を送る
        </Button>
      </div>
      {sent > 0 && (
        <OkNote focus>
          {sent} 枚送った。次の回の境目で見る役が1度だけ見て要点にする（原寸の画像は毎回は渡さない）
        </OkNote>
      )}
      {error !== undefined && <ErrorNote focus>送れない: {error}</ErrorNote>}
    </SubSection>
  );
}

function StopConditionsChanger({ jobId, onRefused }: { jobId: string; onRefused: OnRefused }) {
  // 走行中の画面にだけ出すので live 固定: 別の口出し（別タブ・API）で変わった条件も、取り直して見せるため
  const { data, error: loadError } = useStopConditions(jobId, { live: true });
  // 手で直した欄だけを下書きとして持ち、取り直した current に重ねて出す: 直した欄を取り直しで消さず、直していない欄は
  // 別のタブや API で変わった値に追従させるため。送るのも直した欄だけ（ほかの欄を、この画面の古い値で戻さない）
  const [edits, setEdits] = useState<Partial<StopConditionsFormValues>>({});
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | undefined>();

  if (data === undefined) {
    return (
      <SubSection title="止める条件を変える">
        {loadError === undefined ? (
          <Muted>今の止める条件を読み込んでいる</Muted>
        ) : (
          <ErrorNote>今の止める条件を読めない: {loadError.message}</ErrorNote>
        )}
      </SubSection>
    );
  }

  const { submitted, current } = data;
  const values: StopConditionsFormValues = { ...stopConditionsToForm(current), ...edits };
  const edited = Object.fromEntries(
    Object.keys(edits).map((key) => [key, true]),
  ) as EditedStopConditionFields;
  const changed = changedConditions(submitted, current);

  // 部品は全部の欄を返すので、出していた値と違う欄だけを直した欄に足す
  function edit(next: StopConditionsFormValues) {
    setEdits((previous) => {
      const merged = { ...previous };
      for (const key of Object.keys(next) as (keyof StopConditionsFormValues)[]) {
        if (next[key] !== values[key]) Object.assign(merged, { [key]: next[key] });
      }
      return merged;
    });
  }

  async function change() {
    const change = buildStopConditionsChange(values, edited);
    if (!change.ok) {
      setError(change.reason);
      return;
    }
    setPending(true);
    setError(undefined);
    onRefused(undefined);
    try {
      // 成功したら下書きを捨てる: changeStopConditions が current を取り直すので、欄は重ねたあとの実際の値になる
      await changeStopConditions(jobId, change.value);
      setEdits({});
    } catch (caught) {
      if (!isApiError(caught)) throw caught;
      setError(caught.message);
      onRefused(`変えられない: ${caught.message}`);
    } finally {
      setPending(false);
    }
  }

  return (
    <SubSection title="止める条件を変える">
      <div className="space-y-1">
        <p className="text-sm">いまの条件（次の回の境目から効く）</p>
        <BulletList>
          {describeStopConditions(current).map((line) => (
            <li key={line}>{line}</li>
          ))}
        </BulletList>
      </div>
      {changed.length > 0 && (
        <div className="space-y-1">
          <p className="text-sm">投入時から変わった</p>
          <BulletList>
            {changed.map((field) => (
              <li key={field.label}>
                {field.label}: 投入時 {field.submitted} → いま {field.current}
              </li>
            ))}
          </BulletList>
        </div>
      )}
      <StopConditionsEditor
        values={values}
        onChange={edit}
        confirm={{
          label: '条件を変える',
          pending,
          // 直した欄が無いときは押せない: 送る欄が無く、API も「変える欄が無い」で断るため
          disabled: Object.keys(edits).length === 0,
          onConfirm: () => void change(),
        }}
      />
      {error !== undefined && <ErrorNote focus>変えられない: {error}</ErrorNote>}
    </SubSection>
  );
}

function StoppedNote({ manual, focus }: { manual: boolean; focus: boolean }) {
  const note = useRef<HTMLParagraphElement>(null);
  useEffect(() => {
    if (focus) note.current?.focus();
    // 出たときの一度だけ: 描き直すたびに移すと、ほかの所へ移った人からフォーカスを奪うため
  }, []);
  return (
    <p ref={note} role="status" className="text-sm" {...(focus && { tabIndex: -1 })}>
      {manual
        ? 'このジョブは止まった。'
        : 'このジョブは止まった。指示・参照画像・止める条件は、もう送れない。'}
    </p>
  );
}

/** 止まっていないジョブにだけ操作を出す。どれも HTTP API の口出しの経路を呼ぶ */
export function JobOperations({ job }: { job: JobOverview }) {
  const { spec, state } = job;
  const operations = useRef<HTMLDivElement>(null);
  const [running, setRunning] = useState(state.status !== 'stopped');
  // 開いている間に止まったら、区画を消さずに、止まったことと最後の断りを残す: 取り直しで止まりが届くと中の操作は外れ、
  // 押したばかりの断り（止まったので 409）も一緒に消えて、押した人には何が起きたか分からず、フォーカスも落ちるため
  const [stoppedHere, setStoppedHere] = useState<{ takeFocus: boolean }>();
  const [refusal, setRefusal] = useState<string>();
  if (state.status === 'stopped' && running) {
    setRunning(false);
    // 止まった時点のフォーカスで決める: 操作の中（か、ページの外）に居た人にだけ移し、ほかの所に居る人からは奪わない
    const active = document.activeElement;
    setStoppedHere({
      takeFocus:
        active === null ||
        active === document.body ||
        (operations.current?.contains(active) ?? false),
    });
  }

  if (state.status === 'stopped') {
    // 最初から止まっているジョブには出さない
    if (stoppedHere === undefined) return null;
    return (
      <Section title="操作">
        <StoppedNote
          manual={spec.kind === 'manual'}
          focus={stoppedHere.takeFocus && refusal === undefined}
        />
        {refusal !== undefined && (
          <ErrorNote key={refusal} focus={stoppedHere.takeFocus}>
            {refusal}
          </ErrorNote>
        )}
      </Section>
    );
  }

  return (
    // contents: 区画の並びに箱を1段足さない。中にフォーカスがあるかを見るためだけの枠
    <div ref={operations} className="contents">
      {/* 手動の生成は口出しを受けないので、止めるだけを出す */}
      {spec.kind === 'manual' ? (
        <Section title="操作">
          <StopButton jobId={spec.jobId} manual onRefused={setRefusal} />
        </Section>
      ) : (
        <Section title="操作">
          <StopButton jobId={spec.jobId} onRefused={setRefusal} />
          <InstructionForm jobId={spec.jobId} onRefused={setRefusal} />
          <ReferenceForm jobId={spec.jobId} onRefused={setRefusal} />
          <StopConditionsChanger jobId={spec.jobId} onRefused={setRefusal} />
        </Section>
      )}
    </div>
  );
}
