// repo のファイルを走査しない: この門自身のテストが印の逐語を持つため、走査すると自己参照で誤検出する。
// 読めなかったら「見つからなかった」ではなく赤くする（`unreadable`）: 2値にすると判定できない場合が黙って緑へ倒れるため。

/**
 * @typedef {{ id: string, label: string, pattern: RegExp }} AttributionMarker
 * @typedef {{ oid: string | null, headline: string, message: string }} CommitMessage
 * @typedef {{ source: string, markers: string[] }} Finding
 * @typedef {{ verdict: 'clean' | 'found' | 'unreadable', findings: Finding[] }} Verdict
 */

// 大小文字を区別しない: `Co-Authored-By` と `Co-authored-by` の両方の表記が実際に出回っているため。
// `git interpret-trailers` に判定を委ねない: `🤖 Generated with [Claude Code](...)` は `Key: value` の形ではなく、取りこぼすため。
// 行頭だけを見る: 本文で印に言及しただけの文まで赤くしないため。コードブロックや引用の中の行頭は赤にする（squash マージで本文がそのまま写るため）。
/** @type {AttributionMarker[]} */
export const ATTRIBUTION_MARKERS = [
  {
    id: 'co-authored-by',
    label: 'Co-Authored-By:',
    pattern: /^\s*co-authored-by:/im,
  },
  {
    id: 'generated-with',
    label: '🤖 Generated with',
    pattern: /^\s*🤖\s*generated with/im,
  },
];

/**
 * @param {unknown} text
 * @returns {string[]}
 */
export function findAttributionMarkers(text) {
  if (typeof text !== 'string' || text.length === 0) return [];
  return ATTRIBUTION_MARKERS.filter((marker) => marker.pattern.test(text)).map(
    (marker) => marker.label,
  );
}

/**
 * @param {unknown} headline
 * @param {unknown} messageBody
 * @returns {string}
 */
export function commitFullMessage(headline, messageBody) {
  const h = typeof headline === 'string' ? headline : '';
  const b = typeof messageBody === 'string' ? messageBody : '';
  return b.length > 0 ? `${h}\n\n${b}` : h;
}

/**
 * @param {{ body: string | null, commits: CommitMessage[] | null }} input
 * @returns {Verdict}
 */
export function evaluateNoAttributionTrailers({ body, commits }) {
  if (body === null || commits === null) {
    return { verdict: 'unreadable', findings: [] };
  }

  /** @type {Finding[]} */
  const findings = [];

  const bodyMarkers = findAttributionMarkers(body);
  if (bodyMarkers.length > 0) {
    findings.push({ source: 'PR 本文', markers: bodyMarkers });
  }

  for (const commit of commits) {
    const markers = findAttributionMarkers(commit.message);
    if (markers.length === 0) continue;
    const oidShort = commit.oid ? commit.oid.slice(0, 7) : '(sha不明)';
    const headline = commit.headline ? ` "${commit.headline}"` : '';
    findings.push({ source: `commit ${oidShort}${headline}`, markers });
  }

  return { verdict: findings.length > 0 ? 'found' : 'clean', findings };
}

/**
 * @param {string} prNumber
 * @param {Verdict} result
 * @returns {string}
 */
export function formatVerdict(prNumber, result) {
  const header = `check-no-attribution-trailers(#${prNumber}):`;
  switch (result.verdict) {
    case 'unreadable':
      return (
        `${header} 判定できなかった —— PR 本文かコミットメッセージを読めなかった` +
        '（「見つからなかった」ではなく赤くする）'
      );
    case 'found':
      return [
        `${header} NG —— Co-Authored-By: / 🤖 Generated with が残っている`,
        ...result.findings.map((f) => `  ${f.source}: ${f.markers.join(', ')}`),
      ].join('\n');
    case 'clean':
      return (
        `${header} OK —— PR 本文・全コミットメッセージのどちらにも ` +
        'Co-Authored-By: / 🤖 Generated with が無い'
      );
  }
}
