import { readFile, stat } from 'node:fs/promises';

type Entry = { ino: number; size: number; mtimeMs: number; text: string };

/**
 * 書いたら書き換えないファイルの中身を、inode・大きさ・更新時刻が変わらない間だけ使い回す。
 * 持つのは合計 maxBytes まで。超えたら、最後に使ったのが古いものから手放す。
 */
// 中身を JSON にしてから持たない: 返した値を呼び手が書き換えると、ほかの呼び手に書き換えた値が渡るため。
// 鍵を確かめずに使い回さない: ファイルが正で、人間が手で直したファイルも次の読みから見えなければならないため
export class FileTextCache {
  // Map の順を、使った順にする（使うたびに入れ直す）
  private readonly entries = new Map<string, Entry>();
  private bytes = 0;

  constructor(private readonly maxBytes: number) {}

  /** 無ければ ENOENT を投げる（readFile と同じ） */
  async read(path: string): Promise<string> {
    let stats;
    try {
      stats = await stat(path);
    } catch (error) {
      this.forget(path);
      throw error;
    }
    const cached = this.entries.get(path);
    if (
      cached !== undefined &&
      cached.ino === stats.ino &&
      cached.size === stats.size &&
      cached.mtimeMs === stats.mtimeMs
    ) {
      this.entries.delete(path);
      this.entries.set(path, cached);
      return cached.text;
    }
    // 鍵は読む前に取った値にする: 読む間に書き換わっても、鍵が中身より新しくなることはなく、次の読みで読み直す
    const text = await readFile(path, 'utf8');
    this.forget(path);
    if (stats.size <= this.maxBytes) {
      this.entries.set(path, { ino: stats.ino, size: stats.size, mtimeMs: stats.mtimeMs, text });
      this.bytes += stats.size;
      this.evict();
    }
    return text;
  }

  private forget(path: string): void {
    const entry = this.entries.get(path);
    if (entry === undefined) return;
    this.entries.delete(path);
    this.bytes -= entry.size;
  }

  private evict(): void {
    for (const [path, entry] of this.entries) {
      if (this.bytes <= this.maxBytes) return;
      this.entries.delete(path);
      this.bytes -= entry.size;
    }
  }
}
