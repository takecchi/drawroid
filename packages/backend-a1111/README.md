# @drawroid/backend-a1111

AUTOMATIC1111/stable-diffusion-webui（A1111）の `/sdapi/v1` を叩く、画像生成バックエンドのアダプタ（M6。Issue #61）。
Forge のアダプタ（`@drawroid/backend-forge`）と共通の部分は `@drawroid/backend-sdapi` にあり、ここには A1111 だけの差を置く。

## 選び方

起動のときに `--backend a1111` を付けるか、`<データディレクトリ>/config.json` の `backend.kind` を `"a1111"` にする（どちらも無ければ Forge）。URL は Forge と同じく `--backend-url` か `backend.url` に書く（古い名前の `--forge-url`・`backend.forgeUrl` も読む）。

```json
{ "backend": { "kind": "a1111", "url": "http://127.0.0.1:7860" } }
```

## 対応する版

**A1111 は 1.9 以上に対応する。** これはクローン（miku）の判断で、オーナーの決定ではない。

根拠は、1.9 から `/sdapi/v1/schedulers` とスケジューラの欄（`scheduler`）があること。1.9 より前はスケジューラの口が無く、スケジューラがサンプラの名前に含まれる（例 `DPM++ 2M Karras`）。drawroid は候補の種類ごとに一覧を取り、契約の試験は「どの種類の候補も1件以上」を求めるので、1.9 より前には対応しない。古い版のために契約を緩めることはしない。

現物で確かめたのは v1.9.4（`feee37d`）と v1.10.1（`82a973c`）のソース。偽の A1111 の雛形は v1.10.1 から起こした（`src/test-support/fixtures/README.md`）。

**ControlNet の拡張（Mikubill/sd-webui-controlnet）は、v1.1.455（コミット `56cec5b`、2024-07-25）のソースで確かめた。** ControlNet の口の雛形（`controlnet-*.json`）も、このソースから起こしたもので、実機の応答ではない。拡張は 2024-07-25 のコミットを最後に更新が止まっている。

## Forge との差（このパッケージが吸収するもの）

| 項目         | A1111                                                                                                                                                     | Forge                                                         |
| ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| VAE の候補   | `/sdapi/v1/sd-vae` の `model_name`（ファイル名）                                                                                                          | `/sdapi/v1/sd-modules`                                        |
| VAE の指定   | `override_settings.sd_vae` に `model_name`。見つからない名前は黙って「None」になるので、先に `/sd-vae` に照らす                                           | `override_settings.forge_additional_modules` にファイルのパス |
| Hires. fix   | `hr_additional_modules`・`hr_cfg` は送らない（A1111 の本文の型に無く、黙って読み捨てられる）。二段目の CFG を一段目と分けたい要求は、叶えられないので断る | `hr_additional_modules`・`hr_cfg` を送る                      |
| ControlNet   | 外部の拡張（sd-webui-controlnet）。下の「ControlNet」                                                                                                     | 内蔵の sd_forge_controlnet                                    |
| エラーの文面 | 「A1111」と出す                                                                                                                                           | 「Forge」と出す                                               |

チェックポイント・LoRA・サンプラ・スケジューラ・アップスケーラの候補、チェックポイントの引き当て、サンプラとスケジューラの照らし、img2img・inpaint の欄、応答の読み取り、中断は、Forge と同じ形なので `@drawroid/backend-sdapi` のものを使う。

## ControlNet

要求の形は Forge と同じで、`alwayson_scripts.controlnet.args` にユニットの dict を並べる（共通の部分は `@drawroid/backend-sdapi` の `controlNetArgs`）。Forge との差は次のとおり。

- **入っているか:** `/sdapi/v1/scripts` の txt2img・img2img の両方に `controlnet` があるか。無ければ `probe` は理由付きで「使えない」と報告し、要求に ControlNet があれば断る
- **ユニットの数:** 拡張の `GET /controlnet/settings` の `control_net_unit_count`（`scripts/api.py:94-97`）。Forge のように `script-info` から推測しない。この口が無ければ「使えない」とする。上限を超えたユニットは A1111 本体が黙って捨てる（`modules/api/api.py:359`）ので、先に断る
- **モデル名:** 拡張は完全一致で外れると、ファイル名の部分一致で一番短いものを**黙って**選ぶ（`scripts/controlnet.py:76-89`）。このアダプタは先に `/controlnet/model_list` に照らし、「名前 [ハッシュ]」の完全一致か、ハッシュを除いた名前の完全一致（1つに決まるとき）だけを通す。部分一致は、候補が1つでも断る
- **モデルの一覧:** `/controlnet/model_list` は呼ぶたびにフォルダを読み直す（`update` の既定が true）。Forge と違い、モデルを置いたあとに再起動は要らない見込み
- **前処理なし:** 拡張の名前は小文字の `none`（Forge は `None`）。要求では欄を省いて表し、`none` を名前で指定したものは断る（Forge と同じ）
- **weight の上限:** 拡張の検証が 2 まで（`internal_controlnet/args.py:94`）。超えると生成が落ちるので、先に断る

## 実機で要確認

- 知らない欄（Forge だけの `hr_additional_modules` など）を送っても 422 にならないこと。このアダプタは送らないので、実際には踏まない
- LoRA の同じ名前のファイルが別の階層にあるときの振る舞い（`name` も後のものに上書きされる。`extensions-builtin/Lora/networks.py`）
- VAE のフォルダが空の構成で、VAE の候補が空になること（契約の「どの種類の候補も1件以上」は偽の A1111 なら通るが、実機ではありうる）
- サンプラとスケジューラの知らない名前の扱いは版で違う（Issue #41）。このアダプタは生成の前に一覧に照らすので、どちらの版でも黙って置き換わらない
- ControlNet の拡張の実機の応答（雛形はソースから起こした）。特に、`/controlnet/settings` の値が設定の画面のユニットの数と合うこと、ハッシュが取れないモデルの名前が `名前 [NOFILE]` になる場合（`modules/sd_models.py` の `model_hash`）の引き当て
