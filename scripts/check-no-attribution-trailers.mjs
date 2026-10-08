#!/usr/bin/env node
// 使い方: pnpm check:no-attribution-trailers --pr N --repo owner/repo
// （環境変数 NO_ATTRIBUTION_TRAILERS_PR_NUMBER / GITHUB_REPOSITORY でも渡せる。clean は 0、それ以外は 1）

import { execFileSync } from 'node:child_process';
import process from 'node:process';
import { parseArgs } from 'node:util';

import {
  commitFullMessage,
  evaluateNoAttributionTrailers,
  formatVerdict,
} from './check-no-attribution-trailers-core.mjs';

// 本文とコミットを1回で取る: イベントの payload の本文は run を起こした時点の写しで、後から直した本文を見ないため。
/**
 * @param {string} prNumber
 * @param {string} repo
 * @returns {{ data: { body?: unknown, commits?: unknown } | null, error: string | null }}
 */
function fetchPr(prNumber, repo) {
  try {
    const stdout = execFileSync(
      'gh',
      ['pr', 'view', prNumber, '--repo', repo, '--json', 'body,commits'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    );
    return { data: JSON.parse(stdout), error: null };
  } catch (error) {
    const detail =
      error !== null && typeof error === 'object' && 'stderr' in error && error.stderr
        ? String(error.stderr).trim()
        : String(error);
    return { data: null, error: detail };
  }
}

function main() {
  const { values } = parseArgs({
    options: { pr: { type: 'string' }, repo: { type: 'string' } },
  });
  const prNumber = values.pr ?? process.env.NO_ATTRIBUTION_TRAILERS_PR_NUMBER ?? '';
  const repo = values.repo ?? process.env.GITHUB_REPOSITORY ?? '';

  // 引数が欠けたら呼び方の誤りとして 1 を返す: 緑にしないため。
  if (!/^\d+$/.test(prNumber) || repo === '') {
    process.stderr.write(
      'check-no-attribution-trailers: 呼び方の誤り —— --pr / --repo（または ' +
        'NO_ATTRIBUTION_TRAILERS_PR_NUMBER / GITHUB_REPOSITORY）が要る\n',
    );
    process.exitCode = 1;
    return;
  }

  const { data, error } = fetchPr(prNumber, repo);
  /** @type {string | null} */
  let body = null;
  /** @type {import('./check-no-attribution-trailers-core.mjs').CommitMessage[] | null} */
  let commits = null;
  /** @type {string[]} */
  const fetchErrors = [];

  if (data === null) {
    fetchErrors.push(`gh pr view が失敗した: ${error}`);
  } else {
    body = typeof data.body === 'string' ? data.body : '';
    if (Array.isArray(data.commits)) {
      commits = data.commits.map((c) => ({
        oid: typeof c?.oid === 'string' ? c.oid : null,
        headline: typeof c?.messageHeadline === 'string' ? c.messageHeadline : '',
        message: commitFullMessage(c?.messageHeadline, c?.messageBody),
      }));
    } else {
      fetchErrors.push('gh pr view の応答に commits 配列が無い（応答の形が想定と違う）');
    }
  }

  const result = evaluateNoAttributionTrailers({ body, commits });
  const text = formatVerdict(prNumber, result);
  if (result.verdict === 'clean') {
    process.stdout.write(text + '\n');
    return;
  }
  process.stderr.write(text + '\n');
  for (const detail of fetchErrors) process.stderr.write(`  ${detail}\n`);
  process.exitCode = 1;
}

main();
