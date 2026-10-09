import {
  isApiError,
  parseStopConditionsText,
  type StopConditionsDraftResponse,
} from '@drawroid/swr';
import { useState } from 'react';

import {
  stopConditionsBlocker,
  stopConditionsToForm,
  type StopConditionsFormValues,
} from '../lib/stop-conditions-form';

type Draft = StopConditionsDraftResponse['draft'];

// 理由は API の kind で分ける: 未設定は人間が LLM を設定すれば直るが、変換の失敗は文を書き直す話で、対処が違うため
function describeParseError(error: unknown): string {
  if (!isApiError(error)) throw error;
  if (error.kind === 'llm_not_configured') {
    return `LLM が未設定なので文から案を作れない。下の欄に直接書くこともできる（${error.message}）`;
  }
  if (error.kind === 'unparsable') return `文を読み取れなかった: ${error.message}`;
  return error.message;
}

export function StopConditionsEditor({
  values,
  onChange,
  confirm,
}: {
  values: StopConditionsFormValues;
  onChange: (values: StopConditionsFormValues) => void;
  /** 付けると確定のボタンを出す。止まらない条件のあいだは押せない */
  confirm?: { label: string; pending: boolean; onConfirm: () => void };
}) {
  const [text, setText] = useState('');
  const [parsing, setParsing] = useState(false);
  const [parseError, setParseError] = useState<string | undefined>();
  const [notes, setNotes] = useState<Pick<Draft, 'unparsed' | 'clippedFrom'> | undefined>();
  const [warnings, setWarnings] = useState<Draft['warnings']>([]);

  async function makeDraft() {
    setParsing(true);
    setParseError(undefined);
    try {
      const { draft } = await parseStopConditionsText(text);
      onChange(stopConditionsToForm(draft.conditions));
      setNotes({ unparsed: draft.unparsed, clippedFrom: draft.clippedFrom });
      // never-stops は案の警告として持たない: blocker が同じ文言を常に出しており、案の直後に2回並ぶため
      setWarnings(draft.warnings.filter((warning) => warning.kind !== 'never-stops'));
    } catch (caught) {
      setParseError(describeParseError(caught));
    } finally {
      setParsing(false);
    }
  }

  // 手で直したら案の警告を消す: 直したあとの条件には当てはまらず、止まるかどうかは blocker が今の値で出すため
  const edit = (patch: Partial<StopConditionsFormValues>) => {
    setWarnings([]);
    onChange({ ...values, ...patch });
  };
  const blocker = stopConditionsBlocker(values);

  return (
    <fieldset>
      <legend>止める条件</legend>
      <p>
        <label>
          文から案を作る
          <br />
          <textarea
            value={text}
            onChange={(event) => setText(event.target.value)}
            rows={2}
            cols={60}
            placeholder="例: 10 回まで。AI が良いと思ったら途中で止めてよい"
          />
        </label>
        <br />
        <button
          type="button"
          disabled={parsing || text.trim() === ''}
          onClick={() => void makeDraft()}
        >
          案を作る
        </button>
      </p>
      {parseError !== undefined && <p role="alert">{parseError}</p>}
      {notes?.clippedFrom !== undefined && (
        <p>入力が長いので途中で切って読んだ（{notes.clippedFrom} 文字のうち先頭だけ）</p>
      )}
      {notes !== undefined && notes.unparsed.length > 0 && (
        <div>
          <p>読み落とした言い回し（止める条件では表せない）</p>
          <ul>
            {notes.unparsed.map((phrase, i) => (
              <li key={i}>{phrase}</li>
            ))}
          </ul>
        </div>
      )}
      {warnings.map((warning) => (
        <p key={warning.kind} role="alert">
          {warning.message}
        </p>
      ))}
      <p>
        <label>
          <input
            type="checkbox"
            checked={values.aiJudgement}
            onChange={(event) => edit({ aiJudgement: event.target.checked })}
          />{' '}
          AI が意図どおりと判断したら止める
        </label>
      </p>
      <p>
        <label>
          回数の上限{' '}
          <input
            value={values.maxIterations}
            onChange={(event) => edit({ maxIterations: event.target.value })}
            inputMode="numeric"
            size={6}
            placeholder="なし"
          />
        </label>{' '}
        <label>
          枚数の上限{' '}
          <input
            value={values.maxImages}
            onChange={(event) => edit({ maxImages: event.target.value })}
            inputMode="numeric"
            size={6}
            placeholder="なし"
          />
        </label>{' '}
        <label>
          時間の上限（分）{' '}
          <input
            value={values.maxDurationMinutes}
            onChange={(event) => edit({ maxDurationMinutes: event.target.value })}
            inputMode="decimal"
            size={6}
            placeholder="なし"
          />
        </label>
      </p>
      {blocker !== undefined && <p role="alert">{blocker}</p>}
      {confirm !== undefined && (
        <button
          type="button"
          disabled={blocker !== undefined || confirm.pending}
          onClick={confirm.onConfirm}
        >
          {confirm.label}
        </button>
      )}
    </fieldset>
  );
}
