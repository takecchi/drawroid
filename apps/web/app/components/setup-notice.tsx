import { useBackendStatus, useLlmSettings } from '@drawroid/swr';
import { AlertTriangle } from 'lucide-react';
import { Link } from 'react-router';

/**
 * 初めて開いた人が、何を設定すれば話せる・描けるかを分かるようにする案内。足りないものだけを、設定の欄へのリンクつきで出す。
 * - LLM が未設定: 話しかけても返事ができない
 * - バックエンド（Forge / A1111）に繋がらない: 描き始めても止まる
 * どちらも足りていれば何も出さない。読んでいる間も出さない（設定済みの人に、一瞬だけ案内が見えないように）
 */
export function SetupNotice() {
  const llm = useLlmSettings();
  const backend = useBackendStatus();
  const llmMissing = llm.data !== undefined && llm.data.config === null;
  const backendDown = backend.error !== undefined;
  if (!llmMissing && !backendDown) return null;
  const link = 'font-medium underline underline-offset-4';
  return (
    // role="note": 変わらない案内なので、読み上げの知らせ（status）にはしない。会話の画面の状態の知らせ（ChatLayout）と重ねないため
    <div
      role="note"
      aria-label="はじめに要る設定"
      className="flex items-start gap-2 rounded-md border border-warn/40 bg-warn/10 px-3 py-2 text-sm text-warn"
    >
      <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden />
      <div className="space-y-1">
        <p>はじめに設定が要る。</p>
        <ul className="list-disc space-y-1 pl-5">
          {llmMissing && (
            <li>
              LLM が未設定なので、話しかけても返事ができない。{' '}
              <Link to="/generate#llm" className={link}>
                LLM を設定する
              </Link>
            </li>
          )}
          {backendDown && (
            <li>
              画像のバックエンド（Forge / A1111）に繋がらないので、描き始めても止まる。{' '}
              <Link to="/generate#backend" className={link}>
                バックエンドを確かめる
              </Link>
            </li>
          )}
        </ul>
      </div>
    </div>
  );
}
