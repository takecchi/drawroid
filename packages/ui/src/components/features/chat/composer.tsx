import { Send, Square } from 'lucide-react';
import type { FormEvent, KeyboardEvent, ReactNode } from 'react';

import { Button, Textarea } from '../../common';

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
}) {
  const canSend = !sending && value.trim() !== '';

  function submit(event: FormEvent) {
    event.preventDefault();
    if (canSend) onSend();
  }

  function keyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    // isComposing だけに頼らない: Safari は変換の確定の Enter で isComposing を false にして keyCode 229 を出すため
    if (event.key !== 'Enter' || event.shiftKey) return;
    if (event.nativeEvent.isComposing || event.keyCode === 229) return;
    event.preventDefault();
    if (canSend) onSend();
  }

  return (
    <form onSubmit={submit} className="space-y-2">
      {notice}
      <div className="flex items-end gap-2">
        <Textarea
          aria-label="発言"
          value={value}
          onChange={(event) => onChange(event.target.value)}
          onKeyDown={keyDown}
          placeholder={placeholder}
          rows={2}
          className="max-h-48 min-h-10 flex-1 resize-none"
        />
        {running && onStop !== undefined && (
          <Button variant="danger" onClick={onStop} aria-label="止める" className="h-10">
            <Square className="size-3.5 fill-current" />
            止める
          </Button>
        )}
        <Button type="submit" variant="primary" disabled={!canSend} className="h-10">
          <Send className="size-4" />
          送る
        </Button>
      </div>
    </form>
  );
}
