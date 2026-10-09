import type { GenerationRequestInput } from '@drawroid/core';
import { mutate } from 'swr';

import { unwrap, unwrapEmpty } from './api-error.js';
import { client } from './client.js';
import { keys } from './keys.js';
import type { BackendSettingsResponse, SavedMemoryItem, SaveMemoryInput } from './types.js';

/** 検証に落ちたときは ApiError（kind: 'invalid_request'）を投げる */
export async function startManualJob(params: GenerationRequestInput): Promise<{ jobId: string }> {
  const started = await unwrap<{ jobId: string }>(() => client.jobs.manual.$post({ json: params }));
  await mutate(keys.jobs);
  return started;
}

/** URL が不正なときは ApiError（kind: 'invalid_request'）を投げる */
export async function saveBackendSettings(input: {
  forgeUrl: string;
}): Promise<BackendSettingsResponse> {
  const saved = await unwrap<BackendSettingsResponse>(() =>
    client.settings.backend.$put({ json: input }),
  );
  // 状態と候補は、繋ぎ直した先のものへ取り直す: 古い Forge の応答が残ると、直したのに直っていないように見えるため
  await mutate((key) => typeof key === 'string' && key.startsWith(keys.backend));
  await mutate(keys.backendSettings, saved, { revalidate: false });
  return saved;
}

/** 開いたあとにファイルが変わっていれば ApiError（kind: 'conflict'）、検証に落ちれば 'invalid_request' を投げる */
export async function saveMemoryItem(id: string, input: SaveMemoryInput): Promise<SavedMemoryItem> {
  const saved = await unwrap<SavedMemoryItem>(() =>
    client.memory[':id'].$put({ param: { id }, json: input }),
  );
  await Promise.all([mutate(keys.memory), mutate(keys.memoryItem(id))]);
  return saved;
}

export async function deleteMemoryItem(id: string): Promise<void> {
  await unwrapEmpty(() => client.memory[':id'].$delete({ param: { id } }));
  // 消した項目のキーは取り直さない: 取り直すと 404 が画面のエラーとして一瞬見えるため、キャッシュごと捨てる
  await Promise.all([
    mutate(keys.memory),
    mutate(keys.memoryItem(id), undefined, { revalidate: false }),
  ]);
}
