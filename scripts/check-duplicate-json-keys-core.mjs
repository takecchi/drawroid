// JSON.parse に重なりの検出を任せない: 同じオブジェクトの中で鍵が重なると、後の鍵で黙って上書きするため。
// git の自動の取り込みが package.json に dependencies を2つ作り、片方の依存が黙って落ちたことがある。

/**
 * @typedef {{ verdict: 'clean' | 'duplicated' | 'unreadable', duplicates: string[], error: string | null }} JsonKeysVerdict
 */

/**
 * JSON の文字列を字句から読み、同じオブジェクトの中で重なった鍵の位置（`/dependencies` など）を返す。
 * @param {string} text
 * @returns {JsonKeysVerdict}
 */
export function findDuplicateJsonKeys(text) {
  try {
    JSON.parse(text);
  } catch (error) {
    return { verdict: 'unreadable', duplicates: [], error: String(error) };
  }

  let i = 0;
  /** @type {string[]} */
  const duplicates = [];

  const skipSpace = () => {
    while (i < text.length && /\s/.test(text.charAt(i))) i++;
  };
  /** @returns {string} */
  const readString = () => {
    const start = i;
    i++;
    while (text.charAt(i) !== '"') i += text.charAt(i) === '\\' ? 2 : 1;
    i++;
    return JSON.parse(text.slice(start, i));
  };
  /** @param {string} path */
  const readValue = (path) => {
    skipSpace();
    const c = text.charAt(i);
    if (c === '{') {
      i++;
      const seen = new Set();
      skipSpace();
      if (text.charAt(i) === '}') {
        i++;
        return;
      }
      for (;;) {
        skipSpace();
        const key = readString();
        const keyPath = `${path}/${key}`;
        if (seen.has(key)) duplicates.push(keyPath);
        seen.add(key);
        skipSpace();
        i++; // ':'
        readValue(keyPath);
        skipSpace();
        if (text.charAt(i++) === '}') return;
      }
    }
    if (c === '[') {
      i++;
      skipSpace();
      if (text.charAt(i) === ']') {
        i++;
        return;
      }
      for (let n = 0; ; n++) {
        readValue(`${path}[${n}]`);
        skipSpace();
        if (text.charAt(i++) === ']') return;
      }
    }
    if (c === '"') {
      readString();
      return;
    }
    while (i < text.length && !/[,}\]\s]/.test(text.charAt(i))) i++;
  };

  readValue('');
  return { verdict: duplicates.length === 0 ? 'clean' : 'duplicated', duplicates, error: null };
}
