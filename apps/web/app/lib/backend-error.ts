import type { BackendErrorKind } from '@drawroid/core';
import type { BackendSettingsResponse } from '@drawroid/swr';

export type BackendKind = BackendSettingsResponse['kind'];

export const BACKEND_KIND_LABELS: Record<BackendKind, string> = {
  forge: 'Forge',
  a1111: 'A1111',
};

// 種類がまだ分からないとき（読み込み中・読めない）は、特定の名前に寄せない
const NEUTRAL_NAME = 'バックエンド（Forge / A1111）';

// 欧文の名前のあとには空白を置く（既存の「Forge に…」の書き方）
export function backendSubject(backendKind: BackendKind | undefined): string {
  return backendKind === undefined ? NEUTRAL_NAME : `${BACKEND_KIND_LABELS[backendKind]} `;
}

export interface BackendErrorDescription {
  // 何が起きたか
  summary: string;
  // 人間が次にやること
  action: string;
}

// Record にする: kind が増えたとき、説明を足し忘れると型で落ちるため
const DESCRIPTIONS: Record<BackendErrorKind, (name: string) => BackendErrorDescription> = {
  unreachable: (name) => ({
    summary: `${name}に繋がらない。`,
    action: `${name}が起動しているか、URL とポートが合っているかを確かめる。`,
  }),
  not_found: (name) => ({
    summary: `繋がったが ${name}の API が無い。`,
    action: `URL が違うか、${name}を --api 付きで起動していない。URL と起動オプションを確かめる。`,
  }),
  unauthorized: (name) => ({
    summary: '認証に失敗した。',
    action: `${name}の --api-auth と config.json の backend.auth が合っているかを確かめる。`,
  }),
  timeout: (name) => ({
    summary: `${name}が時間内に応答しなかった。`,
    action: `${name}が別の重い処理をしていないかを確かめる。生成が長引くなら config.json の backend.generateTimeoutMs を延ばす。`,
  }),
  aborted: () => ({
    summary: '処理が途中で止められた。',
    action: '意図して止めたのでなければ、もう一度やり直す。',
  }),
  bad_response: (name) => ({
    summary: `${name}の応答の形が想定と違う。`,
    action: `URL が ${name}ではない別のサービスを指していないか、${name}のバージョンが古すぎないかを確かめる。`,
  }),
  failed: (name) => ({
    summary: `${name}が処理に失敗したと返した。`,
    action: `メモリ不足などが考えられる。${name}のログを見て、画像サイズや枚数を小さくして試す。`,
  }),
};

// 文字列を受ける: API のエラーの kind はバックエンド以外（invalid_request・network など）も取るため、該当しないものは undefined で返す
export function describeBackendError(
  kind: string,
  backendKind?: BackendKind,
): BackendErrorDescription | undefined {
  return Object.hasOwn(DESCRIPTIONS, kind)
    ? DESCRIPTIONS[kind as BackendErrorKind](backendSubject(backendKind))
    : undefined;
}
