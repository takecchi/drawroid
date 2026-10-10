# 実機での確認の手順

[milestones.md](../milestones.md) の受け入れ基準のうち「**実機で**」と書いたものを、実際の Forge / A1111 と LLM に繋いで確かめる手順。
スタブで確かめられる受け入れ基準は自動テストが持つので、ここには書かない。

- 手順は、各 PR の本文に書いた案を写し、今の現物（main）に合わせて直したもの。節ごとに、どの PR から来たかを書く
- 手順の中の「注」は、写したあとに状況が変わった所への補足
- 結果（うまくいかなかった手順・画面のスクリーンショット・Forge / A1111 や LLM の応答）は、出どころの PR か Issue に返す。応答の雛形（`packages/backend-forge/src/test-support/fixtures/`・`packages/backend-a1111/src/test-support/fixtures/`）を実機の形に差し替える材料になる

## 共通の準備

- Forge（または A1111）を `--api` 付きで起動しておく。drawroid が見る既定の URL は、どちらも `http://127.0.0.1:7860`
- drawroid は、リポジトリの根で `pnpm install` → `pnpm build` → `pnpm drawroid` で起動する。端末に次のように出るので、最後の行の URL をブラウザで開く

  ```
  drawroid: データディレクトリ /home/<you>/.drawroid
  drawroid: Forge http://127.0.0.1:7860
  drawroid: http://127.0.0.1:7878/
  ```

  - LLM をまだ設定していなければ、3 行目の前に「drawroid: LLM が未設定。画面の「設定」の「LLM の設定」（/settings#llm）か PUT /api/settings/llm で設定するまで、自動ジョブは待ち行列に留まる」が出る
  - `pnpm build && pnpm start` でもよい（下の起動の指定も同じように続けて書ける。build していなければ起動せずに止まる）
  - 開発中は `pnpm dev` で立ち上げ、http://localhost:5173/ を開く（`/api` は 7878 の drawroid へ中継される。データディレクトリは `DRAWROID_HOME=<dir> pnpm dev` で変える）
- 起動の指定（`pnpm drawroid` のあとに続ける。**`--` を挟まない**。挟むと「-- を挟まずに打つ（例: …）。-- のあとの指定は受け取らない」と出て落ちる）
  - `--backend-url http://<host>:<port>` — バックエンドの URL。古い名前の `--forge-url` も同じ意味で受ける（両方を付けると落ちる）
  - `--backend a1111` — A1111 に繋ぐ（省けば `forge`）。M6 の節を見る
  - `--data-dir <dir>` — データディレクトリ（既定は `~/.drawroid`。環境変数 `DRAWROID_HOME` でも変えられ、`--data-dir` が勝つ）
  - `--port <番号>` — drawroid が待ち受けるポート（既定は 7878）
  - バックエンドの種類と URL は、`<データディレクトリ>/config.json` の `backend.kind`・`backend.url` にも書ける。起動の指定が勝つ
- 画面の入口（`/`）は「会話」の一覧。左の脇から、描く（依頼・ジョブ・手動で生成）・覚えること（記憶・候補の説明）・設定（設定・許可・LLM の記録）へ行ける。バックエンドの状態と URL、LLM の設定は「設定」（`/settings`）にある

### 始める前に、つまずく所をまとめて確かめる

`pnpm drawroid doctor` を、起動と同じ指定を付けて打つ（例: `pnpm drawroid doctor --backend a1111 --backend-url http://127.0.0.1:7860`）。設定ファイル・画像のバックエンド・LLM・web の配り先の4つを確かめ、何も書き換えずに終わる。「足りない」の行の「→」に、何を直すかが出る。全部の行が「よい」になるまで直す。

- 画面では、「設定」の「まとめて確かめる」の「確かめる」が同じことをする（走っている drawroid が使っている URL で確かめる）。全部よければ「すべてよい。会話から描き始められる。」と出る
- doctor は、走っている drawroid には聞かず、自分の指定と `config.json` から URL を決める。drawroid を `--backend-url` 付きで起動したなら、doctor にも同じ `--backend-url` を付ける
- LLM の項は、役ごとに短い呼び出しを1回ずつ送る。見る役には、ジョブが見る役に渡すのと同じ形式の小さな画像を1枚渡す

## M1 — Forge で1枚生成する

対象の受け入れ基準:

- M1:47 **実機で**: Forge に繋いで1枚生成し、データディレクトリに画像とメタデータが置かれ、Web UI で見られる
- M1:48 と M1:49 はスタブの試験が持つが、実機でも次の手順の 6〜8 で確かめる

### 手順（出どころ: #26 の本文「実機での確認の手順（オーナー向け）」）

1. 共通の準備のとおり起動し、ブラウザで http://127.0.0.1:7878/ を開く
2. **繋がる**: 「設定」（`/settings`）の「バックエンドの状態」が「繋がっている。」になること。「手動で生成」（`/generate`）を開き、checkpoint・sampler などの select に Forge の候補が入っていること
3. **1枚生成する（M1:47）**: 「手動で生成」で prompt を入れ、batchSize 1 のまま「生成する」を押す
   - ジョブの詳細（`/jobs/<jobId>`）に移り、状態が「終了」、「止まった理由: 回数の上限」（`state.json` の `reason.kind` が `limit:iterations`）になり、画像と seed が出ること
   - `~/.drawroid/jobs/<jobId>/` に次が置かれていること
     - `job.json`・`state.json`
     - `iterations/0001/request.json`
     - `iterations/0001/images/0.png`・`0.json`（`0.json` に seed と Forge の応答のメタデータが入る）・`0.preview-512.webp`（見る役と画面に使う縮小版）
4. **batchSize 2 で生成する**: 画像が2枚出て、seed が別々であること（グリッド画像が混ざっていないこと）
5. **LoRA を1つ選んで「足す」を押し、生成する**: Forge のコンソールに LoRA が見つからない旨が出ないこと（#9 で、候補の名前を alias から name に変えたため）
6. **Forge が落ちているとき（M1:48）**: Forge を止め、「設定」の「バックエンドの状態」を見る
   - 「Forge に繋がらない。」と、確かめること（「Forge が起動しているか、URL とポートが合っているかを確かめる。」）が出ること
   - 「詳しく」を開くと、生のメッセージに `127.0.0.1:7860` が入っていること
   - その状態で生成すると、ジョブが止まり（`state.json` の `status` が `stopped`、`reason.kind` が `error`、`reason.backendErrorKind` が `unreachable`）、同じ説明が出ること
7. **URL が違うとき（M1:48）**: 「設定」の「バックエンドの URL」を、Forge ではなく 404 を返すだけのサーバの URL に変えて「保存」する（例: `node -e "require('node:http').createServer((req, res) => { res.statusCode = 404; res.end(); }).listen(8000)"` を動かし、`http://127.0.0.1:8000`）
   - 「繋がったが Forge の API が無い。」の説明が出ること
   - 注: drawroid 自身の URL（`http://127.0.0.1:7878`）を指すと、この説明にはならない。drawroid は知らないパスにも画面の HTML を 200 で返すので、「Forge の応答の形が想定と違う。」になる
   - `~/.drawroid/config.json` の `backend.url` に URL が書かれ、他のキーが残っていること（古い名前の `backend.forgeUrl` があれば `url` に置き換わる）
   - 正しい URL に戻して保存すると、再起動なしで「繋がっている。」に戻ること
   - 注: 生成が走っているあいだの保存は、409 で断られる。生成が終わってから保存する
8. **保存中に殺す（M1:49）**: 生成中に drawroid を `kill -9` で止め、もう一度起動する
   - 起動のログに「drawroid: 前回の書きかけの一時ファイルを N 個片付けた」が出ること（出ない場合もある）
   - 「ジョブ」（`/jobs`）の一覧が 500 にならないこと

結果（特に 3・6・7）が届いたら、#9・#13 の応答の雛形を実機の形に差し替える。

### 追加の確認項目（出どころ: #33 の本文「#26 の実機の手順に足す確認項目の案」）

画像を入力に使う生成（img2img・inpaint・ControlNet）と、Hires. fix の確認。Forge を `--api` 付きで起動し、ControlNet のモデル（canny など）を1つ置いた状態で行う。

- 注: 「手動で生成」は、今も画像を指す欄（img2img・inpaint・ControlNet）を受け付けない（送ると 400 で「手動の生成は、まだ img2img・inpaint・ControlNet（画像を指す欄）を受け付けない」）。2〜5 は、M4 の節の手順（ループの中で AI に選ばせる）で確かめる
- 注: #33 はマージされずに閉じた。画像を入力に使う生成の実装は、のちの PR で main に入っている

1. **probe と候補**: `curl http://127.0.0.1:7878/api/backend` の `capabilities.unavailable` に ControlNet が無く、`capabilities.limits.controlnetUnits` が Forge の設定の「ControlNet Unit の数」と一致すること。数が違えば、`script-info` から数える推測が外れている（数えられないときは 3 とみなす）
   - 設定を 3 以外（例: 4）にして Forge を再起動し、もう一度確かめる
   - あわせて、`curl http://127.0.0.1:7860/sdapi/v1/script-info` の controlnet の項目を返してもらえれば、雛形を差し替える
2. **img2img**: 前の生成の画像を元に、denoising 0.5 で生成し、元の構図が残ること
3. **inpaint**: 白で塗ったマスクで、塗った所だけが描き直されること。area を whole・masked の両方で試す
4. **ControlNet**: 参照画像と canny で生成し、輪郭が効いていること。あわせて次の3つを確かめる
   - モデルをハッシュ抜きの名前で指定しても通ること
   - `module` を省いた（`'None'` を送る）とき、Forge が落ちないこと
   - 応答の画像が枚数ぶんだけで、検出マップが混ざらないこと
5. **ControlNet のユニットを上限より1つ多く頼む**と、Forge に投げずに理由付きで失敗すること
6. **Hires. fix**: ネガティブプロンプトに強い語（例: `monochrome`）を入れ、二段目でも効いていること（`hr_cfg` を送っている効果の確認）。二段目のサンプラーを省いても落ちないこと
7. **ControlNet を無効にした Forge**: 拡張の設定で sd_forge_controlnet を外して再起動し、`GET /api/backend` の `capabilities.unavailable` に、理由付きで ControlNet が出ること。「設定」の「バックエンドの状態」にも出る

## M2 — LLM でループを回す

対象の受け入れ基準:

- M2:75 **実機で**: ローカル LLM（画像入力対応のもの）と Forge で、自然言語の依頼から3回以上ループが回って止まる。各呼び出しのトークン数が記録されている
- M2:76 **実機で**: provider を OpenAI または Anthropic に切り替えても同じ依頼が回る

### 手順（出どころ: #23 の本文「実機での確認の手順」）

1. Forge を起動しておく。`export OPENAI_API_KEY=...`（ローカル LLM なら不要）を設定してから、`pnpm build && pnpm drawroid --data-dir /tmp/drawroid-check --backend-url http://127.0.0.1:7860` で起動する
2. LLM の設定を保存する。ローカル LLM の例:
   `curl -X PUT http://127.0.0.1:7878/api/settings/llm -H 'content-type: application/json' -d '{"providers":{"local":{"type":"openai-compatible","baseURL":"http://127.0.0.1:1234/v1"}},"roles":{"think":{"provider":"local","model":"<画像入力に対応したモデル>"}}}'`
   - 見る役（`judge`）と話す役（`talk`）を書かなければ、考える役と同じモデルを使う
   - 画面の「設定」の「LLM の設定」（`/settings#llm`）でも同じことができる
3. `curl http://127.0.0.1:7878/api/settings/llm` を叩き、応答にキーの値が無く、`apiKeyEnv.*.set` だけが出ていることを確かめる
4. `pnpm drawroid doctor --data-dir /tmp/drawroid-check --backend-url http://127.0.0.1:7860` で、LLM の項が全部「よい」になることを確かめる（共通の準備の「始める前に」）
5. `curl -X POST http://127.0.0.1:7878/api/jobs/auto -H 'content-type: application/json' -d '{"request":"夕暮れの海辺に立つ白いワンピースの少女、アニメ調","stopConditions":{"aiJudgement":true,"maxIterations":5}}'`
6. `curl http://127.0.0.1:7878/api/jobs/<jobId>` で、3 回以上回って止まり、止まった理由が残っていることを確かめる。`/tmp/drawroid-check/jobs/<jobId>/llm-calls/*.json` にトークン数が記録されていることも確かめる（M2:75）
7. provider を `openai` または `anthropic`（`apiKeyEnv` を指定）に変え、同じ依頼が回ることを確かめる（M2:76）
8. 走っている途中で `POST /api/jobs/auto/<jobId>/stop` を送り、`human` で止まることを確かめる。drawroid を kill して起動し直すと、続きから回ることを確かめる

### 失敗したときに見るファイル

データディレクトリ（既定は `~/.drawroid`。上の手順 1 では `/tmp/drawroid-check`）の下を見る。置き方は #16・#19・#23 と、のちの PR の現物による。

- `config.json` の `llm` — 保存した LLM の設定。キーの値は書かれず、環境変数の名前だけが入る
- `jobs/<jobId>/job.json` — 依頼の原文・止める条件・1回の枚数・投入したときに決めた予算（`budgets`）
- `jobs/<jobId>/state.json` — `status`（`queued`・`running`・`stopped`）と、止まったときの `reason`（`kind` と `detail`）
  - `kind` は `ai`・`limit:iterations`・`limit:duration`・`limit:images`・`human`・`adopted`（人が画像に決めた）・`error`
  - `kind` が `error` なら、`detail` にどの段で何が起きたかが入る。バックエンドの失敗なら `backendErrorKind` も付く
- `jobs/<jobId>/iterations/<NNNN>/` — 回ごとの段の出力（`NNNN` は 0 埋めの回の番号）
  - `think.json`（考える役の決定）、`plan.json`（許可やバックエンドの都合で AI の選択肢から外したもの。`excluded`）、`request.json`（バックエンドへ渡した要求）、`images/<n>.png`・`<n>.json`（画像と seed）、`judge.json`（見る役の評価）、`adopted.json`（人が決めた画像）
  - 回の途中で止まった場合は、どのファイルまであるかで、どの段まで済んだかが分かる
  - ジョブの始めの段（バックエンドの能力と候補を取る段）で止まったときは、`iterations/` はできない
- `jobs/<jobId>/llm-calls/<callId>.json` — LLM 呼び出し1回の記録
  - `usage`（トークン数。M2:75）、`attempts`（試行ごとの生の出力と、スキーマに合わなかった理由）、`outcome`、`budget.notes`（予算で切った・落としたもの）、`provider`・`model`（M2:76 で切り替わったか）
  - `purpose` が `think`・`judge` のものは回ごと。止まったときの蒸留（`distill`）など、回に属さない呼び出しは `iteration` が `null`
- `jobs/<jobId>/distill.json` — 止まったときの蒸留の記録（M5 の節）

## M3 — Web UI で見て、止めて、口を出す

対象の受け入れ基準:

- M3:103 **実機で**: 依頼の投入から最終選択まで、Web UI だけで完結する

### 手順（出どころ: #34 の本文「M3:103 の手順書の案」）

前提: Forge が起動していて、drawroid の設定でつながっている。LLM の設定（考える役・見る役）が済んでいる。ブラウザ以外（curl・ファイルの直接編集・ターミナル）は使わない。

1. drawroid を起動し、表示された URL をブラウザで開く（「会話」の一覧が出る）
2. 左の脇の「依頼」（`/jobs/new`）を開き、「依頼」の欄に依頼文（例:「夕暮れの海辺に立つ白いワンピースの少女、アニメ調」）を入れる
3. 止める条件を「文から案を作る」に自然言語で入れて（例:「10 回まで、意図どおりなら止める」）「案を作る」を押し、変換結果を確かめ、1か所を専用の欄（「AI が意図どおりと判断したら止める」・「回数の上限」など）で直してから「投入する」を押す
4. 投入する前に、「参照画像（4 枚まで）」の「画像を選ぶ」で参照画像を1枚添える（任意）
5. 「ジョブ」（`/jobs`）の一覧の「走行中」に出ることを確かめる。詳細を開き、画面を再読み込みせずに回が増えていくこと（SWR のポーリング）を確かめる
6. 詳細の「操作」の「人間の指示」に口出しを入れて「送る」（例:「もっと逆光にして」）。生成中の1枚が止まらないことと、次の回の「考える」の決定に反映されることを確かめる。詳細で、口出しが「人間の指示」として AI の判断と分けて表示されることを確かめる
7. 「操作」の「止める条件を変える」で、走行中に条件を変える（例: 上限を 10 回 → 4 回）。次の回の境目で止まることを確かめる。止まらなくなる変更（上限を全部外し、AI の判断も外す）は、理由付きで断られることを確かめる
8. 別のジョブを1つ投入し、「操作」の「ジョブを止める」を押し、ブラウザの確認（「このジョブを止める。走っている回は途中で打ち切られる。よいか」）で OK を押して止める。「止まった理由: 人が止めた」になることを確かめる
9. 止まったジョブの詳細で、各回の画像・パラメータ・考える役の決定・見る役の評価と理由・止まった理由を確かめる
10. 詳細の「LLM の合計」と、各回の LLM 呼び出しの行で、ジョブごと・回ごとのトークン数と時間が出ること、「中身を見る」で中身（入力・出力）が読めることを確かめる。参照画像を渡した呼び出し（`ref-gist`）が1回だけであることも確かめる
    - 注: 左の脇の「LLM の記録」（`/llm-calls`）に出るのは、ジョブに属さない呼び出し（止める条件の変換など）だけ
11. 画像を1枚お気に入りに、1枚を却下にする。お気に入りの1枚を却下に選び直し、表示が変わることを確かめる
12. 途中でブラウザ以外の操作が要らなかったことを記録する。要った場合は、その操作と画面を記録する（M3:98 の穴として扱う）

記録として、各手順の画面のスクリーンショットと、drawroid の起動から最終選択までの時刻を残す。

### 会話の画面から通す

今の入口は会話の画面なので、同じ受け入れ基準を会話でもたどる。描くかどうか・口出しをどう伝えるかは話す役の LLM が決めるので、上の手順と違い、LLM の振る舞いも一緒に確かめることになる。

1. 「会話」の一覧で「新しい会話」を押し、依頼文を話しかけて「送る」
2. 話す役が描き始め、会話に進み具合と回ごとの画像が流れてくることを確かめる。質問だけをしたときは、描き始めないことも確かめる
3. 描いている途中に話しかけて口出しする（例:「もっと逆光にして」）。次の回に反映されることを確かめる
4. 画像の行（または画像を押して開く、大きく見る窓）で、「お気に入り」・「却下」と「この画像に決める」を確かめる。決めると、ジョブが止まる（`state.json` の `reason.kind` が `adopted`）
5. 別の依頼で描かせ、走っている途中で「止める」を押すと、会話に「描くのを止めた: 人が止めた」が出て、話す役のターンと会話のジョブが止まることを確かめる
6. AI の判断で止まったときは、止まりのカード（「描くのを止めた: …」）に、最良の画像と「このジョブから覚えたこと」が出ることを確かめる

### 失敗したときに見るファイル

M2 の「失敗したときに見るファイル」に加えて、データディレクトリ（既定は `~/.drawroid`）の `jobs/<jobId>/` の下の次を見る。

- `interventions/<interventionId>.json` — 口出し1件（手順 6・7）
  - `kind` が `instruction`（人間の指示）・`stopConditions`（止める条件の変更）・`mask`（塗ったマスク。M4:124）・`adopt`（この画像に決める）のどれか
  - 指示を取り込んだ回が `appliedInIteration` に入る。入っていなければ、まだ「考える」に取り込まれていない
  - `interventionId` は受けた順の連番（`000001` から）
- 止める条件は `job.json` を書き換えない（#24）。今効いている条件は `GET /api/jobs/auto/<jobId>/stop-conditions` の `current` で読む
- `refs/<refId>.<拡張子>`・`refs/<refId>.json` — 添えた参照画像と、その要点（`gist`）・渡した印（`sentInCall`）（手順 4・10）。`refId` は口出しとは別の連番
- `selections/<回>-<画像>.json` — お気に入り・却下（手順 11）。`verdict` と、選び直す前の `previous`
- `llm-calls/<callId>.json` の `purpose`
  - `think` の入力に「人間の指示:」の区画があるか（手順 6）
  - `ref-gist` が1件だけか（手順 10）

会話から通したときは、加えて `<データディレクトリ>/conversations/<会話ID>/` の下を見る。

- `events/<NNNNNN>.json` — 会話の出来事（発言・話す役の返事・ジョブの進み具合など）1件
- `llm-calls/<callId>.json` — 話す役の呼び出しの記録（`purpose` が `talk`）。ジョブの `llm-calls/` には入らない

## M4 — AI が触れるパラメータを広げ、設定で許可する

対象の受け入れ基準:

- M4:120 **実機で**: チェックポイントと LoRA を AI に選ばせた依頼が回る
- M4:122 **実機で**: 前の回の画像を元にした img2img がループの中で使われる
- M4:123 **実機で**: 人間が添えた参照画像を元にした img2img または ControlNet がループの中で使われる
- M4:124 **実機で**: 人間が UI で塗ったマスクで、次の回に inpaint が行われる

### 共通の前提

- **許可の既定に注意する。** 何も書かないと、AI に任されるのは `prompt`・`negativePrompt`・`seed`・`steps`・`cfgScale` だけで、`width`・`height` は 1024 に固定、`checkpoint`・`vae`・`loras`・`sampler`・`scheduler`・`hiresFix`・`img2img`・`inpaint`・`controlnet` は「使わない」になる（`GET /api/settings/permissions` の `permissions` で読める）。M4 の確認は、まず許可を書くところから始める
- 許可は、全体の既定を `PUT /api/settings/permissions` で書くか、`config.json` の `permissions` に同じ形で書く。画面では「許可」（`/permissions`）。1欄の形は `{"mode":"auto"}`・`{"mode":"auto","choices":["名前",…]}`・`{"mode":"fixed","value":…}`・`{"mode":"off"}` のどれか。ジョブごとに変えるときは、`POST /api/jobs/auto` の本文の `permissions` に同じ形で書く（#39）。走っているジョブにも、次の回の境目から効く（#50）
- **`PUT /api/settings/permissions` は、書いた欄を足すのではなく、全体を置き換える。** 下の節を続けてたどるときは、前の節で書いた欄も一緒に送る（例: `{"checkpoint":{"mode":"auto"},"loras":{"mode":"auto"},"img2img":{"mode":"auto"}}`）。今書いてある欄は、応答と `GET` の `overrides` で読める
- 起動は M2 と同じ

### M4:120 — チェックポイントと LoRA を AI に選ばせる

前提: 共通の前提のとおり。Forge にチェックポイントが2つ以上、LoRA が1つ以上あること。

手順:

1. 候補を確かめる: `curl http://127.0.0.1:7878/api/backend/candidates/checkpoint` と `curl http://127.0.0.1:7878/api/backend/candidates/lora`。Forge の画面と同じ名前が並ぶこと
2. 許可を書く: `curl -X PUT http://127.0.0.1:7878/api/settings/permissions -H 'content-type: application/json' -d '{"checkpoint":{"mode":"auto"},"loras":{"mode":"auto"}}'`。応答の `permissions` で、2つが `auto` になっていること
3. （任意）候補に短い説明を付ける: `curl -X PUT http://127.0.0.1:7878/api/backend/candidate-notes -H 'content-type: application/json' -d '{"<LoRA の名前>":"指の描写が得意"}'`（#50。説明は1件 200 字まで。これも全体の置き換え）
4. 投入する: `curl -X POST http://127.0.0.1:7878/api/jobs/auto -H 'content-type: application/json' -d '{"request":"夕暮れの海辺に立つ白いワンピースの少女、アニメ調","stopConditions":{"aiJudgement":false,"maxIterations":3}}'`
5. 止まるまで待ち、各回のファイルを見る

見るべき結果:

- 各回の `think.json` の `params.checkpoint` に、手順 1 の候補のどれかの名前が入る。`params.loras` は `[{"name":…,"weight":…}]` の形で、名前は候補のどれか
- 同じ回の `request.json` の `checkpoint`・`loras` に同じ名前が写る
- Forge のコンソールに、LoRA やチェックポイントが見つからない旨が出ない
- 3 回とも止まらずに回り、`state.json` の `reason.kind` が `limit:iterations` になる

失敗したときに見るファイル（`~/.drawroid` の下）:

- `config.json` の `permissions` — 手順 2 の欄が書かれているか
- `jobs/<jobId>/state.json` — 候補を取る段で止まっていれば、`reason.detail` に理由が入る（候補はジョブの始めに1回取る）
- `jobs/<jobId>/iterations/<NNNN>/plan.json` — `excluded` に、選択肢から外した欄とその理由が入る
- `jobs/<jobId>/llm-calls/<callId>.json`（`purpose` が `think`）
  - 入力に候補の一覧の区画があるか
  - `budget.notes` に、予算で落とした候補が残っているか（候補は種類ごとに既定で 20 件・600 字まで）
- `candidate-notes.json` — 手順 3 の説明。壊れていると、説明なしで進み、その理由が `budget.notes` に残る

### M4:122 — 前の回の画像を元にした img2img

前提: 共通の前提のとおり。

手順:

1. 許可を書く: `curl -X PUT http://127.0.0.1:7878/api/settings/permissions -H 'content-type: application/json' -d '{"img2img":{"mode":"auto"}}'`（M4:120 の許可も残すなら、共通の前提の例のようにまとめて送る）
2. 投入する（4 回まで回す）: `curl -X POST http://127.0.0.1:7878/api/jobs/auto -H 'content-type: application/json' -d '{"request":"夕暮れの海辺に立つ白いワンピースの少女、アニメ調","stopConditions":{"aiJudgement":false,"maxIterations":4}}'`
3. AI が img2img を選ばないまま止まったら、2 回目のあとで指示を入れて促す: `curl -X POST http://127.0.0.1:7878/api/jobs/auto/<jobId>/interventions -H 'content-type: application/json' -d '{"kind":"instruction","text":"前の回の一番良い画像を元に、構図を保って描き直して"}'`（#24）

見るべき結果:

- 2 回目以降のどれかの回で、`think.json` の `params.img2img` が `{"image":"best" または "latest","denoisingStrength":…}` になる（1 回目は元の画像が無いので出ない。`latest` は、直近の回が最良の回と違うときだけ選べる）
- 同じ回の `request.json` の `img2img.image` が `image:<回>-<画像>` の形で、前の回の画像を指す
- その回の画像の構図が、指した前の回の画像に近い

失敗したときに見るファイル（`~/.drawroid` の下）:

- `jobs/<jobId>/llm-calls/<callId>.json`（`purpose` が `think`）
  - 入力に、元にできる画像（最良・直近）の区画があるか。区画が入力の上限で落ちると、その画像は選べなくなる（`budget.notes` に残る）
- `jobs/<jobId>/iterations/<NNNN>/request.json` — `img2img` の欄が無ければ、その回は使われていない
- Forge の応答で失敗していれば `state.json` の `reason.detail`

### M4:123 — 人間が添えた参照画像を元にした img2img（または ControlNet）

前提: 共通の前提のとおり。ControlNet でも確かめるなら、Forge に ControlNet のモデルを1つ以上置き、`GET /api/backend` の `capabilities.unavailable` に ControlNet が無いこと。

手順:

1. 許可を書く: img2img で確かめるなら `{"img2img":{"mode":"auto"}}`、ControlNet でも確かめるなら `{"img2img":{"mode":"auto"},"controlnet":{"mode":"auto"}}` を `PUT /api/settings/permissions` に送る（`controlnet` の `choices` は ControlNet のモデルの名前に効く。#87）
2. 参照画像を用意し、base64 にする（例: `base64 -w0 ref.png`。macOS は `base64 -i ref.png`）
3. 参照画像を添えて投入する（#27）:
   ```sh
   printf '{"request":"この服の少女を夕暮れの海辺に","stopConditions":{"aiJudgement":false,"maxIterations":3},"references":[{"mediaType":"image/png","data":"%s","note":"この服で"}]}' "$(base64 -w0 ref.png)" > body.json
   curl -X POST http://127.0.0.1:7878/api/jobs/auto -H 'content-type: application/json' -d @body.json
   ```
   - 受け付ける形式は PNG・JPEG・WebP。1 枚 8 MB まで、1 回 4 枚まで（#27）
   - 走っている途中に添えるときは `POST /api/jobs/auto/<jobId>/interventions` に `{"kind":"reference","image":{"mediaType":…,"data":…}}`（#27）
   - 画面では、「依頼」の「参照画像（4 枚まで）」か、ジョブの詳細の「操作」の「参照画像を添える」で添えられる
4. 止まるまで待つ

見るべき結果:

- `llm-calls/` に `purpose` が `ref-gist` の呼び出しが1件だけあり、以後の `think` の入力に「参照画像の要点:」が文字列で載る
- img2img: どれかの回で、`think.json` の `params.img2img.image` が `ref:<refId>` になり、同じ回の `request.json` の `img2img.image` も `ref:<refId>` になる
- ControlNet: どれかの回で、`think.json` の `params.controlnet` が `{"model":…,"module":…,"image":"ref:<refId>"}`（`module` は省かれることがある）になり、同じ回の `request.json` の `controlnet` が `[{"model":…,"image":"ref:<refId>",…}]` になる。1回に1ユニットまで
- その回の画像に、参照画像の要素（服・ControlNet なら輪郭など）が出ている

失敗したときに見るファイル（`~/.drawroid` の下）:

- `jobs/<jobId>/refs/<refId>.json` — `gist`（要点）と `sentInCall`（渡した印）が入っているか。`gist` が無ければ、要点にする段で止まっている（`state.json` の `reason.detail` に「参照画像の要点」と出る）
- `jobs/<jobId>/refs/<refId>.<拡張子>` — 添えた画像そのもの
- `jobs/<jobId>/llm-calls/<callId>.json`（`purpose` が `think`）— 元にできる画像の区画に `ref:<refId>` があるか
- `jobs/<jobId>/iterations/<NNNN>/plan.json` — ControlNet がバックエンドで使えない（`reason.kind` が `backend`）、または候補や元にできる画像が無くて出せなかった（`no-candidates-shown`）ときは、`excluded` に出る

### M4:124 — 人間が塗ったマスクで、次の回に inpaint

前提: 共通の前提のとおり。

- 注: HTTP で送るときは、マスクを塗った画像と同じ大きさで作る（大きさが違うときの振る舞いは #43 の本文を見る）

手順:

1. 許可を書く: `curl -X PUT http://127.0.0.1:7878/api/settings/permissions -H 'content-type: application/json' -d '{"inpaint":{"mode":"auto"}}'`
2. 投入する（`maxIterations` を 5 などにして、途中で塗る時間を取る）
3. 1 回目の画像が出たら、ジョブの詳細（`/jobs/<jobId>`）の「回」で、その画像の下の「マスクを塗る」を押す。描き直したい所を白く塗り、「マスクを送る」を押す
   - 「マスクを塗る」は、走っているジョブの画像にだけ出る。会話から描いたときも、会話の「ジョブの詳細」から同じ画面へ行ける
   - 塗るのはマウス・タッチ・ペンで（キーボードでは塗れない）。「筆の太さ（px）」・「消しゴム」・「ひとつ戻す」・「全部消す」がある
   - 画面を使わずに確かめるときは、`iterations/0001/images/0.png` と同じ大きさで、全体を黒・描き直したい所を白にした PNG を作り、HTTP で送る（#43）:
     ```sh
     printf '{"kind":"mask","image":{"iteration":1,"index":0},"mask":{"data":"%s"}}' "$(base64 -w0 mask.png)" > mask.json
     curl -X POST http://127.0.0.1:7878/api/jobs/auto/<jobId>/interventions -H 'content-type: application/json' -d @mask.json
     ```
     `image` は塗った生成画像（何回目の何枚目か）。マスクは PNG だけ、8 MB まで

見るべき結果:

- 送ったあとの回の `think.json` の `params.inpaint` に `denoisingStrength` が入る（元画像とマスクは人間のもので、AI は強さだけを決める）
- 同じ回の `request.json` の `inpaint` が、`image` に `image:1-0`（塗った画像）、`mask` に `mask:<interventionId>` を持つ
- その回の画像で、白く塗った所だけが描き直されている
- 使ったマスクは切れる。もう一度 inpaint させるには、新しいマスクを送る

失敗したときに見るファイル（`~/.drawroid` の下）:

- `jobs/<jobId>/interventions/<interventionId>.json` — `kind` が `mask` の口出し。使われると `usedInIteration` が付く。付かなければ、まだ使われていない
- `jobs/<jobId>/masks/<interventionId>.png` — 送ったマスクそのもの
- `jobs/<jobId>/llm-calls/<callId>.json`（`purpose` が `think`）— 出力スキーマに `inpaint` があるか。マスクが無い回は、`inpaint` は選択肢に出ない

## M5 — 好みの記憶

対象の受け入れ基準:

- M5:145 **実機で**: 「指の崩れは許容しない」と口出ししたジョブのあと、別の依頼でその好みが「見る」の評価に効いている

### 前提（出どころ: #84）

- 自動のジョブが止まると（止まり方は問わない）、そのジョブの口出し・選択から好みを蒸留し、記憶に書く。会話から描いたジョブは、そのジョブに関わる会話での人間の発言も材料になる
- 記憶は回の境目ごとに読み直し、依頼に関係する項目を考える役と見る役の入力に載せる。人間が記憶のファイルを直すと、次の回から効く
- 会話で「覚えておいて」と言うと、話す役が記憶に書く（`remember`）。そのときの `sources` は、ジョブではなく `conversation:<会話ID>` になる

### 手順

1. 1 つ目のジョブを投入する（例: 人物が手を見せる依頼。`maxIterations` を 3 など）
2. 回の途中で口出しする: `curl -X POST http://127.0.0.1:7878/api/jobs/auto/<jobId>/interventions -H 'content-type: application/json' -d '{"kind":"instruction","text":"指の崩れは許容しない"}'`（画面ならジョブの詳細の「人間の指示」、会話なら描いている途中に話しかける）
3. ジョブが止まるのを待つ（止まったときに蒸留が走る）
4. 記憶を確かめる: `curl http://127.0.0.1:7878/api/memory` か、画面の「記憶」（`/memory`）。ジョブから覚えたことは `curl http://127.0.0.1:7878/api/jobs/<1 つ目の jobId>/distill` でも読める（会話から描いたときは、止まりのカードの「このジョブから覚えたこと」にも出る）
5. 2 つ目のジョブを、別の依頼で投入する（例: 別の構図で、手が写る依頼）
6. 止まるまで待ち、見る役の記録を見る

見るべき結果:

- 手順 3 のあと、`jobs/<1 つ目の jobId>/distill.json` の `entries` に `kind` が `stopped` の項目があり、`applied` に指の好みを足す操作（`op` が `add`）がある
- 手順 4 で、指の崩れを許容しない旨の項目が出る。`sources` に 1 つ目のジョブが入っている
- 2 つ目のジョブの見る役の呼び出し（`llm-calls/<callId>.json` の `purpose` が `judge`）の入力に、その項目の本文が載っている
- 2 つ目のジョブの `judge.json` で、指が崩れた画像の `issues` に指の崩れが挙がり、点数が下がっている

失敗したときに見るファイル（`~/.drawroid` の下）:

- `jobs/<1 つ目の jobId>/distill.json` — `entries` の `failure`（蒸留が失敗した理由）、`skipped`（足さなかった操作）、`budgetNotes`（予算で落とした材料）、`shown`（実際に LLM に見せた口出し・選択・記憶）
- `jobs/<1 つ目の jobId>/llm-calls/<callId>.json`（`purpose` が `distill`）— 蒸留の LLM の入力と出力
- `memory/<id>.md` — 記憶1項目。front matter（`tags`・`scope`・`sources`・`createdAt`・`updatedAt`）と本文。`scope` が `tagged` だと、依頼の言葉と関係が無いとして載らないことがある
- `jobs/<2 つ目の jobId>/llm-calls/<callId>.json`（`purpose` が `judge`）の `budget.notes` — 記憶を予算で落としていないか

## M6 — A1111 対応

対象の受け入れ基準:

- M6:157 **実機で**: A1111 に繋いで、M2 の実機の受け入れ基準と同じ依頼が回る

### 前提（出どころ: #61 と `packages/backend-a1111/README.md`）

- A1111 は 1.9 以上に対応する（1.9 からスケジューラの口があるため）。ControlNet を使うなら拡張 sd-webui-controlnet を入れる
- バックエンドの種類は、起動の `--backend a1111` か `config.json` の `backend.kind`（`"a1111"`）で決める。**画面では種類を変えられない**（「設定」の「バックエンドの URL」で変えられるのは URL だけ）
- 既定の URL は Forge と同じ `http://127.0.0.1:7860`。A1111 を `--api-auth` 付きで起動しているなら、`config.json` の `backend.auth` に `username` と `password` を書く

### 手順

1. A1111 を `--api` 付きで起動する
2. `pnpm drawroid doctor --backend a1111 --data-dir /tmp/drawroid-check-a1111` を打ち、画像のバックエンドの項（見出しが「画像のバックエンド（A1111）」）が全部「よい」になることを確かめる
   - 製品と版の行が「よい」であること（Forge が動いている所に A1111 として繋いだときや、版が 1.9 より古いときは「足りない」になる）
3. `pnpm drawroid --backend a1111 --data-dir /tmp/drawroid-check-a1111` で起動し、端末の2行目が「drawroid: A1111 http://127.0.0.1:7860」であることを確かめる
4. `curl http://127.0.0.1:7878/api/backend` で `capabilities` を見る。拡張を入れていれば `limits.controlnetUnits` が A1111 の ControlNet の設定のユニットの数と一致すること。入れていなければ、`unavailable` に理由付きで ControlNet が出ること
5. M2 の手順 2〜8 を、そのままたどる（M6:157）
6. （任意）M1 の手順 2〜5 と、M4 の節を同じようにたどる

見るべき結果:

- M2 の「見るべき結果」と同じ。各回の `request.json` が A1111 に受け付けられ、A1111 のコンソールに見つからない名前（チェックポイント・LoRA・サンプラ・スケジューラ・VAE）の警告が出ない
- エラーの説明の主語が「A1111」になっている

A1111 だけの注意:

- 二段目の CFG を一段目と分けた Hires. fix と、img2img・inpaint と Hires. fix の同時指定は、A1111 に投げずに理由付きで断る（A1111 は黙って読み捨てるため）
- `packages/backend-a1111/README.md` の「実機で要確認」の各項（ControlNet の拡張の実機の応答など）の結果も返してもらえれば、雛形（`packages/backend-a1111/src/test-support/fixtures/`。取り直す手順はその README）を差し替える

## マイルストーンの外 — 実機で見ておく振る舞い

受け入れ基準の行ではないが、本物の Forge・LLM で通しておきたい振る舞い。

### 止める合図で、走っている生成を止めさせる（出どころ: #333）

1. Forge（または A1111）で drawroid の生成が走っている間に、drawroid の端末で Ctrl+C を押す
2. 次を確かめる
   - 端末に「drawroid: 走っている生成をバックエンドに止めさせてから終わる」が出て、drawroid が終わること（終了コードは 130）
   - Forge の画面とコンソールで、生成が途中で止まったこと（drawroid は `POST /sdapi/v1/interrupt` を送る）
   - もう一度起動すると、ジョブが続きから回ること。途中で止めた回の画像が、回の結果として書かれていないこと（#333 の本文で、偶然に残りうるとした所）
3. drawroid の生成が走っていないときに止めても、Forge の画面で人が始めた生成は止まらないこと（何も出さずに終わる）

### llama.cpp の見る役に画像が渡る（出どころ: #340）

見る役に渡す縮小版は webp で保存しているが、LLM に送る直前に JPEG に変える（llama.cpp は webp を断るため）。

1. 見る役に llama.cpp の画像入力に対応したモデルを割り当て、`pnpm drawroid doctor` を打つ。LLM の項の見る役の行が「よい」になること
2. M2 の手順でジョブを回し、各回に `judge.json` ができること。見る役の呼び出し（`purpose` が `judge`）の `outcome` が失敗になっていないこと

### 接続が切れたことを画面に出す（出どころ: #331）

1. 会話で描かせている途中に、drawroid を `kill -9` で止める（Ctrl+C だと、上の節のとおり生成も止まる）
2. 会話の画面に「drawroid につながっていない。つながり直すのを待っている」が出て、進み具合のカードが「止まっている: drawroid につながっていないので、進み具合が届いていない」になること
3. drawroid を起動し直すと、数秒で2つの表示が消えること
