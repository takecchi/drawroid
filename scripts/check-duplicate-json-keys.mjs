#!/usr/bin/env node
// 使い方: pnpm check:duplicate-json-keys [ファイル...]
// ファイルを渡さなければ、git が追っているすべての package.json を確かめる。重なりも読めないものも無ければ 0、それ以外は 1。

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import process from 'node:process';

import { findDuplicateJsonKeys } from './check-duplicate-json-keys-core.mjs';

// git ls-files で集める: node_modules や生成物の中の package.json まで見ないため
function trackedPackageJsons() {
  const stdout = execFileSync('git', ['ls-files', '--', 'package.json', '**/package.json'], {
    encoding: 'utf8',
  });
  return stdout.split('\n').filter((line) => line !== '');
}

function main() {
  const args = process.argv.slice(2);
  const files = args.length > 0 ? args : trackedPackageJsons();
  // 1つも見つからなければ赤にする: 呼び方や git の状態の誤りで、確かめずに緑になるのを防ぐため
  if (files.length === 0) {
    process.stderr.write('check-duplicate-json-keys: 確かめるファイルが1つも無い\n');
    process.exitCode = 1;
    return;
  }

  let failed = false;
  for (const file of files) {
    const result = findDuplicateJsonKeys(readFileSync(file, 'utf8'));
    if (result.verdict === 'duplicated') {
      failed = true;
      process.stderr.write(`${file}: 鍵が重なっている: ${result.duplicates.join(', ')}\n`);
    } else if (result.verdict === 'unreadable') {
      failed = true;
      process.stderr.write(`${file}: JSON として読めない: ${result.error}\n`);
    }
  }
  if (failed) {
    process.exitCode = 1;
    return;
  }
  process.stdout.write(`check-duplicate-json-keys: ${files.length} ファイルに鍵の重なりは無い\n`);
}

main();
