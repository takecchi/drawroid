// 原子的書き込みの途中でプロセスが殺されたときを再現するための子プロセス。止められるまで同じファイルを書き続ける
import { writeJsonAtomic } from '../../dist/index.js';

const [target] = process.argv.slice(2);
const payload = 'x'.repeat(256 * 1024);
// 1回書き終えてから知らせる: 最初の書き込みより前に殺すと、ファイルが無いだけで何も確かめられないため
await writeJsonAtomic(target, { seq: 0, payload });
process.stdout.write('started\n');
for (let seq = 1; ; seq++) {
  await writeJsonAtomic(target, { seq, payload });
}
