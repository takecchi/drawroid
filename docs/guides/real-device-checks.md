# 実機での確認の手順

[milestones.md](../milestones.md) の受け入れ基準のうち「**実機で**」と書いたものを、実際の Forge と LLM に繋いで確かめる手順。
スタブで確かめられる受け入れ基準は自動テストが持つので、ここには書かない。

- 手順は、各 PR の本文に書いた案を写したもの。節ごとに、どの PR から来たかを書く
- 手順の中の「注」は、写したあとに状況が変わった所への補足
- 結果（うまくいかなかった手順・画面のスクリーンショット・Forge や LLM の応答）は、出どころの PR か Issue に返す。応答の雛形（`packages/backend-forge/src/test-support/fixtures/`）を実機の形に差し替える材料になる

## 共通の準備

- Forge を `--api` 付きで起動しておく。既定の URL は `http://127.0.0.1:7860`
- drawroid は、リポジトリの根で `pnpm install` → `pnpm build` → `pnpm drawroid` で起動し、ブラウザで http://127.0.0.1:7878/ を開く
  - Forge の URL を変えるときは `pnpm drawroid --forge-url http://<host>:<port>`。**`--` を挟まない**（挟むと引数として受け付けずに落ちる）
  - データディレクトリを分けるときは `--data-dir <dir>`（既定は `~/.drawroid`）

## M1 — Forge で1枚生成する

対象の受け入れ基準:

- M1:47 **実機で**: Forge に繋いで1枚生成し、データディレクトリに画像とメタデータが置かれ、Web UI で見られる
- M1:48 と M1:49 はスタブの試験が持つが、実機でも次の手順の 6〜8 で確かめる

### 手順（出どころ: #26 の本文「実機での確認の手順（オーナー向け）」）

1. 共通の準備のとおり起動し、ブラウザで http://127.0.0.1:7878/ を開く
2. **繋がる**: 画面上の「バックエンドの状態」が「繋がっている」になり、チェックポイント・サンプラーなどの候補が select に入っていること
3. **1枚生成する（M1:47）**: プロンプトを入れ、枚数 1 で生成する
   - ジョブの詳細に移り、状態が `stopped`（`limit:iterations`）になり、画像と seed が出ること
   - `~/.drawroid/jobs/<jobId>/` に次が置かれていること
     - `job.json`・`state.json`
     - `iterations/0001/request.json`
     - `iterations/0001/images/0.png`・`0.json`（`0.json` に seed と Forge の応答のメタデータが入る）
4. **枚数 2 で生成する**: 画像が2枚出て、seed が別々であること（グリッド画像が混ざっていないこと）
5. **LoRA を1つ選んで生成する**: Forge のコンソールに LoRA が見つからない旨が出ないこと（#9 で、候補の名前を alias から name に変えたため）
6. **Forge が落ちているとき（M1:48）**: Forge を止め、画面を見る
   - 「Forge に繋がらない。」と、確かめることが出ること
   - 生のメッセージに `127.0.0.1:7860` が入っていること
   - その状態で生成すると、ジョブが `error` で止まり、同じ説明が出ること
7. **URL が違うとき（M1:48）**: 画面の設定欄で、Forge ではない URL に変えて保存する（例: drawroid 自身の `http://127.0.0.1:7878`）
   - 「繋がったが Forge の API が無い。」の説明が出ること
   - `~/.drawroid/config.json` に URL が書かれ、他のキーが残っていること
   - 正しい URL に戻して保存すると、再起動なしで「繋がっている」に戻ること
   - 注: 生成が走っているあいだの保存は、409 で断られる（#26 の追加のコミット）。生成が終わってから保存する
8. **保存中に殺す（M1:49）**: 生成中に drawroid を `kill -9` で止め、もう一度起動する
   - 起動のログに一時ファイルの片付けが出ること（出ない場合もある）
   - 画面の一覧が 500 にならないこと

結果（特に 3・6・7）が届いたら、#9・#13 の応答の雛形を実機の形に差し替える。

### 追加の確認項目（出どころ: #33 の本文「#26 の実機の手順に足す確認項目の案」）

画像を入力に使う生成（img2img・inpaint・ControlNet）と、Hires. fix の確認。Forge を `--api` 付きで起動し、ControlNet のモデル（canny など）を1つ置いた状態で行う。

- 注: 画像を入力に使う生成は、#33（M4）が main に入ってからになる。それまでは、#22 の手動の生成が画像を指す要求を断るので、2〜5 は `ForgeBackend` を直接呼ぶ小さなスクリプトか、M4 のループが入ってから行う（#33 の本文のとおり）

1. **probe と候補**: `GET /api/backend` で ControlNet が使えるものとして返り、`controlnetUnits` が Forge の設定の「ControlNet Unit の数」と一致すること。数が違えば、`script-info` から数える推測が外れている
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
7. **ControlNet を無効にした Forge**: 拡張の設定で sd_forge_controlnet を外して再起動し、`GET /api/backend` に理由付きで ControlNet が使えないと出ること

## M2 — LLM でループを回す

対象の受け入れ基準:

- M2:75 **実機で**: ローカル LLM（画像入力対応のもの）と Forge で、自然言語の依頼から3回以上ループが回って止まる。各呼び出しのトークン数が記録されている
- M2:76 **実機で**: provider を OpenAI または Anthropic に切り替えても同じ依頼が回る

### 手順（出どころ: #23 の本文「実機での確認の手順」）

- 注: #23 までの M2 の列が main に入ってから行う。それまでは #23 の枝で行う

1. Forge を起動しておく。`export OPENAI_API_KEY=...`（ローカル LLM なら不要）を設定してから、`pnpm build && pnpm drawroid --data-dir /tmp/drawroid-check --forge-url http://127.0.0.1:7860` で起動する
2. LLM の設定を保存する。ローカル LLM の例:
   `curl -X PUT http://127.0.0.1:7878/api/settings/llm -H 'content-type: application/json' -d '{"providers":{"local":{"type":"openai-compatible","baseURL":"http://127.0.0.1:1234/v1"}},"roles":{"think":{"provider":"local","model":"<画像入力に対応したモデル>"}}}'`
3. `curl http://127.0.0.1:7878/api/settings/llm` を叩き、応答にキーの値が無く、`apiKeyEnv.*.set` だけが出ていることを確かめる
4. `curl -X POST http://127.0.0.1:7878/api/jobs/auto -H 'content-type: application/json' -d '{"request":"夕暮れの海辺に立つ白いワンピースの少女、アニメ調","stopConditions":{"aiJudgement":true,"maxIterations":5}}'`
5. `curl http://127.0.0.1:7878/api/jobs/<jobId>` で、3 回以上回って止まり、止まった理由が残っていることを確かめる。`/tmp/drawroid-check/jobs/<jobId>/llm-calls/*.json` にトークン数が記録されていることも確かめる（M2:75）
6. provider を `openai` または `anthropic`（`apiKeyEnv` を指定）に変え、同じ依頼が回ることを確かめる（M2:76）
7. 走っている途中で `POST /api/jobs/auto/<jobId>/stop` を送り、`human` で止まることを確かめる。drawroid を kill して起動し直すと、続きから回ることを確かめる

### 失敗したときに見るファイル

データディレクトリ（既定は `~/.drawroid`。上の手順 1 では `/tmp/drawroid-check`）の下を見る。置き方は #16・#19・#23 の現物による。

- `config.json` の `llm` — 保存した LLM の設定。キーの値は書かれず、環境変数の名前だけが入る
- `jobs/<jobId>/job.json` — 依頼の原文・止める条件・1回の枚数
- `jobs/<jobId>/state.json` — `status`（`queued`・`running`・`stopped`）と、止まったときの `reason`（`kind` と `detail`）。`kind` が `error` なら、`detail` にどの段で何が起きたかが入る
- `jobs/<jobId>/iterations/<NNNN>/` — 回ごとの段の出力（`NNNN` は 0 埋めの回の番号）
  - `think.json`（考える役の決定）、`request.json`（バックエンドへ渡した要求）、`images/<n>.png`・`<n>.json`（画像と seed）、`judge.json`（見る役の評価）
  - 回の途中で止まった場合は、どのファイルまであるかで、どの段まで済んだかが分かる
- `jobs/<jobId>/llm-calls/<callId>.json` — LLM 呼び出し1回の記録
  - `usage`（トークン数。M2:75）、`attempts`（試行ごとの生の出力と、スキーマに合わなかった理由）、`outcome`、`budget.notes`（予算で切った・落としたもの）、`provider`・`model`（M2:76 で切り替わったか）

## M3 — Web UI で見て、止めて、口を出す

対象の受け入れ基準:

- M3:103 **実機で**: 依頼の投入から最終選択まで、Web UI だけで完結する

### 手順（出どころ: #34 の本文「M3:103 の手順書の案」）

前提: Forge が起動していて、drawroid の設定でつながっている。LLM の設定（考える役・見る役）が済んでいる。ブラウザ以外（curl・ファイルの直接編集・ターミナル）は使わない。

- 注: 画面は #32（一覧と詳細）と #35（投入と操作）が main に入ってから使える。それまでは #35 の枝で行う
- 注: 4 の参照画像の添付は、#27（参照画像を受け付ける HTTP の口）がマージされてから行う。それまでは 4 を飛ばし、10 の「参照画像を渡した呼び出しが1回だけ」も飛ばす

1. drawroid を起動し、表示された URL をブラウザで開く
2. 依頼の投入画面で、依頼文（例:「夕暮れの海辺に立つ白いワンピースの少女、アニメ調」）を入れる
3. 止める条件を自然言語で入れ（例:「10 回まで、意図どおりなら止める」）、変換結果を確かめ、1か所を専用フォームで直してから開始する
4. 参照画像を1枚添える（任意）
5. ジョブ一覧に「走行中」で出ることを確かめる。詳細を開き、画面を再読み込みせずに回が増えていくこと（SWR のポーリング）を確かめる
6. 回の途中で口出しを入れる（例:「もっと逆光にして」）。生成中の1枚が止まらないことと、次の回の「考える」の決定に反映されることを確かめる。詳細で、口出しが「人間の指示」として AI の判断と分けて表示されることを確かめる
7. 止める条件を走行中に変える（例: 上限を 10 回 → 4 回）。次の回の境目で止まることを確かめる。止まらなくなる変更（上限を全部外し、AI の判断も外す）は、理由付きで断られることを確かめる
8. 別のジョブを1つ投入し、停止ボタンで止める。止まった理由が「人間が止めた」になることを確かめる
9. 止まったジョブの詳細で、各回の画像・パラメータ・考える役の決定・見る役の評価と理由・止まった理由を確かめる
10. LLM 呼び出しの記録を開き、ジョブごと・回ごとのトークン数と時間が出ること、中身（入力・出力）が読めることを確かめる。参照画像を渡した呼び出しが1回だけであることも確かめる
11. 画像を1枚お気に入りに、1枚を却下にする。お気に入りの1枚を却下に選び直し、表示が変わることを確かめる
12. 途中でブラウザ以外の操作が要らなかったことを記録する。要った場合は、その操作と画面を記録する（M3:98 の穴として扱う）

記録として、各手順の画面のスクリーンショットと、drawroid の起動から最終選択までの時刻を残す。

### 失敗したときに見るファイル

M2 の「失敗したときに見るファイル」に加えて、データディレクトリ（既定は `~/.drawroid`）の `jobs/<jobId>/` の下の次を見る。

- `interventions/<interventionId>.json` — 口出し1件（手順 6・7）。#24 がマージされてから置かれる
  - `kind` が `instruction`（人間の指示）か `stopConditions`（止める条件の変更）か
  - 指示を取り込んだ回が `appliedInIteration` に入る。入っていなければ、まだ「考える」に取り込まれていない
  - `interventionId` は受けた順の連番（`000001` から）
- 止める条件は `job.json` を書き換えない（#24）。今効いている条件は `GET /api/jobs/auto/<jobId>/stop-conditions` の `current` で読む（#24 がマージされてから）
- `refs/<refId>.<拡張子>`・`refs/<refId>.json` — 添えた参照画像と、その要点（`gist`）・渡した印（`sentInCall`）（手順 4・10）。#27 がマージされてから置かれる
- `selections/<回>-<画像>.json` — お気に入り・却下（手順 11）。`verdict` と、選び直す前の `previous`。#31 がマージされてから置かれる
- `llm-calls/<callId>.json` の `purpose`
  - `think` の入力に「人間の指示:」の区画があるか（手順 6）
  - `ref-gist` が1件だけか（手順 10）

## M4 — AI が触れるパラメータを広げ、設定で許可する

対象の受け入れ基準:

- M4:120 **実機で**: チェックポイントと LoRA を AI に選ばせた依頼が回る
- M4:122 **実機で**: 前の回の画像を元にした img2img がループの中で使われる
- M4:123 **実機で**: 人間が添えた参照画像を元にした img2img または ControlNet がループの中で使われる
- M4:124 **実機で**: 人間が UI で塗ったマスクで、次の回に inpaint が行われる

### 共通の前提

- M4 のループの列 #39・#43・#49・#50 がマージされてから行う。この列は #27（参照画像）の上に積んであり、Forge の画像を入力に使う生成の #30・#33 も含む。それまでは #50 の枝で行う
- 注: #50 の枝には、M3 の画面（#32・#35）が入っていない。画面と M4 を同じ drawroid で動かすのは、両方がマージされてから。それまでは HTTP（curl）で行う
- **許可の既定に注意する。** 何も書かないと、AI に任されるのは `prompt`・`negativePrompt`・`seed`・`steps`・`cfgScale` だけで、`checkpoint`・`loras`・`img2img`・`inpaint` は「使わない」になる（#39 の `basicPermissions`）。M4 の確認は、まず許可を書くところから始める
- 許可は、全体の既定を `PUT /api/settings/permissions`（#50）で書くか、`config.json` の `permissions` に同じ形で書く。1欄の形は `{"mode":"auto"}`・`{"mode":"auto","choices":["名前",…]}`・`{"mode":"fixed","value":…}`・`{"mode":"off"}` のどれか。ジョブごとに変えるときは、`POST /api/jobs/auto` の本文の `permissions` に同じ形で書く（#39）。走っているジョブにも、次の回の境目から効く（#50）
- 起動は M2 と同じ。CLI の引数は M4 で増えていない（`--port`・`--data-dir`・`--forge-url` のまま）

### M4:120 — チェックポイントと LoRA を AI に選ばせる

前提: 共通の前提のとおり。Forge にチェックポイントが2つ以上、LoRA が1つ以上あること。

手順:

1. 候補を確かめる: `curl http://127.0.0.1:7878/api/backend/candidates/checkpoint` と `curl http://127.0.0.1:7878/api/backend/candidates/lora`。Forge の画面と同じ名前が並ぶこと
2. 許可を書く: `curl -X PUT http://127.0.0.1:7878/api/settings/permissions -H 'content-type: application/json' -d '{"checkpoint":{"mode":"auto"},"loras":{"mode":"auto"}}'`。応答の `permissions` で、2つが `auto` になっていること
3. （任意）候補に短い説明を付ける: `curl -X PUT http://127.0.0.1:7878/api/backend/candidate-notes -H 'content-type: application/json' -d '{"<LoRA の名前>":"指の描写が得意"}'`（#50。説明は1件 200 字まで）
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
- `jobs/<jobId>/llm-calls/<callId>.json`（`purpose` が `think`）
  - 入力に候補の一覧の区画があるか
  - `budget.notes` に、予算で落とした候補が残っているか（候補は種類ごとに既定で 20 件・600 字まで）
- `candidate-notes.json` — 手順 3 の説明。壊れていると、説明なしで進み、その理由が `budget.notes` に残る

### M4:122 — 前の回の画像を元にした img2img

前提: 共通の前提のとおり。

手順:

1. 許可を書く: `curl -X PUT http://127.0.0.1:7878/api/settings/permissions -H 'content-type: application/json' -d '{"img2img":{"mode":"auto"}}'`
2. 投入する（4 回まで回す）: `curl -X POST http://127.0.0.1:7878/api/jobs/auto -H 'content-type: application/json' -d '{"request":"夕暮れの海辺に立つ白いワンピースの少女、アニメ調","stopConditions":{"aiJudgement":false,"maxIterations":4}}'`
3. AI が img2img を選ばないまま止まったら、2 回目のあとで指示を入れて促す: `curl -X POST http://127.0.0.1:7878/api/jobs/auto/<jobId>/interventions -H 'content-type: application/json' -d '{"kind":"instruction","text":"前の回の一番良い画像を元に、構図を保って描き直して"}'`（#24）

見るべき結果:

- 2 回目以降のどれかの回で、`think.json` の `params.img2img` が `{"image":"best" または "latest","denoisingStrength":…}` になる（1 回目は元の画像が無いので出ない）
- 同じ回の `request.json` の `img2img.image` が `image:<回>-<画像>` の形で、前の回の画像を指す
- その回の画像の構図が、指した前の回の画像に近い

失敗したときに見るファイル（`~/.drawroid` の下）:

- `jobs/<jobId>/llm-calls/<callId>.json`（`purpose` が `think`）
  - 入力に、元にできる画像（最良・直近）の区画があるか。区画が入力の上限で落ちると、その画像は選べなくなる（`budget.notes` に残る）
- `jobs/<jobId>/iterations/<NNNN>/request.json` — `img2img` の欄が無ければ、その回は使われていない
- Forge の応答で失敗していれば `state.json` の `reason.detail`

### M4:123 — 人間が添えた参照画像を元にした img2img（または ControlNet）

前提: 共通の前提のとおり。

- 注: ControlNet は、まだループの中で AI に選ばせていない（#43。`params-schema.ts` で `not-supported-yet`）。今は img2img でこの行を確かめる。ControlNet でも確かめるのは、ループに配線する PR がマージされてから

手順:

1. 許可を書く: M4:122 の手順 1 と同じ（`img2img` を `auto`）
2. 参照画像を用意し、base64 にする（例: `base64 -w0 ref.png`。macOS は `base64 -i ref.png`）
3. 参照画像を添えて投入する（#27）:
   ```sh
   printf '{"request":"この服の少女を夕暮れの海辺に","stopConditions":{"aiJudgement":false,"maxIterations":3},"references":[{"mediaType":"image/png","data":"%s","note":"この服で"}]}' "$(base64 -w0 ref.png)" > body.json
   curl -X POST http://127.0.0.1:7878/api/jobs/auto -H 'content-type: application/json' -d @body.json
   ```
   - 受け付ける形式は PNG・JPEG・WebP。1 枚 8 MB まで、1 回 4 枚まで（#27）
   - 走っている途中に添えるときは `POST /api/jobs/auto/<jobId>/interventions` に `{"kind":"reference","image":{"mediaType":…,"data":…}}`（#27）
4. 止まるまで待つ

見るべき結果:

- `llm-calls/` に `purpose` が `ref-gist` の呼び出しが1件だけあり、以後の `think` の入力に「参照画像の要点:」が文字列で載る
- どれかの回で、`think.json` の `params.img2img.image` が `ref:<refId>` になり、同じ回の `request.json` の `img2img.image` も `ref:<refId>` になる
- その回の画像に、参照画像の要素（服など）が出ている

失敗したときに見るファイル（`~/.drawroid` の下）:

- `jobs/<jobId>/refs/<refId>.json` — `gist`（要点）と `sentInCall`（渡した印）が入っているか。`gist` が無ければ、要点にする段で止まっている（`state.json` の `reason.detail` に「参照画像の要点」と出る）
- `jobs/<jobId>/refs/<refId>.<拡張子>` — 添えた画像そのもの
- `jobs/<jobId>/llm-calls/<callId>.json`（`purpose` が `think`）— 元にできる画像の区画に `ref:<refId>` があるか

### M4:124 — 人間が塗ったマスクで、次の回に inpaint

前提: 共通の前提のとおり。

- 注: マスクを塗る画面はまだ無い（Issue #48）。「UI で塗った」を確かめるのは、画面の PR がマージされてから。それまでは、マスクの PNG を手で作り、HTTP で送って、inpaint がループの中で使われるところまでを確かめる（#43）
- 注: マスクと塗った画像の大きさが違うときの振る舞いは確かめていない（#43 の本文）。マスクは塗った画像と同じ大きさで作る

手順:

1. 許可を書く: `curl -X PUT http://127.0.0.1:7878/api/settings/permissions -H 'content-type: application/json' -d '{"inpaint":{"mode":"auto"}}'`
2. 投入する（`maxIterations` を 5 などにして、途中で送る時間を取る）
3. 1 回目が終わったら、`jobs/<jobId>/iterations/0001/images/0.png` と同じ大きさの PNG を画像編集ソフトで作る。全体を黒にし、描き直したい所を白で塗る
4. マスクを送る（#43）:
   ```sh
   printf '{"kind":"mask","image":{"iteration":1,"index":0},"mask":{"data":"%s"}}' "$(base64 -w0 mask.png)" > mask.json
   curl -X POST http://127.0.0.1:7878/api/jobs/auto/<jobId>/interventions -H 'content-type: application/json' -d @mask.json
   ```
   - `image` は塗った生成画像（何回目の何枚目か）。マスクは PNG だけ、8 MB まで

見るべき結果:

- 送ったあとの回の `think.json` の `params.inpaint` に `denoisingStrength` が入る（元画像とマスクは人間のもので、AI は強さだけを決める）
- 同じ回の `request.json` の `inpaint` が、`image` に `image:1-0`、`mask` に `mask:<interventionId>` を持つ
- その回の画像で、白く塗った所だけが描き直されている
- 使ったマスクは切れる。もう一度 inpaint させるには、新しいマスクを送る

失敗したときに見るファイル（`~/.drawroid` の下）:

- `jobs/<jobId>/interventions/<interventionId>.json` — `kind` が `mask` の口出し。使われると `usedInIteration` が付く。付かなければ、まだ使われていない
- `jobs/<jobId>/masks/<interventionId>.png` — 送ったマスクそのもの
- `jobs/<jobId>/llm-calls/<callId>.json`（`purpose` が `think`）— 出力スキーマに `inpaint` があるか。マスクが無い回は、`inpaint` は選択肢に出ない

## M5 — 好みの記憶

対象の受け入れ基準:

- M5:145 **実機で**: 「指の崩れは許容しない」と口出ししたジョブのあと、別の依頼でその好みが「見る」の評価に効いている

### 前提

- **今の PR の列では、この行はたどれない。** 次の2つの配線が、どの PR の枝にも無い
  - ジョブが止まったときに蒸留を呼ぶ配線（蒸留そのものは #25 の `distillStoppedJob` にあるが、呼ぶ側が無い）
  - 見る役の入力に記憶を渡す配線（組み立て器の口は #18 にあるが、ランナーの `buildJudgeInput` の呼び出しに記憶が渡っていない）
- 2つの配線の PR と、記憶の列 #11・#17・#18・#25・#40 がマージされてから行う。下の手順は、その時点でたどる案。エンドポイントとファイルの置き場所は #17・#25・#40 の現物から取った
- 記憶のファイルを手で `memory/` に置けば、`/api/memory` と画面 `/memory`（#40）に出ることまでは今の枝でも確かめられる。ただし、見る役の評価に効くことは確かめられない

### 手順（配線がマージされてから）

1. 1 つ目のジョブを投入する（例: 人物が手を見せる依頼。`maxIterations` を 3 など）
2. 回の途中で口出しする: `curl -X POST http://127.0.0.1:7878/api/jobs/auto/<jobId>/interventions -H 'content-type: application/json' -d '{"kind":"instruction","text":"指の崩れは許容しない"}'`
3. ジョブが止まるのを待つ（止まったときに蒸留が走る）
4. 記憶を確かめる: `curl http://127.0.0.1:7878/api/memory`（#40）か、画面の `/memory`
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
