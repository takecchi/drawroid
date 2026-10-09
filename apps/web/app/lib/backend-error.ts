import type { BackendErrorKind } from '@drawroid/core';

export interface BackendErrorDescription {
  // 何が起きたか
  summary: string;
  // 人間が次にやること
  action: string;
}

// Record にする: kind が増えたとき、説明を足し忘れると型で落ちるため
const DESCRIPTIONS: Record<BackendErrorKind, BackendErrorDescription> = {
  unreachable: {
    summary: 'Forge に繋がらない。',
    action: 'Forge が起動しているか、URL とポートが合っているかを確かめる。',
  },
  not_found: {
    summary: '繋がったが Forge の API が無い。',
    action: 'URL が違うか、Forge を --api 付きで起動していない。URL と起動オプションを確かめる。',
  },
  unauthorized: {
    summary: '認証に失敗した。',
    action: 'Forge の --api-auth と config.json の backend.auth が合っているかを確かめる。',
  },
  timeout: {
    summary: 'Forge が時間内に応答しなかった。',
    action:
      'Forge が別の重い処理をしていないかを確かめる。生成が長引くなら config.json の backend.generateTimeoutMs を延ばす。',
  },
  aborted: {
    summary: '処理が途中で止められた。',
    action: '意図して止めたのでなければ、もう一度やり直す。',
  },
  bad_response: {
    summary: 'Forge の応答の形が想定と違う。',
    action:
      'URL が Forge ではない別のサービスを指していないか、Forge のバージョンが古すぎないかを確かめる。',
  },
  failed: {
    summary: 'Forge が処理に失敗したと返した。',
    action: 'メモリ不足などが考えられる。Forge のログを見て、画像サイズや枚数を小さくして試す。',
  },
};

// 文字列を受ける: API のエラーの kind はバックエンド以外（invalid_request・network など）も取るため、該当しないものは undefined で返す
export function describeBackendError(kind: string): BackendErrorDescription | undefined {
  return Object.hasOwn(DESCRIPTIONS, kind) ? DESCRIPTIONS[kind as BackendErrorKind] : undefined;
}
