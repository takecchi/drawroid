import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { dataPaths, resolveDataDir } from './paths.js';

describe('resolveDataDir', () => {
  const base = { home: '/home/u', cwd: '/work' };

  it('defaults to ~/.drawroid', () => {
    expect(resolveDataDir({ ...base })).toBe(join('/home/u', '.drawroid'));
  });

  it('prefers DRAWROID_HOME over the default', () => {
    expect(resolveDataDir({ ...base, env: '/data/env' })).toBe('/data/env');
  });

  it('prefers the CLI argument over DRAWROID_HOME', () => {
    expect(resolveDataDir({ ...base, cliArg: '/data/cli', env: '/data/env' })).toBe('/data/cli');
  });

  it('resolves a relative path against the working directory', () => {
    expect(resolveDataDir({ ...base, cliArg: 'here' })).toBe(join('/work', 'here'));
  });

  it('treats an empty value as not given', () => {
    expect(resolveDataDir({ ...base, cliArg: ' ', env: '' })).toBe(join('/home/u', '.drawroid'));
  });
});

describe('dataPaths', () => {
  it('lays out the top level and job directories under the root', () => {
    const paths = dataPaths('/d');
    expect(paths.config).toBe(join('/d', 'config.json'));
    expect(paths.memory).toBe(join('/d', 'memory'));
    expect(paths.llmCalls).toBe(join('/d', 'llm-calls'));
    expect(paths.job('20261009-153012-k3f9')).toBe(join('/d', 'jobs', '20261009-153012-k3f9'));
  });
});

describe('jobFiles', () => {
  it('lays out a job and its iterations as described in architecture.md', () => {
    const job = dataPaths('/d').jobFiles('j1');
    const it1 = job.iteration(1);
    expect(job.spec).toBe(join('/d', 'jobs', 'j1', 'job.json'));
    expect(job.state).toBe(join('/d', 'jobs', 'j1', 'state.json'));
    expect(job.llmCall('c1')).toBe(join('/d', 'jobs', 'j1', 'llm-calls', 'c1.json'));
    expect(it1.think).toBe(join('/d', 'jobs', 'j1', 'iterations', '0001', 'think.json'));
    expect(it1.image(0)).toBe(join('/d', 'jobs', 'j1', 'iterations', '0001', 'images', '0.png'));
    expect(it1.preview(0, 512)).toBe(
      join('/d', 'jobs', 'j1', 'iterations', '0001', 'images', '0.preview-512.webp'),
    );
    expect(it1.sent(0)).toBe(
      join('/d', 'jobs', 'j1', 'iterations', '0001', 'images', '0.sent.json'),
    );
    expect(dataPaths('/d').llmCall('c2')).toBe(join('/d', 'llm-calls', 'c2.json'));
  });
});
