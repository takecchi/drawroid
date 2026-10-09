# A1111 の応答の雛形

上流の A1111（AUTOMATIC1111/stable-diffusion-webui、タグ `v1.10.1`、コミット `82a973c04367123ae98bd9abdf80d9eda9b910e2`）のソースから、応答の形を起こしたもの。
Forge の雛形（`packages/backend-forge/src/test-support/fixtures/`）と対になる。M6 の A1111 のアダプタ（Issue #61）で、偽の A1111 サーバが返す応答と、契約の試験（`describeImageBackendContract`）の材料にする。

**実機の形では未確認。** オーナーの手元の A1111 から取った応答が届いたら、ここを差し替える（下の「実機から取り直すとき」）。

## ファイルと出どころ

行番号は `v1.10.1` のもの。

| ファイル                                       | 口                                                              | 形の出どころ                                                                                                                                               |
| ---------------------------------------------- | --------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `sd-models.json`                               | `GET /sdapi/v1/sd-models`                                       | `modules/api/models.py:255-261`（`SDModelItem`）、`modules/api/api.py:726-728`、値の作り方は `modules/sd_models.py` の `CheckpointInfo`                    |
| `sd-vae.json`                                  | `GET /sdapi/v1/sd-vae`                                          | `modules/api/models.py:263-265`（`SDVaeItem`）、`modules/api/api.py:730-732`、名前の作り方は `modules/sd_vae.py:68-69`・`95-104`                           |
| `loras.json`                                   | `GET /sdapi/v1/loras`                                           | `extensions-builtin/Lora/scripts/lora_script.py:53-65`、`alias` の既定は `extensions-builtin/Lora/network.py:49`                                           |
| `samplers.json`                                | `GET /sdapi/v1/samplers`                                        | `modules/api/models.py:233-236`（`SamplerItem`）、`modules/api/api.py:692-693`、一覧は `modules/sd_samplers_kdiffusion.py:11-`                             |
| `schedulers.json`                              | `GET /sdapi/v1/schedulers`                                      | `modules/api/models.py:238-243`（`SchedulerItem`）、`modules/api/api.py:695-704`、一覧は `modules/sd_schedulers.py:130-143`                                |
| `cmd-flags.json`                               | `GET /sdapi/v1/cmd-flags`                                       | `modules/api/api.py:222`・`689`。実際は起動の引数をすべて返す。雛形は Forge と同じく、使う欄の周りだけを残した                                             |
| `scripts.json`・`scripts-with-controlnet.json` | `GET /sdapi/v1/scripts`                                         | `modules/api/models.py:302-304`（`ScriptsList`）、`modules/api/api.py:244`・`294-298`。名前は各スクリプトの `title().lower()`（`modules/scripts.py:653`）  |
| `txt2img-info.json`                            | `POST /sdapi/v1/txt2img` の応答の `info`（JSON の文字列）の中身 | `modules/processing.py:570-605`（`Processed.js`）。応答そのものは `modules/api/models.py:134-137`（`TextToImageResponse`: `images`・`parameters`・`info`） |

## Forge の雛形と違う所（A1111 のアダプタが吸収する差）

- **VAE の口が違う。** A1111 は `/sdapi/v1/sd-vae`（`{ model_name, filename }`）で、`model_name` はファイル名（拡張子つき・サブフォルダは付かない）。Forge の `/sdapi/v1/sd-modules` は A1111 に無い
- **サブフォルダのチェックポイントの `model_name`。** A1111 は `/` を `_` に置き換える（`real/juggernaut-xl.safetensors` → `real_juggernaut-xl`）。Forge の雛形は `real/juggernaut-xl` のまま。指定には `title` を使うので、`model_name` は表示の材料にだけ使う
- **ControlNet の有無。** A1111 の ControlNet は外部の拡張（Mikubill/sd-webui-controlnet）。入っていれば `/sdapi/v1/scripts` の txt2img・img2img の両方に `controlnet` が出る（拡張の `scripts/controlnet.py:319-320` の title が `"ControlNet"`）。`scripts.json` は入っていない構成、`scripts-with-controlnet.json` は入っている構成
- **スクリプトの名前の一覧は例。** 本体と内蔵の拡張の title から起こした一部で、実機では拡張の入れ方で変わる。見分けに使うのは `controlnet` があるかだけ
- **サンプラの `options` の値は文字列。** 応答の型が `dict[str, str]`（`models.py:236`）なので、`True` は `"True"` になる見込み（Forge の雛形と同じ書き方）

## 実機から取り直すとき

対応する A1111 の版の下限は 1.9（Issue #61。クローンの判断）。v1.9 系か v1.10 系の実機で、`--api` を付けて起動し、次の応答をそのまま保存する。`--api-auth` を付けているときは `-u <user>:<password>` を足す。

```sh
A1111=http://127.0.0.1:7860
curl -s "$A1111/sdapi/v1/sd-models"  > sd-models.json
curl -s "$A1111/sdapi/v1/sd-vae"     > sd-vae.json
curl -s "$A1111/sdapi/v1/loras"      > loras.json
curl -s "$A1111/sdapi/v1/samplers"   > samplers.json
curl -s "$A1111/sdapi/v1/schedulers" > schedulers.json
curl -s "$A1111/sdapi/v1/cmd-flags"  > cmd-flags.json
curl -s "$A1111/sdapi/v1/scripts"    > scripts.json   # ControlNet の拡張を入れたときは scripts-with-controlnet.json に
curl -s -X POST "$A1111/sdapi/v1/txt2img" -H 'content-type: application/json' \
  -d '{"prompt":"a cat","steps":4,"cfg_scale":7,"seed":42,"width":64,"height":64,"batch_size":2,"save_images":false}' \
  | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.stringify(JSON.parse(JSON.parse(s).info),null,2)))' \
  > txt2img-info.json
```

- 取り直したら、モデル・LoRA の名前やパス・ハッシュは、手元の環境が分からない値に置き換えてよい（形を見るための雛形なので）。置き換えたら、そのことをこの README に書く
- 取り直した版とコミットを、この README の先頭に書く
- 「実機で要確認」の3つ（Issue #61）も、取り直すときに一緒に確かめる。知らない欄を送っても 422 にならないこと、同じ名前の LoRA が別の階層にあるときの振る舞い、VAE のフォルダが空のときの `sd-vae` の応答
