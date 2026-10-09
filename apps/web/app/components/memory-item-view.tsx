import { conversationOfSource } from '@drawroid/core';
import {
  deleteMemoryItem,
  isApiError,
  saveMemoryItem,
  useMemoryItem,
  type MemoryItemDetail,
} from '@drawroid/swr';
import {
  Button,
  ErrorNote,
  Field,
  Input,
  Item,
  ItemList,
  Muted,
  Section,
  Select,
  SubSection,
  Textarea,
} from '@drawroid/ui';
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
    <Section>
      <p>
        <Link to="/memory" className="underline underline-offset-2">
          記憶の一覧へ
        </Link>
      </p>
      {error !== undefined && <ErrorNote>この記憶を読めない: {error.message}</ErrorNote>}
      {data !== undefined && <MemoryItemBody id={id} detail={data} reload={() => mutate()} />}
    </Section>
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
      <p className="text-sm">
        作成 {formatTime(base.createdAt)} / 更新 {formatTime(base.updatedAt)}
      </p>

      <SubSection title="学んだ元">
        {detail.sources.length === 0 && <Muted>無い。</Muted>}
        <ItemList>
          {detail.sources.map(({ jobId, job }) => {
            const conversationId = conversationOfSource(jobId);
            return conversationId !== undefined ? (
              <Item key={jobId}>
                会話{' '}
                <Link
                  to={`/conversations/${encodeURIComponent(conversationId)}`}
                  className="underline underline-offset-2"
                >
                  <code>{conversationId}</code>
                </Link>
              </Item>
            ) : (
              <Item key={jobId}>
                <Link
                  to={`/jobs/${encodeURIComponent(jobId)}`}
                  className="underline underline-offset-2"
                >
                  <code>{jobId}</code>
                </Link>{' '}
                {job === null ? (
                  '消えたジョブ'
                ) : (
                  <>
                    {job.kind} {formatTime(job.createdAt)} {job.request.slice(0, 60)}
                  </>
                )}
              </Item>
            );
          })}
        </ItemList>
      </SubSection>

      <SubSection title="直す">
        <form onSubmit={save} className="space-y-3">
          <Field label="本文" wide>
            <Textarea
              value={values.body}
              onChange={(event) => setValues({ ...values, body: event.target.value })}
              rows={3}
            />
          </Field>
          <Field label="tags（カンマ区切り）">
            <Input
              type="text"
              value={values.tags}
              onChange={(event) => setValues({ ...values, tags: event.target.value })}
              className="w-80"
            />
          </Field>
          <Field label="scope">
            <Select
              value={values.scope}
              onChange={(event) =>
                setValues({ ...values, scope: event.target.value as MemoryItem['scope'] })
              }
              className="w-72"
            >
              <option value="always">{SCOPE_LABELS.always}</option>
              <option value="tagged">{SCOPE_LABELS.tagged}</option>
            </Select>
          </Field>
          <div className="flex gap-2">
            <Button type="submit" variant="primary" disabled={busy}>
              保存
            </Button>
            <Button variant="danger" onClick={remove} disabled={busy}>
              消す
            </Button>
          </div>
        </form>
      </SubSection>

      {problem?.kind === 'conflict' && (
        <ErrorNote>
          開いたあとにファイルが変わった。読み直してから直す。{' '}
          <Button onClick={reloadLatest} disabled={busy}>
            読み直す
          </Button>
        </ErrorNote>
      )}
      {problem?.kind === 'other' && <ErrorNote>できなかった: {problem.message}</ErrorNote>}
    </>
  );
}
