import { CANDIDATE_KINDS, type CandidateKind } from '@drawroid/core';
import { isApiError, saveCandidateNotes, useCandidateNotes, useCandidates } from '@drawroid/swr';
import { useState, type FormEvent } from 'react';

import {
  buildNotes,
  matchesFilter,
  MAX_CANDIDATE_NOTE_CHARS,
  orphanNames,
} from '../lib/candidate-notes-form';

const KIND_LABELS: Record<CandidateKind, string> = {
  checkpoint: 'checkpoint',
  vae: 'VAE',
  lora: 'LoRA',
  sampler: 'サンプラー',
  scheduler: 'スケジューラー',
  upscaler: 'Hires. fix の拡大の方式',
  controlnetModel: 'ControlNet のモデル',
  controlnetModule: 'ControlNet の前処理',
};

function NoteInput({
  name,
  text,
  onChange,
}: {
  name: string;
  text: string;
  onChange: (text: string) => void;
}) {
  return (
    <input
      type="text"
      aria-label={`${name} の説明`}
      value={text}
      onChange={(event) => onChange(event.target.value)}
      size={50}
    />
  );
}

type CandidateList = ReturnType<typeof useCandidates>;

// 種類ごとの候補を親でまとめて読む: どの候補にも無い説明を見分けるのに、全部の種類の名前が要るため。
// 種類の数と順番は CANDIDATE_KINDS で決まっているので、フックを呼ぶ順は描くたびに変わらない
function useAllCandidates(): Record<CandidateKind, CandidateList> {
  return {
    checkpoint: useCandidates('checkpoint'),
    vae: useCandidates('vae'),
    lora: useCandidates('lora'),
    sampler: useCandidates('sampler'),
    scheduler: useCandidates('scheduler'),
    upscaler: useCandidates('upscaler'),
    controlnetModel: useCandidates('controlnetModel'),
    controlnetModule: useCandidates('controlnetModule'),
  };
}

const namesOf = (list: CandidateList) => (list.data?.candidates ?? []).map((c) => c.name);

function KindSection({
  kind,
  list,
  filter,
  notes,
  onChange,
}: {
  kind: CandidateKind;
  list: CandidateList;
  filter: string;
  notes: Record<string, string>;
  onChange: (name: string, text: string) => void;
}) {
  const { data, error } = list;
  const names = namesOf(list);
  const shown = names.filter((name) => matchesFilter(name, filter));
  return (
    <section aria-label={KIND_LABELS[kind]}>
      <h3>{KIND_LABELS[kind]}</h3>
      {error !== undefined && <p role="alert">候補を読めない: {error.message}</p>}
      {data !== undefined && names.length === 0 && <p>候補が無い。</p>}
      {names.length > 0 && shown.length === 0 && <p>絞った名前に合う候補が無い。</p>}
      <dl>
        {shown.map((name) => (
          <div key={name}>
            <dt>{name}</dt>
            <dd>
              <NoteInput
                name={name}
                text={notes[name] ?? ''}
                onChange={(text) => onChange(name, text)}
              />
            </dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

/**
 * 候補（checkpoint・LoRA など）への人間の短い説明。保存した説明は、次のジョブから考える役に渡る。
 */
export function CandidateNotes() {
  const { data, error } = useCandidateNotes();
  // 触るまでは保存されている説明をそのまま出す: 読み込みが後から届いても、欄が空のまま残らないようにするため
  const [edited, setEdited] = useState<Record<string, string> | undefined>();
  const [filter, setFilter] = useState('');
  const [problem, setProblem] = useState<string | undefined>();
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const lists = useAllCandidates();

  const notes: Record<string, string> | undefined =
    edited ?? (data === undefined ? undefined : { ...data.notes });

  function change(name: string, text: string) {
    if (notes === undefined) return;
    setSaved(false);
    setEdited({ ...notes, [name]: text });
  }

  async function save(event: FormEvent) {
    event.preventDefault();
    if (notes === undefined) return;
    setProblem(undefined);
    setSaved(false);
    const built = buildNotes(notes);
    if (!built.ok) {
      setProblem(built.reason);
      return;
    }
    setSaving(true);
    try {
      await saveCandidateNotes(built.value);
      setEdited(undefined);
      setSaved(true);
    } catch (caught) {
      if (!isApiError(caught)) throw caught;
      setProblem(caught.message);
    } finally {
      setSaving(false);
    }
  }

  const orphans =
    notes === undefined
      ? []
      : orphanNames(
          Object.fromEntries(Object.entries(notes).filter(([, text]) => text.trim() !== '')),
          CANDIDATE_KINDS.flatMap((kind) => namesOf(lists[kind])),
        );

  return (
    <section>
      <h2>候補の説明</h2>
      <p>
        checkpoint・LoRA などに、人間の短い説明（{MAX_CANDIDATE_NOTE_CHARS}{' '}
        文字まで）を付ける。保存すると、次のジョブから考える役に渡る。
      </p>
      {error !== undefined && <p role="alert">説明を読めない: {error.message}</p>}
      {data?.problem !== undefined && (
        <p role="alert">
          説明のファイルを読めない: {data.problem}
          。いまは説明なしで動いている。保存すると、このファイルは画面の内容で置き換わる。
        </p>
      )}
      {notes !== undefined && (
        <form onSubmit={(event) => void save(event)}>
          <label>
            名前で絞る{' '}
            <input
              type="search"
              value={filter}
              onChange={(event) => setFilter(event.target.value)}
            />
          </label>
          {CANDIDATE_KINDS.map((kind) => (
            <KindSection
              key={kind}
              kind={kind}
              list={lists[kind]}
              filter={filter}
              notes={notes}
              onChange={change}
            />
          ))}
          {orphans.length > 0 && (
            <section aria-label="今の候補に無い説明">
              <h3>今の候補に無い説明</h3>
              <p>バックエンドの候補に無い名前への説明。考える役には渡らない。</p>
              <dl>
                {orphans.map((name) => (
                  <div key={name}>
                    <dt>{name}</dt>
                    <dd>
                      {notes[name]}{' '}
                      <button type="button" onClick={() => change(name, '')}>
                        {name} の説明を消す
                      </button>
                    </dd>
                  </div>
                ))}
              </dl>
            </section>
          )}
          <button type="submit" disabled={saving}>
            説明を保存
          </button>
        </form>
      )}
      {saved && <p>保存した。次のジョブから考える役に渡る。</p>}
      {problem !== undefined && <p role="alert">保存できない: {problem}</p>}
    </section>
  );
}
