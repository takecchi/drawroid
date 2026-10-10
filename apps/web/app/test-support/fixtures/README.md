# 固定データ（ジョブの詳細の画面の試験用）

ジョブの詳細の画面（M3:88）と LLM の記録の画面（M3:93）の試験に流す、API の応答。
手で組み立てず、実行器が実際に残した記録を `app.request` で読んで保存している。

## 取り直し方

```sh
pnpm build   # api・core・storage-fs の dist を使う
node scripts/record-job-detail-fixtures.mjs
```

`scripts/record-job-detail-fixtures.mjs` が、`JobRunner` + `ScriptedLlm` + `StubBackend` + `FsJobStore` + `createApi` を一時ディレクトリに組み、次の自動ジョブを止まるまで回す。

- 依頼: 夕暮れの海辺に立つ白いワンピースの少女、アニメ調 / 参照画像 1 枚（ref-gist が走る）
- 止める条件: AI の判断 + 回数の上限 2 / 1 回 2 枚
- 1 回目の見る役の返事を返す前に、口出し「逆光にして」を HTTP で入れる（2 回目に取り込まれる）
- 取り込んだあと、llm-calls のディレクトリへ壊れた JSON を 1 つ置く（API が返す `invalid` の実物）

保存するもの（すべて API の応答そのまま）:

| ファイル              | 取得元                                                |
| --------------------- | ----------------------------------------------------- |
| `job.json`            | `GET /jobs/:id`                                       |
| `iterations.json`     | `GET /jobs/:id/iterations`                            |
| `llm-calls.json`      | `GET /jobs/:id/llm-calls`                             |
| `references.json`     | `GET /jobs/auto/:id/references`                       |
| `interventions.json`  | `GET /jobs/auto/:id/interventions`                    |
| `selections.json`     | `GET /jobs/:id/selections`                            |
| `llm-call-think.json` | `GET /jobs/:id/llm-calls/:callId`（1 回目の考える役） |

## 何度回しても同じ出力になる理由

実行器・保存・API の側に、時計と ID を差し込む口があるので、固定のものを注入している（置き換えではない）。

- 時計: `JobRunner` / `ManualGenerationRunner` / `createApi` の `now`。呼ばれるたびに 2026-01-01T00:00:00Z から 1 秒進む
- 呼び出し ID: `JobRunner` の `newCallId`（時刻 + 連番）
- ジョブ ID: `FsJobStore` の `randomSuffix`（連番）
- `ScriptedLlm` の呼び出しの時間（durationMs）は 1、トークンは入力 100・出力 20 で固定

注入できなかった 1 か所だけ、取り込んだあとに機械的に置き換えている: 壊れた記録の `invalid[].reason` には一時ディレクトリの絶対パスが入るので、`<データディレクトリ>` に置き換える。

## 型の当て方

試験は `../recorded-job.ts` を通して読む。JSON を import すると、`kind: 'auto'` のようなリテラルの union が `string` に広がり、swr の型へ直には `satisfies` できない。そこで文字列・真偽値を広げた型（`Loose<T>`）へ `satisfies` で当てている。欄の増減・名前・型の取り違え・null の有無のずれは typecheck で落ちる。union の取りうる値までは見ない。

## 限りがあるところ

- 回に属さない（iteration が null の）呼び出しは、止まったときの蒸留（`distill`）の 1 本。script は `JobRunner` に `memory`（記憶の置き場と蒸留の記録）を配線し、ScriptedLlm に何も覚えない `distill` の台本を足して、実物を取っている。ジョブの詳細の画面は、この呼び出しを回の「LLM 呼び出し」には出さず、「LLM の合計」の「ジョブ単位」の行にだけ数える（一覧で「覚える」と出る画面はジョブの詳細には無い）。
- `Loose<T>` の限界: union の取りうる値（`kind` の `'auto'` など）のずれは typecheck で見えない。
- ScriptedLlm の時間は 1 ms 固定なので、「1.2 秒」のような秒の表示は実物からは取れない。

## doctor.json（設定の画面の「確かめる」）

上とは別に、`doctor.json` は設定の画面の「確かめる」の試験（`doctor-check.test.tsx`）に流す `POST /api/doctor` の応答。
`apps/cli/src/doctor.test.ts` の `records what the screen receives, for the screen tests` が、起動と同じ組み立て（`screenDoctor` + `createBackendSettings` + `createApp`）で取り、`toMatchFileSnapshot` で比べている。本番の文が変わるとその試験が落ちるので、次で取り直す。

```sh
pnpm exec vitest run apps/cli/src/doctor.test.ts -u
```

- 確かめる状態: config.json は `{}`（読める）・バックエンドは既定の URL で何も待ち受けていない・LLM は未設定・web の配り先はある
- 置き換え: 一時ディレクトリを `<データディレクトリ>` に、web の配り先を `<web の配り先>` に、空いていたポートを本番の既定 `7860` に
- すべてよい応答は取っていない（実機の Forge と LLM が要る）。試験では、記録した応答のうち、よい節だけを使う
