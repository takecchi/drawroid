import {
  Button,
  ErrorNote,
  Field,
  FieldSet,
  FilePicker,
  Input,
  Item,
  ItemList,
} from '@drawroid/ui';
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
    <img src={url} alt={file.name} className="max-h-24 max-w-24 rounded" />
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
    <FieldSet legend={`参照画像（${MAX_REFERENCES_PER_REQUEST} 枚まで）`}>
      <Field label="参照画像を選ぶ">
        {/* 選んだ名前は添えた一覧から出す: 選び直すたびに input を空へ戻すので、input の側は最後の1回ぶんしか知らないため */}
        <FilePicker
          multiple
          accept={REFERENCE_MEDIA_TYPES.join(',')}
          disabled={disabled}
          onChange={pick}
          buttonLabel="画像を選ぶ"
          selected={items.map((item) => item.file.name)}
        />
      </Field>
      {refusals.map((reason) => (
        <ErrorNote key={reason}>添えられない: {reason}</ErrorNote>
      ))}
      <ItemList>
        {items.map((item) => (
          <Item key={item.id} className="items-center">
            <Thumbnail file={item.file} />
            <Field label="用途の言葉">
              <Input
                value={item.note}
                aria-label={`用途の言葉（${item.file.name}）`}
                onChange={(event) =>
                  onChange(
                    items.map((it) =>
                      it.id === item.id ? { ...it, note: event.target.value } : it,
                    ),
                  )
                }
                placeholder="例: この構図で"
                className="w-72"
              />
            </Field>
            <Button
              disabled={disabled}
              aria-label={`${item.file.name} を外す`}
              className="h-7 px-2 text-xs"
              onClick={() => onChange(items.filter((it) => it.id !== item.id))}
            >
              外す
            </Button>
          </Item>
        ))}
      </ItemList>
    </FieldSet>
  );
}
