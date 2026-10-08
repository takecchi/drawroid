import type { MemoryItem } from './item.js';

export interface InvalidMemoryFile {
  id: string;
  reason: string;
}

export interface MemoryListing {
  items: MemoryItem[];
  // 人間が手で直して壊れた項目。ループは止めずに飛ばし、UI に出して直してもらう
  invalid: InvalidMemoryFile[];
}

// 記憶のストアのポート。置き方（ファイルの形）は実装が決め、core は知らない
export interface MemoryStore {
  list(): Promise<MemoryListing>;
  get(id: string): Promise<MemoryItem | null>;
  put(item: MemoryItem): Promise<void>;
  remove(id: string): Promise<boolean>;
}
