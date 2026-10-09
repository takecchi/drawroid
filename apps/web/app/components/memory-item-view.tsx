import {
  deleteMemoryItem,
  isApiError,
  saveMemoryItem,
  useMemoryItem,
  type MemoryItemDetail,
} from '@drawroid/swr';
import { useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router';

import {
  buildSaveInput,
  memoryToFormValues,
  type MemoryFormValues,
  type MemoryItem,
} from '../lib/memory-form';

const SCOPE_LABELS = { always: 'always（依頼によらず渡す）', tagged: 'tagged（関係する依頼だけ）' };

function formatTime(iso: string): string {
  return new Date(iso).toLocaleString('ja-JP');
}

export function MemoryItemView({ id }: { id: string }) {
  const { data, error, mutate } = useMemoryItem(id);
  return (
    <section>
      <p>
        <Link to="/memory">記憶の一覧へ</Link>
      </p>
      {error !== undefined && <p role="alert">この記憶を読めない: {error.message}</p>}
      {data !== undefined && <MemoryItemBody id={id} detail={data} reload={() => mutate()} />}
    </section>
  );
}

function MemoryItemBody({
  id,
  detail,
  reload,
}: {
  id: string;
  detail: MemoryItemDetail;
  reload: () => Promise<MemoryItemDetail | undefined>;
}) {
  // 開いた時点の項目を state で持つ: 保存の expectedUpdatedAt は「画面が見せているもの」の値でなければ、衝突の検出にならないため
  const [base, setBase] = useState<MemoryItem>(detail.item);
  const [values, setValues] = useState<MemoryFormValues>(memoryToFormValues(detail.item));
  const [problem, setProblem] = useState<{ kind: 'conflict' | 'other'; message: string }>();
  const [busy, setBusy] = useState(false);
  const navigate = useNavigate();

  function open(item: MemoryItem) {
    setBase(item);
    setValues(memoryToFormValues(item));
    setProblem(undefined);
  }

  async function run(action: () => Promise<void>) {
    setBusy(true);
    setProblem(undefined);
    try {
      await action();
    } catch (caught) {
      if (!isApiError(caught)) throw caught;
      setProblem({
        kind: caught.kind === 'conflict' ? 'conflict' : 'other',
        message: caught.message,
      });
    } finally {
      setBusy(false);
    }
  }

  const save = (event: FormEvent) => {
    event.preventDefault();
    void run(async () => {
      const saved = await saveMemoryItem(id, buildSaveInput(values, base.updatedAt));
      open(saved.item);
    });
  };

  const remove = () => {
    if (!window.confirm('この記憶を消す。元に戻せない。')) return;
    void run(async () => {
      await deleteMemoryItem(id);
      await navigate('/memory');
    });
  };

  const reloadLatest = () =>
    void run(async () => {
      const fresh = await reload();
      if (fresh !== undefined) open(fresh.item);
    });

  return (
    <>
      <p>
        作成 {formatTime(base.createdAt)} / 更新 {formatTime(base.updatedAt)}
      </p>

      <h3>学んだジョブ</h3>
      {detail.sources.length === 0 && <p>無い。</p>}
      <ul>
        {detail.sources.map(({ jobId, job }) => (
          <li key={jobId}>
            <Link to={`/jobs/${encodeURIComponent(jobId)}`}>
              <code>{jobId}</code>
            </Link>{' '}
            {job === null ? (
              '消えたジョブ'
            ) : (
              <>
                {job.kind} {formatTime(job.createdAt)} {job.request.slice(0, 60)}
              </>
            )}
          </li>
        ))}
      </ul>

      <h3>直す</h3>
      <form onSubmit={save}>
        <p>
          <label>
            本文
            <br />
            <textarea
              value={values.body}
              onChange={(event) => setValues({ ...values, body: event.target.value })}
              rows={3}
              cols={60}
            />
          </label>
        </p>
        <p>
          <label>
            tags（カンマ区切り）{' '}
            <input
              type="text"
              value={values.tags}
              onChange={(event) => setValues({ ...values, tags: event.target.value })}
              size={40}
            />
          </label>
        </p>
        <p>
          <label>
            scope{' '}
            <select
              value={values.scope}
              onChange={(event) =>
                setValues({ ...values, scope: event.target.value as MemoryItem['scope'] })
              }
            >
              <option value="always">{SCOPE_LABELS.always}</option>
              <option value="tagged">{SCOPE_LABELS.tagged}</option>
            </select>
          </label>
        </p>
        <button type="submit" disabled={busy}>
          保存
        </button>{' '}
        <button type="button" onClick={remove} disabled={busy}>
          消す
        </button>
      </form>

      {problem?.kind === 'conflict' && (
        <p role="alert">
          開いたあとにファイルが変わった。読み直してから直す。{' '}
          <button type="button" onClick={reloadLatest} disabled={busy}>
            読み直す
          </button>
        </p>
      )}
      {problem?.kind === 'other' && <p role="alert">できなかった: {problem.message}</p>}
    </>
  );
}
