import { randomBytes } from 'node:crypto';
import { access, mkdir, readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import {
  conversationEventSchema,
  conversationSchema,
  newConversationEventSchema,
  type Conversation,
  type ConversationEvent,
  type ConversationEventPage,
  type ConversationStore,
  type LlmCallRecord,
  type ConversationUpload,
  type NewConversationEvent,
} from '@drawroid/core';
import type { ZodType } from 'zod';

import { createFileExclusive, createJsonExclusive, writeJsonAtomic } from './atomic.js';
import { formatJobId, isJobId, StoredFileError } from './job-store.js';
import {
  dataPaths,
  EVENT_SEQ_DIGITS,
  eventFileName,
  TEMP_FILE_PREFIX,
  type DataPaths,
} from './paths.js';

const UPLOAD_EXTENSIONS: Record<ConversationUpload['mediaType'], string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
};

/** 1ページの既定の件数。画面は more を見て続きを読む */
export const DEFAULT_EVENT_PAGE_SIZE = 200;
/** イベントのファイルを同時に読む数。全部を一度に開くと、ページが大きいときにファイルを開ける数の上限に当たりうるため */
const EVENT_READ_CONCURRENCY = 32;

const EVENT_FILE_PATTERN = new RegExp(`^\\d{${EVENT_SEQ_DIGITS},}\\.json$`);

/** パスに使ってよい会話 ID の形か（ジョブ ID と同じ、時刻を先頭に置いた形） */
export function isConversationId(value: string): boolean {
  return isJobId(value);
}

function isNotFound(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT';
}

async function exists(path: string): Promise<boolean> {
  return access(path).then(
    () => true,
    () => false,
  );
}

async function readValid<T>(path: string, schema: ZodType<T>): Promise<T> {
  const text = await readFile(path, 'utf8');
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (error) {
    throw new StoredFileError(path, error);
  }
  const parsed = schema.safeParse(json);
  if (!parsed.success) throw new StoredFileError(path, parsed.error);
  return parsed.data;
}

/** from から to までの番号（to が from より小さければ空） */
function range(from: number, to: number): number[] {
  return Array.from({ length: Math.max(0, to - from + 1) }, (_, i) => from + i);
}

async function listNames(dir: string): Promise<string[]> {
  try {
    return (await readdir(dir)).filter((name) => !name.startsWith(TEMP_FILE_PREFIX)).sort();
  } catch (error) {
    if (isNotFound(error)) return [];
    throw error;
  }
}

export type FsConversationStoreOptions = {
  /** 会話 ID の末尾に付ける短い乱数（試験で差し替える） */
  randomSuffix?: () => string;
};

/**
 * 会話の置き場所（conversations/<id>/conversation.json と events/<seq>.json）。
 */
export class FsConversationStore implements ConversationStore {
  private readonly paths: DataPaths;
  private readonly randomSuffix: () => string;
  /** 会話ごとに、1 から欠けずに並んでいると確かめた最後のイベントの番号（eventSeqs を見る） */
  private readonly contiguous = new Map<string, number>();

  constructor(root: string, options: FsConversationStoreOptions = {}) {
    this.paths = dataPaths(root);
    this.randomSuffix = options.randomSuffix ?? (() => randomBytes(3).toString('hex'));
  }

  // 外から来た ID でパスを組む口はすべてここを通す: 呼び手の検査に頼ると、1か所の漏れで会話の外を読み書きできるため
  private files(conversationId: string) {
    if (!isConversationId(conversationId)) {
      throw new Error(`conversationId の形ではない: ${conversationId}`);
    }
    return this.paths.conversationFiles(conversationId);
  }

  async createConversation(now: Date): Promise<Conversation> {
    await mkdir(this.paths.conversations, { recursive: true });
    for (;;) {
      const conversationId = formatJobId(now, this.randomSuffix());
      const files = this.files(conversationId);
      try {
        await mkdir(files.dir);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') continue;
        throw error;
      }
      await mkdir(files.events);
      const conversation = conversationSchema.parse({
        conversationId,
        title: '',
        createdAt: now.toISOString(),
      });
      // conversation.json を最後に置く: 一覧はこれのあるディレクトリだけを数えるので、途中で落ちても半端な会話が見えないため
      await writeJsonAtomic(files.meta, conversation);
      return conversation;
    }
  }

  async listConversationIds(): Promise<string[]> {
    const ids: string[] = [];
    for (const name of await listNames(this.paths.conversations)) {
      if (!isConversationId(name)) continue;
      if (await exists(this.paths.conversationFiles(name).meta)) ids.push(name);
    }
    return ids;
  }

  async hasConversation(conversationId: string): Promise<boolean> {
    if (!isConversationId(conversationId)) return false;
    return exists(this.paths.conversationFiles(conversationId).meta);
  }

  readConversation(conversationId: string): Promise<Conversation> {
    return readValid(this.files(conversationId).meta, conversationSchema);
  }

  async writeConversation(conversation: Conversation): Promise<void> {
    await writeJsonAtomic(
      this.files(conversation.conversationId).meta,
      conversationSchema.parse(conversation),
    );
  }

  async appendEvent(
    conversationId: string,
    event: NewConversationEvent,
    now: Date,
  ): Promise<ConversationEvent> {
    const files = this.files(conversationId);
    // 形を確かめてから番号を取る: 形の違うイベントで番号だけ進めないため
    const parsed = newConversationEventSchema.parse(event);
    await mkdir(files.events, { recursive: true });
    // 欠けの無い連番にする: 次の番号を取り、排他的に置けなかったら（同時に同じ番号を取りに来たら）取り直す。
    // 置く前に落ちても何も置かれないので、次の書き込みが同じ番号を取り、番号は欠けない
    for (;;) {
      const seq = (await this.eventSeqs(conversationId, files.events)).last + 1;
      const confirmed = conversationEventSchema.parse({ ...parsed, seq, at: now.toISOString() });
      if (await createJsonExclusive(files.event(seq), confirmed)) return confirmed;
    }
  }

  async writeLlmCall(conversationId: string, record: LlmCallRecord): Promise<void> {
    const files = this.files(conversationId);
    await mkdir(files.llmCalls, { recursive: true });
    await writeJsonAtomic(files.llmCall(record.callId), record);
  }

  async readEvents(
    conversationId: string,
    { after = 0, limit = DEFAULT_EVENT_PAGE_SIZE }: { after?: number; limit?: number } = {},
  ): Promise<ConversationEventPage> {
    const files = this.files(conversationId);
    const { last, listed } = await this.eventSeqs(conversationId, files.events);
    const later = listed?.filter((seq) => seq > after) ?? range(after + 1, last);
    const events = await this.readEventFiles(files.events, later.slice(0, limit));
    return { events, last: events.at(-1)?.seq ?? after, more: later.length > limit };
  }

  async readEventsBefore(
    conversationId: string,
    { before = Number.POSITIVE_INFINITY, limit }: { before?: number; limit: number },
  ): Promise<ConversationEvent[]> {
    const files = this.files(conversationId);
    const { last, listed } = await this.eventSeqs(conversationId, files.events, before - 1);
    const end = Math.min(last, before - 1);
    const earlier =
      listed?.filter((seq) => seq < before) ?? range(Math.max(1, end - limit + 1), end);
    return this.readEventFiles(files.events, earlier.slice(Math.max(0, earlier.length - limit)));
  }

  async addUpload(conversationId: string, upload: ConversationUpload, now: Date): Promise<string> {
    const files = this.files(conversationId);
    await mkdir(files.uploads, { recursive: true });
    for (;;) {
      const uploadId = formatJobId(now, this.randomSuffix());
      const placed = await createFileExclusive(
        files.upload(uploadId, UPLOAD_EXTENSIONS[upload.mediaType]),
        upload.data,
      );
      if (placed) return uploadId;
    }
  }

  async readUpload(
    conversationId: string,
    uploadId: string,
  ): Promise<ConversationUpload | undefined> {
    const files = this.files(conversationId);
    // 外から来た ID の形を確かめてからパスにする: 会話の外を読ませないため
    if (!isJobId(uploadId)) return undefined;
    for (const [mediaType, ext] of Object.entries(UPLOAD_EXTENSIONS)) {
      try {
        const data = new Uint8Array(await readFile(files.upload(uploadId, ext)));
        return { data, mediaType: mediaType as ConversationUpload['mediaType'] };
      } catch (error) {
        if (!isNotFound(error)) throw error;
      }
    }
    return undefined;
  }

  /** イベントのファイルを読み、名前の順（seq の順）に返す。少しずつまとめて並べて読む */
  // 1つずつ待たない: 長い会話を開くとき、1ページ（最大 1000 件）を順に読むと、それだけで数百 ms かかるため
  private async readEventFiles(dir: string, seqs: readonly number[]): Promise<ConversationEvent[]> {
    const events: ConversationEvent[] = [];
    for (let i = 0; i < seqs.length; i += EVENT_READ_CONCURRENCY) {
      const chunk = seqs.slice(i, i + EVENT_READ_CONCURRENCY);
      events.push(
        ...(await Promise.all(
          chunk.map((seq) => readValid(join(dir, eventFileName(seq)), conversationEventSchema)),
        )),
      );
    }
    return events;
  }

  /**
   * 会話のイベントの最後の番号を返す。欠けのある会話では、一覧した番号（小さい順）も返す。
   * 欠けずに並んでいると一覧で確かめた会話は、覚えた最後の番号から先だけを、ファイルの有無で確かめる
   * （一覧は会話の長さに比例して遅くなるため）。upTo を渡すと、それより先は確かめない（末尾から読む口のため）
   */
  // 覚えてよいのは「1 から n まで欠けずにある」ことだけ: 書き手は、排他的に置ける最後の番号 + 1 にしか置かず、
  // 置くときは link で中身ごと一度に現れ、消さない。そのため n より前は変わらず、n より先は毎回ファイルの有無で
  // 確かめれば、別のプロセスや再起動のあとに書かれたものも見落とさない。欠けのある会話・覚えた番号のファイルが
  // 無くなった会話は覚えず、毎回一覧する
  private async eventSeqs(
    conversationId: string,
    dir: string,
    upTo = Number.POSITIVE_INFINITY,
  ): Promise<{ last: number; listed?: number[] }> {
    const known = this.contiguous.get(conversationId);
    if (known !== undefined && (known === 0 || (await exists(join(dir, eventFileName(known)))))) {
      let last = known;
      if (last < upTo) {
        // 倍々に広げてから二分で詰める: 先に書かれた数が多くても、確かめる回数を対数に抑える
        let step = 1;
        while (await exists(join(dir, eventFileName(last + step)))) {
          last += step;
          step *= 2;
        }
        let missing = last + step;
        while (missing - last > 1) {
          const mid = Math.floor((last + missing) / 2);
          if (await exists(join(dir, eventFileName(mid)))) last = mid;
          else missing = mid;
        }
        this.contiguous.set(conversationId, last);
      }
      return { last };
    }
    this.contiguous.delete(conversationId);
    const seqs = (await this.eventNames(dir)).map((name) => Number.parseInt(name, 10));
    const last = seqs.at(-1) ?? 0;
    if (seqs.length === last) this.contiguous.set(conversationId, last);
    return { last, listed: seqs };
  }

  /** イベントのファイルを、seq の順に返す */
  private async eventNames(dir: string): Promise<string[]> {
    return (await listNames(dir))
      .filter((name) => EVENT_FILE_PATTERN.test(name))
      .sort((a, b) => Number.parseInt(a, 10) - Number.parseInt(b, 10));
  }
}
