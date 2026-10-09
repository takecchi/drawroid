import { readPermissionOverrides, type Permissions } from '@drawroid/core';

/**
 * config.json の全体の既定の許可を、行ごとに読む関数を作る。読めない行は外し（既定に戻る）、ログに出す。
 */
// ログは読めない行が変わったときだけ出す: 回の境目ごとに読み直すので、毎回出すと同じ行で埋まるため
export function createPermissionReader(
  read: () => Promise<unknown>,
  log: (line: string) => void,
): () => Promise<Partial<Permissions>> {
  let reported = '';
  return async () => {
    const { overrides, invalid } = readPermissionOverrides(await read());
    const report = invalid.map(({ param, reason }) => `${param}（${reason}）`).join('、');
    if (report !== reported) {
      log(
        report === ''
          ? 'drawroid: config.json の許可に、読めない許可は無くなった'
          : `drawroid: config.json の許可に読めない行がある。その行は既定に戻る: ${report}`,
      );
      reported = report;
    }
    return overrides;
  };
}
