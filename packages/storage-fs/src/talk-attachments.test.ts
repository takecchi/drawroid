// 会話で添えた画像が、話す役の入力に ID として載り、話す役がその ID を start_drawing に写すと、ジョブの参照画像になることを見る通しの試験。
// 話す役は台本のスタブだが、入力の文から「（添えた画像: …）」の ID を読む: ID の書き方が変われば、ここが落ちる。
// 画像そのものは話す役に見せない（トークンを最小にするため）。ジョブの置き場所は本物のファイル
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  basicPermissions,
  bridgeJobEvents,
  ConversationHubs,
  createDrawingTools,
  DEFAULT_BUDGET,
  DEFAULT_BUDGETS,
  DEFAULT_TALK_LIMITS,
  JobRunner,
  TalkRunner,
  type JobStore,
  type TalkStepCall,
} from '@drawroid/core';
import {
  MemoryConversationStore,
  ScriptedLlm,
  STUB_PNG,
  StubBackend,
  type Script,
} from '@drawroid/core/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { FsJobStore } from './job-store.js';

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'drawroid-talk-attachments-'));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const think: Script = () => ({
  params: { prompt: 'girl, beach', negativePrompt: 'lowres', seed: 7, steps: 20, cfgScale: 6 },
  rationale: '案',
});
const judge: Script = (call) => ({
  images: call.messages.user
    .filter((part) => part.type === 'image')
    .map(() => ({ score: 0.6, issues: [] })),
  nextChange: 'そのまま',
  canStop: false,
});

const textOf = (call: TalkStepCall) =>
  call.messages.user.map((part) => (part.type === 'text' ? part.text : '')).join('\n');

/** 話す役の入力の文から、添えた画像の ID を読む（話す役のモデルがすることと同じ） */
function attachedIds(call: TalkStepCall): string[] {
  const match = /（添えた画像: ([^）]+)）/.exec(textOf(call));
  return match === null ? [] : (match[1] ?? '').split(', ');
}

describe('images attached to a message', () => {
  it('reach start_drawing by their IDs in the input of the talking role, and become the references of the job', async () => {
    const conversations = new MemoryConversationStore();
    const hubs = new ConversationHubs({ store: conversations });
    const files = new FsJobStore(root);
    const jobs: JobStore = bridgeJobEvents(files, { hubs });
    const permissions = basicPermissions({ width: 64, height: 64 });
    const llm = new ScriptedLlm(
      { think, judge },
      {
        talk: (call, n) =>
          n === 0
            ? {
                toolCalls: [
                  {
                    name: 'start_drawing',
                    input: {
                      request: 'この2枚の雰囲気で、海辺の少女',
                      stopConditions: { aiJudgement: false, maxIterations: 1 },
                      attachments: attachedIds(call).map((uploadId) => ({ uploadId })),
                    },
                  },
                ],
              }
            : { text: '描き始めました' },
      },
    );
    const jobRunner = new JobRunner({
      store: jobs,
      llm,
      backend: new StubBackend(),
      budget: DEFAULT_BUDGET,
      permissions,
    });
    const talk = new TalkRunner({
      store: conversations,
      hubs,
      llm: () => llm,
      tools: createDrawingTools({
        jobs,
        runner: jobRunner,
        conversations,
        humanPermissions: async () => permissions,
        candidateNames: async () => [],
        defaultStopConditions: async () => ({ aiJudgement: true, maxIterations: 10 }),
        budgets: async () => DEFAULT_BUDGETS,
        now: () => new Date(),
      }),
      limits: async () => DEFAULT_TALK_LIMITS,
    });
    const { conversationId } = await conversations.createConversation(new Date());
    const first = new Uint8Array([...STUB_PNG]);
    const second = new Uint8Array([...STUB_PNG, 0]);
    const a = await conversations.addUpload(
      conversationId,
      { data: first, mediaType: 'image/png' },
      new Date(),
    );
    const b = await conversations.addUpload(
      conversationId,
      { data: second, mediaType: 'image/png' },
      new Date(),
    );
    await hubs.get(conversationId).confirm({
      type: 'user.message',
      text: 'この2枚の雰囲気で描いて',
      attachments: [{ uploadId: a }, { uploadId: b }],
    });

    talk.kick(conversationId);
    await talk.idle(conversationId);
    await jobRunner.idle();

    // ID だけを、発言の後ろに書く。画像そのものは話す役に渡さない
    const step = llm.steps[0]!;
    expect(textOf(step)).toContain(`人間: この2枚の雰囲気で描いて（添えた画像: ${a}, ${b}）`);
    expect(step.messages.user.some((part) => part.type === 'image')).toBe(false);
    const [jobId] = await files.listJobIds();
    const references = await files.listReferences(jobId!);
    expect(references).toHaveLength(2);
    const stored = await Promise.all(
      references.map((reference) =>
        files.readReferenceImage({ jobId: jobId!, refId: reference.refId }),
      ),
    );
    expect(stored.map((image) => image?.data.length)).toEqual([first.length, second.length]);
  });
});
