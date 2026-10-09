import {
  conversationEventSchema,
  newConversationEventSchema,
  type ConversationEvent,
  type NewConversationEvent,
} from '../conversation/events.js';
import {
  conversationSchema,
  type Conversation,
  type ConversationEventPage,
  type ConversationStore,
} from '../conversation/store.js';
import type { LlmCallRecord } from '../llm/record.js';

/**
 * 試験のための、メモリに置く ConversationStore。ファイルの実装（storage-fs）と同じく、seq を欠けなく振る。
 */
export class MemoryConversationStore implements ConversationStore {
  private readonly conversations = new Map<string, Conversation>();
  private readonly events = new Map<string, ConversationEvent[]>();
  /** 会話ごとの LLM 呼び出しの記録。試験が「何を渡したか」をここで見る */
  readonly llmCalls = new Map<string, LlmCallRecord[]>();
  private nextId = 1;

  async createConversation(now: Date): Promise<Conversation> {
    const conversationId = `20261009-000000-c${this.nextId++}`;
    const conversation = conversationSchema.parse({
      conversationId,
      title: '',
      createdAt: now.toISOString(),
    });
    this.conversations.set(conversationId, conversation);
    this.events.set(conversationId, []);
    return conversation;
  }

  async listConversationIds(): Promise<string[]> {
    return [...this.conversations.keys()];
  }

  async hasConversation(conversationId: string): Promise<boolean> {
    return this.conversations.has(conversationId);
  }

  async readConversation(conversationId: string): Promise<Conversation> {
    const conversation = this.conversations.get(conversationId);
    if (conversation === undefined) throw new Error(`会話 ${conversationId} は無い`);
    return conversation;
  }

  async writeConversation(conversation: Conversation): Promise<void> {
    this.conversations.set(conversation.conversationId, conversationSchema.parse(conversation));
  }

  async appendEvent(
    conversationId: string,
    event: NewConversationEvent,
    now: Date,
  ): Promise<ConversationEvent> {
    const list = this.listOf(conversationId);
    const confirmed = conversationEventSchema.parse({
      ...newConversationEventSchema.parse(event),
      seq: list.length + 1,
      at: now.toISOString(),
    });
    list.push(confirmed);
    return confirmed;
  }

  async readEvents(
    conversationId: string,
    { after = 0, limit = 200 }: { after?: number; limit?: number } = {},
  ): Promise<ConversationEventPage> {
    const later = this.listOf(conversationId).filter((event) => event.seq > after);
    const events = later.slice(0, limit);
    return { events, last: events.at(-1)?.seq ?? after, more: later.length > limit };
  }

  async writeLlmCall(conversationId: string, record: LlmCallRecord): Promise<void> {
    this.listOf(conversationId);
    this.llmCalls.set(conversationId, [...(this.llmCalls.get(conversationId) ?? []), record]);
  }

  private listOf(conversationId: string): ConversationEvent[] {
    const list = this.events.get(conversationId);
    if (list === undefined) throw new Error(`会話 ${conversationId} は無い`);
    return list;
  }
}
