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
  OkNote,
  Section,
  Select,
  SubSection,
  Textarea,
} from '@drawroid/ui';
import { useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router';

import { KIND_LABELS } from '../lib/job-labels';
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
      {/* 画面の頭の見出しにする（h1）: この部品は記憶の1項目の画面にだけ置かれ、画面にほかの h1 が無いため。
          見える題を足さずに見た目を変えない（sr-only は流れから外れ、枠の隙間も増えない）。本文は長いので題にせず、どの画面かを言う */}
      <h1 className="sr-only">記憶の項目</h1>
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
  // 保存が通ったことの知らせ。保存しても欄の見た目は変わらないので、効いたことを知らせる
  const [saved, setSaved] = useState(false);
  const navigate = useNavigate();

  function open(item: MemoryItem) {
    setBase(item);
    setValues(memoryToFormValues(item));
    setProblem(undefined);
  }

  // 欄を触ったら、知らせは古くなる
  function edit(next: MemoryFormValues) {
    setValues(next);
    setSaved(false);
  }

  async function run(action: () => Promise<void>) {
    setBusy(true);
    // 送っている間は消す: 2回続けて保存したとき、知らせを作り直してフォーカスをもう一度移すため
    setSaved(false);
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
      const result = await saveMemoryItem(id, buildSaveInput(values, base.updatedAt));
      open(result.item);
      setSaved(true);
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

      <SubSection title="学んだ元" level={2}>
        {detail.sources.length === 0 && <Muted>無い。</Muted>}
        <ItemList>
          {detail.sources.map((source) =>
            source.kind === 'conversation' ? (
              <Item key={`conversation:${source.conversationId}`}>
                会話{' '}
                <Link
                  to={`/conversations/${encodeURIComponent(source.conversationId)}`}
                  className="underline underline-offset-2"
                >
                  <code>{source.conversationId}</code>
                </Link>
              </Item>
            ) : (
              <Item key={source.jobId}>
                <Link
                  to={`/jobs/${encodeURIComponent(source.jobId)}`}
                  className="underline underline-offset-2"
                >
                  <code>{source.jobId}</code>
                </Link>{' '}
                {source.job === null ? (
                  '消えたジョブ'
                ) : (
                  <>
                    {KIND_LABELS[source.job.kind]} {formatTime(source.job.createdAt)}{' '}
                    {source.job.request.slice(0, 60)}
                  </>
                )}
              </Item>
            ),
          )}
        </ItemList>
      </SubSection>

      <SubSection title="直す" level={2}>
        <form onSubmit={save} className="space-y-3">
          <Field label="本文" wide>
            <Textarea
              value={values.body}
              onChange={(event) => edit({ ...values, body: event.target.value })}
              rows={3}
            />
          </Field>
          <Field label="tags（カンマ区切り）">
            <Input
              type="text"
              value={values.tags}
              onChange={(event) => edit({ ...values, tags: event.target.value })}
              className="w-80"
            />
          </Field>
          <Field label="scope">
            <Select
              value={values.scope}
              onChange={(event) =>
                edit({ ...values, scope: event.target.value as MemoryItem['scope'] })
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

      {saved && <OkNote focus>保存した。次に記憶を渡すときから効く。</OkNote>}
      {problem?.kind === 'conflict' && (
        <ErrorNote focus>
          開いたあとにファイルが変わった。読み直してから直す。{' '}
          <Button onClick={reloadLatest} disabled={busy}>
            読み直す
          </Button>
        </ErrorNote>
      )}
      {problem?.kind === 'other' && <ErrorNote focus>できなかった: {problem.message}</ErrorNote>}
    </>
  );
}
