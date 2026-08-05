# AGENTS.md

このプロジェクト（Plasmo + React + TypeScript の Chrome 拡張機能 `x-old-chat`）で作業するエージェント向けの補足事項。

## 既知の許容事項

### ビルド成果物のマニフェストに死んだ `web_accessible_resources` が残る

`pnpm build`（`plasmo build`）で生成される `build/chrome-mv3-prod/manifest.json` には、
実在しないファイル `dm-modal.<hash>.css` を指す `web_accessible_resources` エントリが残る。

- **原因**: CSUI（`contents/dm-modal.tsx`）で `getStyle` + `data-text:~styles/globals.css` を使い
  CSS を JS にインライン化して shadow DOM へ注入している。この構成だと Plasmo の parcel packager が
  最終段階で CSUI 用の CSS を `web_accessible_resources` に機械的に登録するが、CSS は
  インライン化済みのため参照先の `.css` ファイルは書き出されない。Plasmo 側の噛み合わせ問題。
- **確認済みの事実**:
  - この死んだ参照はソースにも中間マニフェスト（`.plasmo/`）にも存在せず、packager が付与する。
  - `package.json` の `manifest.web_accessible_resources` で上書きしても Plasmo に無視される。
  - CSS を通常 import（ファイル生成）に変えると `content_scripts.css`（ページ側）へ注入され、
    shadow DOM に届かずモーダルが無装飾になるため採用不可。`getStyle` インラインが必須。
  - 死んだ参照は実行時に読み込まれず（JS は参照しない）、モーダルの装飾にも影響しない（実機検証済み）。
- **方針**: **許容する。** ビルド後にマニフェストから除去する後処理は入れない
  （コスト対効果が見合わないため）。動作・スタイルともに問題なし。
- **もし将来ストア審査等で問題になった場合**: `build/chrome-mv3-prod/manifest.json` から
  該当 `web_accessible_resources` エントリを手動で削除してから `pnpm package` すればよい。

## ルーティング方針（最重要・変更時の注意）

**x.com のどのパスへもナビゲートしてはならない。** UI は全画面オーバーレイで提供し、X の SPA ルーターには一切触れない。

- 2026-08-05 時点で `/messages` と `/messages/conversations` も封鎖された。サーバーは 200 を返すが、
  `main.js` の React Router (`history` パッケージ) の `confirmTransitionTo` が `history.replaceState("/i/chat")`
  を呼ぶクライアントサイドのルート差し替えで、放置すると `/i/chat/pin/new`（XChat のパスコード新規設定
  ＝**不可逆移行の入口**）まで自動で到達する。
- したがって `location.assign` / `location.href` 代入 / リンクのデフォルト遷移で `/messages` 配下や
  `/i/chat` 配下へ行かせないこと。DM 導線のリンクはキャプチャフェーズで `preventDefault()` して
  オーバーレイを開くだけにする（`contents/dm-modal.tsx`）。
- **`/i/chat` → `/messages/conversations` へのリダイレクトは絶対に書かないこと。** X 側が逆方向へ
  差し戻すため無限ループになる（この拡張の旧実装が実際にそうなっていた）。`/i/chat` に迷い込んだ場合の
  離脱先は `/home` とし、`sessionStorage` のフラグ経由でオーバーレイを自動的に開く。
- 旧 REST DM API（`dm/inbox_initial_state.json` / `dm/conversation/<id>.json` / `dm/new2.json`）は
  生きており本文を平文で返す。封鎖されたのは UI だけなので、閲覧・送信はすべて直接 fetch で完結させる。

## スタイリングの前提（変更時の注意）

- UI は shadcn/ui 流の素の React コンポーネント（`components/ui/`）+ Tailwind。reka-ui / @radix-ui は不使用。
  reka-ui は Vue 3 用のため、そもそも本プロジェクト（React）では使えない。
- Radix を導入しない理由: Dialog / DropdownMenu / Tooltip / Popover の Portal は `document.body` に出るため、
  shadow DOM 内に注入した Tailwind が届かず無装飾になる（`container` prop での回避は全箇所対応が必要）。
  現状必要な部品はいずれも Portal 不要で、素の実装で足りている。
- モーダルは content script の **shadow DOM** 内にマウントされるため、ページ（x.com）の CSS は届かない。
  Tailwind でコンパイルした `styles/globals.css` を `getStyle` で shadow DOM に注入して初めて装飾される。
  この CSS 注入は必須部品であり削除しないこと。
- `rem` は x.com のルート `font-size`（実測 14px）を参照するため、Tailwind の `rem` 系サイズは
  標準の 16px 基準より約 12% 小さく出る。実害はないが、幅の実測値が想定と合わないときはこれが理由。

## 権限方針（審査向け）

- 権限は x.com 限定。`permissions` / `host_permissions` はいずれも付与しない
  （content script は同一オリジンで動くため `host_permissions` 不要）。
- content script の `matches` は `https://x.com/*` のみ。
