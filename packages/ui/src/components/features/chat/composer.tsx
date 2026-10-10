import { ImagePlus, Send, Square, X } from 'lucide-react';
import {
  useEffect,
  useRef,
  type ChangeEvent,
  type FormEvent,
  type KeyboardEvent,
  type ReactNode,
} from 'react';

import { COMPOSER_FIELD_ID } from '../../app-shell/skip-link';
import { Button, Textarea } from '../../common';

/** 発言に添える画像の1枚。url は縮小版に使う（呼び手が object URL を作り、外したら片付ける） */
export interface ComposerAttachment {
  id: string;
  name: string;
  url: string;
}

/**
 * 発言の入力欄。返答中（`running`）でも送れる: 返答の途中で口を出すのが、この画面の使い方だから。
 * Enter で送り、Shift+Enter で改行する。かな漢字の変換を確定する Enter では送らない。
 */
export function ChatComposer({
  value,
  onChange,
  onSend,
  onStop,
  running = false,
  sending = false,
  // 「Enter で送る」は書かない: 入力欄は案内文の長さまで伸びるので、狭い幅で止めるボタンと並ぶと4段になる。送るのは Enter と見込める
  placeholder = '話しかける（Shift+Enter で改行）',
  notice,
  attachments = [],
  onAttach,
  onRemoveAttachment,
  accept = 'image/png,image/jpeg,image/webp',
  focusOnMount = false,
}: {
  value: string;
  onChange: (value: string) => void;
  onSend: () => void;
  /** 止めるボタン。走っている間だけ出す */
  onStop?: () => void;
  running?: boolean;
  /** 送っている最中（二重に送らない） */
  sending?: boolean;
  placeholder?: string;
  /** 入力欄の上に添える知らせ（送れなかった理由など） */
  notice?: ReactNode;
  /** 添えた画像。発言と一緒に送る */
  attachments?: readonly ComposerAttachment[];
  /** 画像を選んだとき。渡したときだけ「画像を添える」を出す */
  onAttach?: (files: File[]) => void;
  onRemoveAttachment?: (id: string) => void;
  accept?: string;
  /** 出たときに発言欄へフォーカスを移す。新しい会話を始めたときだけ渡す（開き直しただけでは移さない） */
  focusOnMount?: boolean;
}) {
  const canSend = !sending && value.trim() !== '';
  const picker = useRef<HTMLInputElement>(null);
  const form = useRef<HTMLFormElement>(null);
  // 外した添付の位置。外したあとの描き直しで、残りの添付か「画像を添える」へフォーカスを移すために覚える
  const removedAt = useRef<number | null>(null);

  // 押したボタン（送る・止める・外す）は消えるか押せなくなるので、フォーカスの行き先を決めて移す。
  // 移さないとページの外（body）に落ち、キーボードの人はページの先頭から辿り直すことになるため
  function focusField() {
    form.current?.querySelector('textarea')?.focus();
  }

  useEffect(() => {
    if (focusOnMount) focusField();
    // 出たときの一度だけ: 描き直すたびに移すと、ほかの所を触っている人からフォーカスを奪うため
  }, []);

  useEffect(() => {
    const at = removedAt.current;
    if (at === null) return;
    removedAt.current = null;
    const removes =
      form.current?.querySelectorAll<HTMLButtonElement>('ul[aria-label="添える画像"] button') ?? [];
    const next = removes[Math.min(at, removes.length - 1)];
    (
      next ?? form.current?.querySelector<HTMLButtonElement>('button[aria-label="画像を添える"]')
    )?.focus();
  }, [attachments]);

  function pick(event: ChangeEvent<HTMLInputElement>) {
    const files = Array.from(event.target.files ?? []);
    // 同じ画像を選び直しても change が起きるように、選択を空へ戻す
    event.target.value = '';
    if (files.length > 0) onAttach?.(files);
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    if (!canSend) return;
    onSend();
    focusField();
  }

  function keyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    // isComposing だけに頼らない: Safari は変換の確定の Enter で isComposing を false にして keyCode 229 を出すため
    if (event.key !== 'Enter' || event.shiftKey) return;
    if (event.nativeEvent.isComposing || event.keyCode === 229) return;
    event.preventDefault();
    if (canSend) onSend();
  }

  return (
    <form ref={form} onSubmit={submit} className="space-y-2">
      {notice}
      {attachments.length > 0 && (
        <ul aria-label="添える画像" className="flex flex-wrap gap-2">
          {attachments.map((attachment, index) => (
            <li key={attachment.id} className="relative">
              <img
                src={attachment.url}
                alt={attachment.name}
                className="size-14 rounded-md border border-border object-cover"
              />
              {onRemoveAttachment !== undefined && (
                <button
                  type="button"
                  aria-label={`${attachment.name} を外す`}
                  disabled={sending}
                  onClick={() => {
                    removedAt.current = index;
                    onRemoveAttachment(attachment.id);
                  }}
                  className="absolute -top-2 -right-2 flex size-6 items-center justify-center rounded-full border border-border bg-background text-muted-foreground hover:text-foreground disabled:opacity-50"
                >
                  <X className="size-3.5" aria-hidden />
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      <div className="flex items-end gap-2">
        {onAttach !== undefined && (
          <>
            {/* 選ぶ口は見せずにボタンから開く: 標準の「ファイルを選択」は狭い画面で幅を取り、文言も環境で変わるため */}
            <input
              ref={picker}
              type="file"
              multiple
              accept={accept}
              onChange={pick}
              className="sr-only"
              tabIndex={-1}
              aria-label="添える画像を選ぶ"
            />
            <Button
              aria-label="画像を添える"
              title="画像を添える"
              disabled={sending}
              onClick={() => picker.current?.click()}
              className="min-h-11 px-3 md:min-h-9"
            >
              <ImagePlus className="size-4" aria-hidden />
            </Button>
          </>
        )}
        <Textarea
          id={COMPOSER_FIELD_ID}
          aria-label="発言"
          value={value}
          onChange={(event) => onChange(event.target.value)}
          onKeyDown={keyDown}
          placeholder={placeholder}
          rows={1}
          maxHeight="min(40dvh,15rem)"
          className="min-h-11 flex-1 md:min-h-9"
        />
        {/* 狭い画面では、止める・送るも印だけにする（名前は読み上げに残す）: 文字のままだと、描いている間は入力欄が細くなり、
            案内の文が3段に折れるため。押しやすいよう、高さは「画像を添える」とそろえる */}
        {running && onStop !== undefined && (
          <Button
            variant="danger"
            onClick={() => {
              onStop();
              focusField();
            }}
            aria-label="止める"
            title="止める"
            className="min-h-11 px-3 md:min-h-9"
          >
            <Square className="size-3.5 fill-current" aria-hidden />
            <span className="max-md:sr-only">止める</span>
          </Button>
        )}
        <Button
          type="submit"
          variant="primary"
          disabled={!canSend}
          loading={sending}
          title="送る"
          className="min-h-11 px-3 md:min-h-9"
        >
          {!sending && <Send className="size-4" aria-hidden />}
          <span className="max-md:sr-only">送る</span>
        </Button>
      </div>
    </form>
  );
}
