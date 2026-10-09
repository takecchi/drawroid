import { useEffect, useRef, useState, type ChangeEvent } from 'react';

import {
  MAX_REFERENCES_PER_REQUEST,
  REFERENCE_MEDIA_TYPES,
  referenceFileProblem,
  type AttachedReference,
} from '../lib/reference-upload';

// 縮小表示ごとに object URL を作り、外れたら revoke する: 作りっぱなしだと、選び直すたびに画像のメモリが解放されないため
function Thumbnail({ file }: { file: File }) {
  const [url, setUrl] = useState<string | undefined>();
  useEffect(() => {
    const objectUrl = URL.createObjectURL(file);
    setUrl(objectUrl);
    return () => URL.revokeObjectURL(objectUrl);
  }, [file]);
  return url === undefined ? null : (
    <img src={url} alt={file.name} style={{ maxWidth: 96, maxHeight: 96 }} />
  );
}

/** 参照画像を選んで、用途の言葉を添える。送るのは呼び手（投入・口出しで送り先が違うため） */
export function ReferenceAttacher({
  items,
  onChange,
  disabled = false,
}: {
  items: AttachedReference[];
  onChange: (items: AttachedReference[]) => void;
  disabled?: boolean;
}) {
  const [refusals, setRefusals] = useState<string[]>([]);
  const nextId = useRef(0);

  function pick(event: ChangeEvent<HTMLInputElement>) {
    const picked = Array.from(event.target.files ?? []);
    // 同じファイルを選び直しても change が起きるように、選択を空へ戻す
    event.target.value = '';
    const accepted: AttachedReference[] = [];
    const reasons: string[] = [];
    for (const file of picked) {
      const problem = referenceFileProblem(file, items.length + accepted.length);
      if (problem === undefined) accepted.push({ id: `ref-${nextId.current++}`, file, note: '' });
      else reasons.push(problem);
    }
    setRefusals(reasons);
    if (accepted.length > 0) onChange([...items, ...accepted]);
  }

  return (
    <fieldset>
      <legend>参照画像（{MAX_REFERENCES_PER_REQUEST} 枚まで）</legend>
      <p>
        <label>
          参照画像を選ぶ{' '}
          <input
            type="file"
            multiple
            accept={REFERENCE_MEDIA_TYPES.join(',')}
            disabled={disabled}
            onChange={pick}
          />
        </label>
      </p>
      {refusals.map((reason) => (
        <p key={reason} role="alert">
          添えられない: {reason}
        </p>
      ))}
      <ul>
        {items.map((item) => (
          <li key={item.id}>
            <Thumbnail file={item.file} />{' '}
            <label>
              用途の言葉{' '}
              <input
                value={item.note}
                aria-label={`用途の言葉（${item.file.name}）`}
                onChange={(event) =>
                  onChange(
                    items.map((it) =>
                      it.id === item.id ? { ...it, note: event.target.value } : it,
                    ),
                  )
                }
                size={30}
                placeholder="例: この構図で"
              />
            </label>{' '}
            <button
              type="button"
              disabled={disabled}
              aria-label={`${item.file.name} を外す`}
              onClick={() => onChange(items.filter((it) => it.id !== item.id))}
            >
              外す
            </button>
          </li>
        ))}
      </ul>
    </fieldset>
  );
}
