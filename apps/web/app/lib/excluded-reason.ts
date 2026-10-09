import type { ExcludedReason } from '@drawroid/core';

export function describeExcludedReason(reason: ExcludedReason): string {
  switch (reason.kind) {
    case 'backend':
      return `バックエンドで使えない: ${reason.detail}`;
    case 'no-mask':
      return 'マスクが無い';
    case 'no-candidates-shown':
      return '候補を予算の内で1つも見せられなかった';
    case 'not-supported-yet':
      return 'まだ対応していない';
  }
}

export function describeWanted(wanted: 'auto' | 'fixed'): string {
  return wanted === 'auto' ? 'AI に任せる' : '固定';
}
