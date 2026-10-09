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

/** update の結果。before は読んだ版（無ければ null）、written は書いた版（書かなかったら無い） */
export interface MemoryUpdate {
  before: MemoryItem | null;
  written?: MemoryItem;
}

// 記憶のストアのポート。置き方（ファイルの形）は実装が決め、core は知らない
export interface MemoryStore {
  list(): Promise<MemoryListing>;
  get(id: string): Promise<MemoryItem | null>;
  put(item: MemoryItem): Promise<void>;
  remove(id: string): Promise<boolean>;
  /**
   * 項目を読み、change で変えて書く。change が undefined を返したら書かない。
   * 同じ項目への書き込み（put・update・remove）は、ストアの中で1つずつ行うので、
   * 読んで比べてから書くまでのあいだに、ほかの書き込みは割り込まない。
   * 別のプロセスや人間の手でのファイルの編集が割り込むことは防がない（範囲外）。
   */
  update(
    id: string,
    change: (current: MemoryItem | null) => MemoryItem | undefined,
  ): Promise<MemoryUpdate>;
}
