# Forge の応答の雛形

上流の Forge（lllyasviel/stable-diffusion-webui-forge、`main` の `dfdcbab685e57677014f05a3309b48cc87383167`、2025-06-26）の
`modules/api/models.py`・`modules/api/api.py`・`extensions-builtin/sd_forge_lora/scripts/lora_script.py` から、応答の形を起こしたもの。
txt2img の応答（`mock-forge.ts` の `fakeTxt2img`）は、同じコミットの `modules/api/api.py` の `text2imgapi` と `modules/processing.py` の `Processed.js` に合わせた。

M4 で足したものの出どころ（同じコミット）:

- `upscalers.json`・`latent-upscale-modes.json`: `modules/api/api.py` の `get_upscalers`・`get_latent_upscale_modes`
- `scripts.json`・`script-info.json`: `modules/api/api.py` の `get_scripts_list`・`get_script_info` と、`modules/scripts.py` の `api_info`。ControlNet の `args` の数（＝ユニットの数）は、`extensions-builtin/sd_forge_controlnet/scripts/controlnet.py` の `ui` がユニットごとに1つの部品を返すことからの推測。`args` の各要素の中身（`gr.State` の値がどう JSON になるか）は分からないので、`null` で埋めた
- `controlnet-model-list.json`・`controlnet-module-list.json`: `extensions-builtin/sd_forge_controlnet/lib_controlnet/api.py`。モデル名の `[ハッシュ]` の形は `lib_controlnet/global_state.py`
- img2img の応答は txt2img と同じ形（`modules/api/models.py` の `ImageToImageResponse`）なので、`mock-forge.ts` の `fakeTxt2img` を使い回す

**実機の形では未確認。** オーナーの手元の Forge から取った応答が届いたら、ここを差し替える。
