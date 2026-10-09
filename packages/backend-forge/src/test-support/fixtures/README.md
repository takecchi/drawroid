# Forge の応答の雛形

上流の Forge（lllyasviel/stable-diffusion-webui-forge、`main` の `dfdcbab685e57677014f05a3309b48cc87383167`、2025-06-26）の
`modules/api/models.py`・`modules/api/api.py`・`extensions-builtin/sd_forge_lora/scripts/lora_script.py` から、応答の形を起こしたもの。
txt2img の応答（`mock-forge.ts` の `fakeTxt2img`）は、同じコミットの `modules/api/api.py` の `text2imgapi` と `modules/processing.py` の `Processed.js` に合わせた。

**実機の形では未確認。** オーナーの手元の Forge から取った応答が届いたら、ここを差し替える。
