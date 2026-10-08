import { describe, expect, it } from 'vitest';

import {
  commitFullMessage,
  evaluateNoAttributionTrailers,
  findAttributionMarkers,
  formatVerdict,
} from './check-no-attribution-trailers-core.mjs';

const COAUTHOR = 'Co-Authored-By: Claude <noreply@example.com>';
const GENERATED = '🤖 Generated with [Claude Code](https://claude.com/claude-code)';

describe('findAttributionMarkers', () => {
  it('finds Co-Authored-By: regardless of case', () => {
    expect(findAttributionMarkers(`本文\n\n${COAUTHOR}`)).toEqual(['Co-Authored-By:']);
    expect(findAttributionMarkers('本文\n\nCo-authored-by: Claude <x@example.com>')).toEqual([
      'Co-Authored-By:',
    ]);
  });

  it('finds the 🤖 Generated with footer', () => {
    expect(findAttributionMarkers(GENERATED)).toEqual(['🤖 Generated with']);
  });

  it('finds both when both are present', () => {
    expect(findAttributionMarkers(`本文\n\n${GENERATED}\n\n${COAUTHOR}`)).toEqual([
      'Co-Authored-By:',
      '🤖 Generated with',
    ]);
  });

  it('finds a marker at the start of a line inside a code block', () => {
    expect(findAttributionMarkers(`\`\`\`\n${COAUTHOR}\n\`\`\``)).toEqual(['Co-Authored-By:']);
  });

  it('ignores a marker mentioned in the middle of a sentence', () => {
    expect(findAttributionMarkers('`Co-Authored-By:` トレーラは付けない、と書く。')).toEqual([]);
    expect(findAttributionMarkers('本文に 🤖 Generated with と書かない、と説明する。')).toEqual([]);
  });

  it('needs both the robot and the phrase for the footer', () => {
    expect(findAttributionMarkers('🤖 で始まる、関係ない一文。')).toEqual([]);
    expect(findAttributionMarkers('Generated with love, by a human.')).toEqual([]);
  });

  it('returns nothing for empty or non-string input', () => {
    expect(findAttributionMarkers('')).toEqual([]);
    expect(findAttributionMarkers(null)).toEqual([]);
    expect(findAttributionMarkers(undefined)).toEqual([]);
  });
});

describe('commitFullMessage', () => {
  it('joins the headline and body with a blank line', () => {
    expect(commitFullMessage('chore: x', 'なぜ')).toBe('chore: x\n\nなぜ');
  });

  it('returns only the headline when the body is empty', () => {
    expect(commitFullMessage('chore: x', '')).toBe('chore: x');
  });
});

describe('evaluateNoAttributionTrailers', () => {
  const cleanCommit = { oid: 'abcdef1234', headline: 'chore: x', message: 'chore: x\n\nなぜ' };

  it('is clean when neither the body nor any commit has a marker', () => {
    expect(evaluateNoAttributionTrailers({ body: 'ふつうの本文', commits: [cleanCommit] })).toEqual(
      { verdict: 'clean', findings: [] },
    );
  });

  it('reports a marker in the PR body', () => {
    const result = evaluateNoAttributionTrailers({ body: GENERATED, commits: [cleanCommit] });
    expect(result.verdict).toBe('found');
    expect(result.findings).toEqual([{ source: 'PR 本文', markers: ['🤖 Generated with'] }]);
  });

  it('reports a marker in a commit with its short sha and headline', () => {
    const result = evaluateNoAttributionTrailers({
      body: '',
      commits: [cleanCommit, { oid: '1234567890', headline: 'feat: y', message: COAUTHOR }],
    });
    expect(result.findings).toEqual([
      { source: 'commit 1234567 "feat: y"', markers: ['Co-Authored-By:'] },
    ]);
  });

  it('is unreadable, not clean, when the body or commits could not be read', () => {
    expect(evaluateNoAttributionTrailers({ body: null, commits: [] }).verdict).toBe('unreadable');
    expect(evaluateNoAttributionTrailers({ body: '', commits: null }).verdict).toBe('unreadable');
  });
});

describe('formatVerdict', () => {
  it('lists every finding under the NG header', () => {
    const text = formatVerdict('7', {
      verdict: 'found',
      findings: [{ source: 'PR 本文', markers: ['Co-Authored-By:'] }],
    });
    expect(text).toContain('#7');
    expect(text).toContain('NG');
    expect(text).toContain('PR 本文: Co-Authored-By:');
  });
});
