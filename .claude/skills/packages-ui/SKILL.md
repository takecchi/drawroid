---
name: packages-ui
description: packages/ui（Web UI の見た目の部品・テーマ・Storybook）と、apps/web がそれを使う形を触るときに読む。部品の足し方、`@/` の別名、色の名前、見本の置き方。
---

# packages/ui

`@drawroid/ui` は Web UI の見た目の部品だけを持つ（docs/architecture.md「パッケージ構成」）。**API（`@drawroid/swr`・`@drawroid/api`）も router（`react-router`）も import しない。** 行き先の link などは画面が渡す（`SiteHeader` に子として渡し、見た目は `siteNavLinkClass` で揃える）。

build は無く、ソースのまま公開する。apps/web の Vite が束ねる。

| 口                        | 中身                                                                            |
| ------------------------- | ------------------------------------------------------------------------------- |
| `@drawroid/ui`            | 画面向けの部品（`src/components/common.tsx`・`layout.tsx`・`features/`）と `cn` |
| `@drawroid/ui/shadcn`     | shadcn の素の部品（`src/components/ui/`）                                       |
| `@drawroid/ui/styles.css` | テーマ（Tailwind v4。色・土台の指定）                                           |

## 部品を足す

- **shadcn の部品は `pnpm --filter @drawroid/ui shadcn:add <名前...>` で足す**（素の `shadcn add` を打たない）。包み（`scripts/shadcn-add.mjs`）が、shadcn が吐く `from "cn"`（npm の無関係な `cn`）を `@/lib/utils` へ直し、依存から `cn` を外し、prettier を掛ける。足したら `src/components/ui/index.ts` へ1行足す（`src/shadcn-setup.test.ts` が書き忘れを落とす）
- **`src/components/ui/` の部品には手を入れない**（次の `shadcn:add --overwrite` で黙って消える）。画面の呼び方（`variant="primary"`・`tone="ok"`）へ合わせるのは `components/common.tsx` の役目
- **`components.json` の `"style": "radix-nova"` を消さない。** shadcn 4.x の既定は Base UI なので、消しても何も壊れず、次の `add` から静かに別物が来る
- 入力はネイティブの要素のまま使う（チェックボックスも `<input type="checkbox">` を包んだ `CheckboxField`）。radix の Checkbox は `button` になり、画面の試験が `checked` を見る口が変わるため

## `@/` の別名

`@/` は `packages/ui/src` の別名で、shadcn の部品が互いを import する形のまま使っている。対応は4か所に在る — `packages/ui/tsconfig.json` の `paths`・`packages/ui/.storybook/main.ts`・`apps/web/tsconfig.json` の `paths`・根の `vitest.config.ts`。**`packages/ui` の外で `@/` を書くと ESLint が落とす**（`eslint.config.js` の `UI_ALIAS_BAN`）。

## 色

- 名前は shadcn の既定のまま（`bg-background`・`bg-card`・`bg-muted`・`text-muted-foreground`・`bg-primary`・`text-destructive` …）。値は `src/styles.css`
- shadcn に無いものだけ足してある: `ok`・`warn`（状態）と、`human`・`ai`（人間の指示と AI の判断を見分ける印）
- `muted` / `accent` は shadcn では「控えめな面」の色。文字を薄くするのは `text-muted-foreground`
- 画面は明るい側だけ。`.dark` の値は Storybook の Theme の切り替えでだけ使っている

## Tailwind に class を拾わせる

`src/styles.css` の `@source './'` が、`packages/ui` の中の class を apps/web と Storybook のビルドに拾わせている。**消しても型検査も試験も緑のまま**、部品の中でしか使わない class だけが生成物の CSS から消える。見本（`*.stories.tsx`）は `@source not` で外し、`.storybook/preview.css` で拾わせ直している。

## 見本帳

- 根で `pnpm storybook`（http://localhost:6006）。build は `pnpm --filter @drawroid/ui build-storybook`（出力の `storybook-static` は git・prettier・ESLint から外してある）。CI では回していない
- 見本は部品の隣に `*.stories.tsx` で置く。見出しは `Foundations`・`UI/<名前>`・`Layout/<名前>`・`Features/<名前>`
- stories のファイルから見本以外を名前付き export しない（Storybook が見本として拾う）
- 見本の画像は外へ取りに行かない（data URL で書く）

## 試験

部品の試験は部品の隣に `*.test.tsx`（jsdom）で置く。根の `vitest.config.ts` の `include` が拾う。このパッケージだけを回すなら `pnpm exec vitest run packages/ui`。
