// 話す役のシステムプロンプトとツールの説明に、オーナーが描いた体験の要点が載っていて、文字数の予算に収まることを見る試験。
// LLM の実際の振る舞いは縛れないので、伝えるべきことが書いてあることだけを押さえる
import { describe, expect, it } from 'vitest';

import type { JobStore } from '../../job/store.js';
import { DEFAULT_MODEL_WINDOW } from '../../loop/budget.js';
import { basicPermissions } from '../../loop/iteration-permissions.js';
import type { MemoryStore } from '../../memory/store.js';
import { StubBackend } from '../../testing/stub-backend.js';
import { createDrawingTools, type DrawingToolDeps } from '../drawing-tools.js';
import { createMemoryTools } from '../memory-tools.js';
import { createReviewTools, type ReviewToolDeps } from '../review-tools.js';
import { buildTalkInput, TALK_SYSTEM, TALK_SYSTEM_MAX_CHARS } from './input.js';
import { DEFAULT_TALK_LIMITS } from './limits.js';
import { createReadOnlyTools, TALK_TOOL_DESCRIPTION_MAX_CHARS } from './tools.js';

// 説明は作るときに決まる。依存は呼ばれないので、形だけ渡す
const tools = [
  ...createReadOnlyTools({
    backend: new StubBackend(),
    permissions: async () => basicPermissions({ width: 64, height: 64 }),
    jobs: {} as JobStore,
  }),
  ...createDrawingTools({} as DrawingToolDeps),
  ...createMemoryTools({ memory: {} as MemoryStore, now: () => new Date() }),
  ...createReviewTools({} as ReviewToolDeps),
];
const descriptionOf = (name: string) => tools.find((tool) => tool.name === name)!.description;
const lineWith = (word: string) => TALK_SYSTEM.split('\n').find((line) => line.includes(word));

describe('the system prompt of the talking role', () => {
  it('tells a question from an instruction to draw, and starts drawing only on the instruction', () => {
    const question = lineWith('質問（');
    expect(question).toContain('何ができますか？');
    expect(question).toContain('描けますか？');
    expect(question).toContain('start_drawing は呼ばない');
    expect(question).toMatch(/describe_backend|search_candidates/);
    const instruction = lineWith('描く指示（');
    expect(instruction).toContain('を描いて');
    expect(instruction).toContain('このときだけ start_drawing');
  });

  it('takes "this one is fine, next do this" as adopting the image and passing on the next instruction, answering briefly', () => {
    const adopting = lineWith('これでいいから');
    expect(adopting).toContain('adopt_image');
    expect(adopting).toContain('revise_drawing');
    expect(adopting).toContain('わかりました');
    // 「これでいい」だけのときは、次の指示を作らない
    expect(adopting).toMatch(/「これでいい」だけなら adopt_image だけ/);
  });

  it('says the past conversations are not visible, and the preferences are recalled and written with the memory tools', () => {
    const memory = lineWith('recall_memory');
    expect(memory).toContain('前の会話の中身は見えない');
    expect(memory).toContain('会話をまたいで');
    expect(memory).toContain('remember');
  });

  it('names only tools the talking role has', () => {
    const names = new Set(tools.map((tool) => tool.name));
    const named = TALK_SYSTEM.match(/\b[a-z]+(?:_[a-z]+)+\b|\bremember\b/g) ?? [];
    expect(named.length).toBeGreaterThan(0);
    for (const name of named) expect(names).toContain(name);
  });

  it('fits within its character budget, and is what the input sends as the system prompt', () => {
    expect(TALK_SYSTEM.length).toBeLessThanOrEqual(TALK_SYSTEM_MAX_CHARS);
    const input = buildTalkInput({
      events: [],
      messageSeqs: [],
      steps: [],
      final: false,
      limits: DEFAULT_TALK_LIMITS,
      window: DEFAULT_MODEL_WINDOW,
    });
    expect(input.system).toBe(TALK_SYSTEM);
  });
});

describe('the descriptions of the tools of the talking role', () => {
  it('keeps every description within its character budget', () => {
    for (const tool of tools) {
      expect(tool.description.length, tool.name).toBeLessThanOrEqual(
        TALK_TOOL_DESCRIPTION_MAX_CHARS,
      );
    }
  });

  it('keeps the tools that only look things up from starting a drawing', () => {
    expect(descriptionOf('describe_backend')).toContain('描き始めない');
    expect(descriptionOf('search_candidates')).toContain('描き始めない');
    expect(descriptionOf('start_drawing')).toContain('描けるかを聞かれたとき');
    expect(descriptionOf('start_drawing')).toContain('呼ばない');
  });

  it('tells adopting an image from stopping, and sends the next instruction on with revise_drawing', () => {
    expect(descriptionOf('adopt_image')).toContain('これでいいから次はこうして');
    expect(descriptionOf('adopt_image')).toContain('revise_drawing');
    expect(descriptionOf('stop_drawing')).toContain('adopt_image');
  });

  it('says when to recall the memory, and that it outlives the conversation', () => {
    expect(descriptionOf('recall_memory')).toContain('会話をまたいで');
    expect(descriptionOf('recall_memory')).toContain('描き始める前');
    expect(descriptionOf('remember')).toContain('覚えておいて');
  });
});

describe('how the talking role points at an image', () => {
  const schemaOf = (name: string) => tools.find((tool) => tool.name === name)!.inputSchema;

  it.each(['adopt_image', 'review_image'])(
    '%s counts the images from 1, as the summary does, and refuses anything else',
    (name) => {
      const schema = schemaOf(name);
      expect(schema.safeParse({ iteration: 1, number: 2 }).success).toBe(true);
      // 0 から数えた数や、前の 0 から数える欄は、黙って1枚目にせずに断る
      expect(schema.safeParse({ iteration: 1, number: 0 }).success).toBe(false);
      expect(schema.safeParse({ iteration: 1, index: 1 }).success).toBe(false);
    },
  );
});
