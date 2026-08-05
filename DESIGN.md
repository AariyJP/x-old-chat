# x-old-chat 設計書

Chrome拡張機能「x-old-chat」の設計書。実装は本書を読んだ別エージェントが担当する。本書は実装方針・API仕様・UI仕様・受け入れ基準までを含む。

---

## 1. 背景と目的

X（旧Twitter）は現在、DM機能を「Messages（旧来の平文DM）」から「Chat（エンドツーエンド暗号化・4桁パスコード必須）」へ強制的に移行させようとしている。

Web UI上で新規に会話を開始しようとする操作は、以下のいずれであっても、クリック・直接URL入力を問わず、すべてクライアントサイドのSPAルーティングによって `/i/chat/...` へリダイレクトされ、パスコード作成画面（「新しいXチャットへようこそ」）へ強制的に誘導される。

- プロフィールページの「メッセージ」ボタン
- ツイートの共有メニューの「チャット経由で送信」
- `/messages/compose` への直接URL遷移
- 公式ドキュメント記載の `/messages/compose?recipient_id=<ID>` 形式のIntent URLへの直接ナビゲート
- **`/messages` および `/messages/conversations`（旧DM一覧画面）への遷移**（2026-08-05に封鎖を確認。それ以前は到達できていた）

**パスコードを一度でも作成すると、Chatへの移行が確定してしまう。** この移行は後戻りできないため、絶対に回避しなければならない。

一方で、ブラウザの実ネットワークリクエストを観察したところ、**サーバー側では旧来のREST APIエンドポイント `dm/new2.json` が今も完全に生きている**ことが判明した。これはWeb UIのSPAルーティングを一切経由せず、ブラウザの `fetch` から直接叩けば、パスコードなし・Chat誘導なしで、既存の会話にも完全に新規（面識ゼロ）の相手にも、平文DMとして正常に送信できることを実機で検証済みである。

さらに2026-08-05の再調査で、**読み取り系の旧REST DM APIも同様に生存している**ことを確認した。`dm/inbox_initial_state.json`（会話一覧・参加ユーザー・直近メッセージ）と `dm/conversation/<id>.json`（スレッド履歴、`max_id` で過去へ遡及可能）はいずれも200を返し、**本文を平文のまま返す**。XChatのE2E暗号化は新フロントエンドと専用GraphQL（`GetPublicKeysQuery` 等）の層の話であって、旧DMの実体は暗号化されていない。

また、封鎖の実装はサーバー側ではない。`/messages/conversations` はサーバーが200を返し、`main.js` の React Router（`history` パッケージ）の `confirmTransitionTo` が `history.replaceState("/i/chat")` を呼ぶ**クライアントサイドのルート差し替え**である。放置すると最終的に `/i/chat/pin/new`（パスコード新規設定画面）まで自動で到達する。

本拡張機能の目的は、**Xの通常のブラウジング体験（x.comへのログイン状態）に相乗りしつつ、旧Messagesの閲覧と送信を、Chatに一切触れずに行えるようにすること**である。旧DM画面が封鎖された現在、UIもまた拡張機能が自前で提供する必要がある。プロジェクト名は `x-old-chat`。

---

## 2. スコープ・非スコープ

### スコープ（本拡張機能が行うこと）

- Chatに一切触れず、旧来の平文DMの**閲覧と送信**を自前UIで完結させる。
- 会話一覧とスレッド履歴を `dm/inbox_initial_state.json` / `dm/conversation/<id>.json` から取得して表示する（`max_id` による過去への遡及を含む）。
- 選択中のスレッドへ返信を送信する。
- 開いているスレッドについては Live Pipeline (SSE) の `/dm_update/<conversation_id>` を購読し、相手からの新着をリアルタイムに反映する。
- 相手のscreen_nameから数値ユーザーIDとDM可否を解決し、面識のない相手へ新規送信する。
- `dm/new2.json` への直接fetchによってDMを送信する。
- UIはx.com上の全画面オーバーレイとして表示し、**ページ遷移を一切発生させない**。

### 非スコープ（本拡張機能が行わないこと）

- **一覧全体のリアルタイム追従は行わない。** 購読するのは開いているスレッドのみ。閉じている会話に届いた新着は、その会話を開くまで反映されない（一覧の未読インジケータもその時点の状態のまま）。
- **既読処理は行わない。** 未読インジケータの表示は行うが、既読化APIは叩かない。
- **グループDM非対応。** 2者間の1対1を主対象とする（グループが混ざっても一覧・閲覧は壊れないが、専用UIは持たない）。
- **画像・メディア・カード添付非対応。** テキスト本文の送受信のみ。添付のみのメッセージは「（本文なし）」と表示される。
- **Chrome Web Storeへの公開は考慮しない。** ローカルで「パッケージ化されていない拡張機能を読み込む」前提とする。
- 複数アカウント切り替え、送信履歴の保存、下書き保存などは行わない。

---

## 3. 全体アーキテクチャ

### 3.1 技術スタック

- **フレームワーク: Plasmo**（`plasmo` パッケージ）を使って実装する。Plasmoはブラウザ拡張機能開発フレームワークで、`contents/` ディレクトリに置いたファイルを自動的にcontent scriptとしてバンドルし、`manifest.json` 相当の設定も `package.json` の `manifest` フィールドや各ファイルのconfigエクスポートから自動生成する。
- **実装言語: TypeScript** を使う。
- **パッケージマネージャ: pnpm**。開発は `pnpm dev`（`plasmo dev`）、本番ビルドは `pnpm build`（`plasmo build`）で行う。
- 同ユーザーの既存Plasmo拡張プロジェクト `persister`（`pnpm` + Plasmo + TypeScript構成）に構成を合わせる。

### 3.2 方式

- **Manifest V3** で実装する（PlasmoがMV3のマニフェストを生成する）。
- 主要ロジックは **content script** として x.com のページ内に注入する。content scriptはページと同一オリジン（`https://x.com`）のコンテキストでfetchを実行するため、`ct0` / `twid` などのCookieが `credentials: "include"` で自動送付され、認証済みリクエストをそのまま発行できる。
- background service workerは原則不要。すべてcontent script内で完結させる。（将来的にqueryId抽出をbackgroundに逃がす拡張余地はあるが、初版では持たない。）

### 3.3 同一オリジンの利点

- fetch対象（`https://x.com/i/api/...`）とcontent scriptの実行オリジンが一致するため、CORSプリフライトやCookie付与の追加設定は不要。
- `authorization` Bearerトークンは全ユーザー共通の公開値（後述）をハードコードする。秘密情報ではない。
- `x-csrf-token` は `document.cookie` の `ct0` から都度読み取る。

### 3.4 権限（permissions）

同一オリジンのfetchのみで完結するため、権限は最小限でよい。

- content scriptのマッチ対象（Plasmoでは各 `contents/*.ts` の `export const config: PlasmoCSConfig` の `matches`）に `https://x.com/*`（実運用上は少なくとも `https://x.com/i/*` と `https://x.com/messages/*` を含む）を指定する。
- `host_permissions` は content script が同一オリジンで動く限り必須ではないが、将来 background から x.com API を叩く可能性に備えるなら `https://x.com/*` を明示してもよい。
- `cookies` 権限は不要（`document.cookie` から読むため）。
- `storage` 権限は、後述のGraphQL queryIdをユーザーが手動更新して保存できるようにする場合のみ任意で付与する（初版はハードコードでも可）。

### 3.5 注入方針

- content scriptを `document_idle`（Plasmoの `run_at: "document_idle"`）で注入する。
- x.comはSPAであり、DOMが遅延・再描画される。後述の「DMを作成」リンク（封筒アイコン）へのフック注入、および削除対象UI要素の非表示化は、いずれも `MutationObserver` でDOMの出現・再描画を監視して継続的に行う。

---

## 4. 画面 / UI フロー

拡張機能が提供するUIコンポーネントは3つ。これらを1つのモーダル/パネル内に縦に並べる。

### 4.1 UIコンポーネント

1. **相手解決欄**
   - screen_name（`@` なしのユーザー名）を入力するテキスト欄。
   - 「解決」ボタン。押すと `UserByScreenName`（GraphQL）を叩き、表示名・アイコン・`can_dm` の状態を表示する。
   - `can_dm: false` の場合は「この相手にはDMを送信できません」と明示し、送信ボタンを無効化する。
   - 解決に成功したら、相手の `rest_id`（数値ID）を内部状態に保持する。

2. **本文入力欄**
   - メッセージ本文を入力するテキストエリア。
   - **空文字では送信不可**（クライアント側でバリデーションする。詳細は第6章）。

3. **送信ボタン**
   - 押すと `dm/new2.json` を呼ぶ。
   - 成功したら `window.location.href = "https://x.com/messages/<conversation_id>"` で遷移する。
   - 失敗したらエラーメッセージをUI上に表示する（遷移しない）。

### 4.2 フロー（状態遷移）

```
[初期状態]
  screen_name未入力 / 相手未解決 → 送信ボタン無効

[相手解決]
  screen_name入力 → 「解決」押下
    → UserByScreenName呼び出し
      → 成功 & can_dm:true  → 相手情報表示・rest_id保持・本文入力可
      → 成功 & can_dm:false → 相手情報表示・「送信不可」表示・送信ボタン無効のまま
      → 失敗（該当ユーザーなし等） → エラー表示・rest_idクリア

[本文入力]
  本文が非空 & 相手解決済み & can_dm:true → 送信ボタン有効

[送信]
  送信ボタン押下
    → conversation_id を「自分ID」「相手ID」から生成（昇順ソート・ハイフン連結）
    → dm/new2.json をPOST
      → 200成功 → x.com/messages/<conversation_id> へ遷移
      → 4xx/5xx  → エラーメッセージをUIに表示（本文・入力は保持）
```

### 4.3 UI注入位置（UIを開く導線）

旧DM画面が封鎖されたため、**そこにあった「DMを作成」ボタン（封筒アイコン）にはもう到達できない。** 導線は以下に置き換える。

- **サイドバーの「メッセージ」タブ**（`[data-testid="AppTabBar_DirectMessage_Link"]`、現在の `href` は `/i/chat`）のクリックをキャプチャフェーズで奪い、ビューワのオーバーレイを開く。
- **新規作成はビューワのヘッダーにある `+` ボタン**から開く。作成モーダルをビューワの上に重ねて表示し、閉じるとビューワに戻る。
- 保険として、`a[href^="/messages"]` と `a[href^="/i/chat"]` に該当するリンクは**すべて**キャプチャフェーズでフックし、`preventDefault()` + `stopPropagation()` で遷移を止める。`/messages/compose` に該当するものは作成モーダルを、それ以外はビューワを開く。
- リンク要素はSPAの再描画で差し替わるため、`MutationObserver` で監視し、出現するたびにフックを貼り直す（フック済みかは `data-xoc-hooked` 属性で判定）。
- ブックマークや外部リンクから `/i/chat` に直接到達した場合は、`sessionStorage` にフラグを立てて `/home` へ `location.replace` し、遷移先でビューワを自動的に開く。**`/messages/conversations` へ戻してはならない**（X側が `/i/chat` へ差し戻すため無限リダイレクトループになる）。
- Escapeキーは content script 側で一元管理する。作成モーダルが開いていればそれだけを閉じ、閉じていればビューワを閉じる。

### 4.4 削除対象のUI要素（非表示化）

XのUI変更に対する互換性を優先し、**Chatへ誘導する危険な導線は「置き換え」ではなく「単純な非表示化（削除）」で無効化する。** 複雑な置き換えロジックより、単純に消す方が壊れにくいため。本拡張機能がこれらに対して行うのは非表示化のみで、クリックを奪って別機能に差し替えることはしない。

削除対象は次の2つ。

1. **ユーザープロフィールページの「メッセージ」ボタン**
   - ネイティブのDMボタン（DOM要素）。
   - `MutationObserver` で検出し次第、`display: none`（または要素の除去）で非表示化する。
   - 検出方法の指針: `data-testid` 属性（例: DMボタンに付与されるtestid）、`aria-label`、`href`/アイコン構造などを手がかりに特定する。実際の属性値は実DOMを確認して確定する。testidは将来変わりうるため、複数の手がかりで頑健に絞り込む。

2. **ツイート共有メニューの「チャット経由で送信」項目**
   - ツイートの共有メニュー（ドロップダウン）内の項目。
   - 共有メニューは開いたときに動的生成されるため、`MutationObserver` でメニュー出現を監視し、該当項目を検出次第 `display: none`（または要素の除去）で非表示化する。
   - 検出方法の指針: メニュー項目のテキスト（「チャット経由で送信」/ 英語UIの相当文言）、`href`（`/messages/compose` を含むもの）、`data-testid` などで特定する。文言はロケール依存のため、`href` に `/messages/compose` を含むリンク項目を消す方針を主軸にすると言語非依存で頑健。

3. **メッセージ一覧サイドバーの「チャット ベータ版」タブ**
   - `x.com/messages/*` 配下のメッセージ一覧サイドバー内、検索ボックスのすぐ下（会話一覧の直上）にあるタブ。「メッセージリクエスト」タブと並んで表示され、吹き出しアイコン＋「チャット」＋青い「ベータ版」バッジで構成される。
   - DOM上はタブ要素（`role="tab"` またはそれに類する要素）で、アクセシブルネームに「チャット」を含み、「ベータ版」というラベルが併記される。
   - 検出方法の指針: 既存の非表示化対象と同様、テキスト内容ベース（「チャット」「ベータ版」の文言）＋出現場所の文脈（メッセージサイドバー内、検索ボックス直下のヘッダー部分）で判定する。
   - `MutationObserver` で検出し次第、`display: none`（または要素の除去）で非表示化する。置き換えは行わない。

これらの非表示化ロジックは、モーダルを開くリンクフックとは独立したモジュールとして常時稼働させる（`MutationObserver` を全ページで走らせ、対象が現れたら消す）。

---

## 5. API仕様

実機検証で確定した仕様。以下をそのまま実装に用いてよい。

### 5.1 自分の数値ユーザーIDの取得

`document.cookie` の `twid` クッキーの値が `u%3D<数値ID>` 形式（URLデコードすると `u=<数値ID>`）で、ユーザー自身の数値IDを表す。

- 取得手順: `twid` の値をURLデコードし、先頭の `u=` を除去した残りが自分の数値ID（文字列）。
- 例: `twid` が `u%3D1154778638283235328` → 自分ID `1154778638283235328`。

### 5.2 相手のユーザー情報解決（screen_name → 数値ID・DM許可判定）

GraphQLエンドポイントを使う。

```
GET https://x.com/i/api/graphql/2qvSHpkWTMS9i0zJAwDNiA/UserByScreenName
    ?variables={"screen_name":"<対象のscreen_name>","withGrokTranslatedBio":true}
    &features={ ...機能フラグの巨大なJSON... }
```

- ヘッダーは第5.4節の送信エンドポイントと同様（`authorization` Bearer、`x-csrf-token`、`x-twitter-auth-type: OAuth2Session`、`x-twitter-active-user: yes`）。GETのため `content-type` は不要。`credentials: "include"`。
- `variables` と `features` はURLエンコードしてクエリ文字列に付与する。
- レスポンスの読み取り:
  - `data.user.result.rest_id` … 相手の数値ID（文字列）
  - `data.user.result.dm_permissions.can_dm` … 真偽値。DM送信可否。
- ユーザーが存在しない場合は `data.user` が空/欠落することがあるため、防御的に参照する。

#### features パラメータの例

`features` はXフロントエンドが要求する機能フラグの集合で、巨大なJSONオブジェクトである。実機で通った内容の例を以下に示す（キー構成はビルドにより増減しうる。過不足があると400になる場合があるため、動かない場合は実ブラウザのリクエストからコピーして更新する）。

```json
{
  "hidden_profile_subscriptions_enabled": true,
  "profile_label_improvements_pcf_label_in_post_enabled": true,
  "rweb_tipjar_consumption_enabled": true,
  "verified_phone_label_enabled": false,
  "subscriptions_verification_info_is_identity_verified_enabled": true,
  "subscriptions_verification_info_verified_since_enabled": true,
  "highlights_tweets_tab_ui_enabled": true,
  "responsive_web_twitter_article_notes_tab_enabled": true,
  "subscriptions_feature_can_gift_premium": true,
  "creator_subscriptions_tweet_preview_api_enabled": true,
  "responsive_web_graphql_skip_user_profile_image_extensions_enabled": false,
  "responsive_web_graphql_timeline_navigation_enabled": true
}
```

> 実装メモ: 上記はあくまで例。実運用では、後述の queryId 抽出と同様に、実ブラウザが送っている `features` の値をそのまま採用するのが最も安全。

### 5.3 会話ID（conversation_id）の形式

2者間の会話IDは「2つの数値ユーザーIDを、**10進数として昇順にソート**し、ハイフンで連結した文字列」。

- 例: `"1154778638283235328-1221784652936957952"`
- **10進数の数値としてソートすること**（文字列としての辞書順ではない。桁数が異なる場合に結果が変わるため、`BigInt` 比較を用いる）。
- **この会話が過去に一度も存在しなくても、この形式のIDを指定してメッセージ送信APIを叩けば、サーバー側で会話が自動的に新規作成される**（実機検証済み）。

実装上の生成ロジック（擬似）:
```
const a = BigInt(myId);
const b = BigInt(theirId);
const conversationId = a < b ? `${myId}-${theirId}` : `${theirId}-${myId}`;
```

### 5.4 メッセージ送信エンドポイント（本体）

```
POST https://x.com/i/api/1.1/dm/new2.json
    ?ext=mediaColor,altText,mediaStats,highlightedLabel,parodyCommentaryFanLabel,voiceInfo,birdwatchPivot,superFollowMetadata,unmentionInfo,editControl,article
    &include_ext_alt_text=true
    &include_ext_limited_action_results=true
    &include_reply_count=1
    &tweet_mode=extended
    &include_ext_views=true
    &include_groups=true
    &include_inbox_timelines=true
    &include_ext_media_color=true
    &supports_reactions=true
    &supports_edit=true
```

#### ヘッダー

- `authorization`:
  `Bearer AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA`
  （x.com Web版クライアント共通の固定Bearerトークン。**秘密情報ではなく全ユーザー共通の公開値**。ハードコードしてよい。）
- `x-csrf-token`: `document.cookie` の `ct0` クッキーの値
- `x-twitter-auth-type: OAuth2Session`
- `x-twitter-active-user: yes`
- `content-type: application/json`
- Cookieは `credentials: "include"`（同一オリジンのため自動送付。content scriptからのfetchなら特別な設定不要）

#### ボディ（JSON）

```json
{
  "conversation_id": "<自分ID>-<相手ID>（昇順ソート済み文字列）",
  "recipient_ids": true,
  "request_id": "<crypto.randomUUID()で生成したUUID>",
  "text": "<送信する本文。空文字は不可>",
  "cards_platform": "Web-12",
  "include_cards": 1,
  "include_quote_count": true,
  "dm_users": true
}
```

`recipient_ids` の選び方:

- 相手と面識が全くない・会話が存在しない場合は `true`。
- 既に会話が存在している場合は `false`。
- どちらも実機で成功確認済み。ただし `true` のまま既存会話に送っても動くかは未検証。
- **初版方針**: 実装を単純化するため、**常に `true` で統一する**設計とする。新規・既存を判別する手段を持たないため、常に `true` で送る。（両対応する場合は、事前に会話存在チェックを行い、存在すれば `false` に切り替える実装を追加すること。）

#### 本文空の制約（重要）

- `text` を空文字にすると、サーバーは `403` を返して拒否する:
  ```json
  {"errors":[{"code":151,"message":"There was an error sending your message: Your message cannot be blank.."}]}
  ```
- **本文なしで会話だけを作ることはできない。** よってUIは「本文入力必須」の制約を必ず伴う。クライアント側でも空文字送信をブロックする。

#### 成功時レスポンス例

```json
{
  "entries": [{
    "message": {
      "id": "<新規メッセージID>",
      "time": "<epoch ms文字列>",
      "affects_sort": true,
      "request_id": "<送信時のrequest_id>",
      "conversation_id": "<会話ID>",
      "message_data": {
        "id": "...", "time": "...", "recipient_id": "...", "sender_id": "...", "text": "..."
      }
    }
  }],
  "users": { "<自分ID>": {...}, "<相手ID>": {...} }
}
```

- 成功判定は、HTTPステータス `200` かつ `entries` に少なくとも1件の `message` が含まれることを条件とする。

### 5.5 送信成功後の挙動

- **画面遷移は行わない。** 旧DM画面は封鎖されており、`https://x.com/messages/<conversation_id>` へ遷移させるとXChatのパスコード設定画面に連れて行かれる（2026-08-05に確認。この設計書の旧版はここで遷移させていたが、現在は危険な操作である）。
- 送信成功後は、拡張機能のビューワ内で当該スレッドを再取得して表示を更新する。作成モーダルからの新規送信の場合は、モーダルを閉じてビューワで該当スレッドを開く。
- 失敗時は遷移も更新も行わず、入力内容を保持したままエラーを表示する。

### 5.6 受信のリアルタイム追従（Live Pipeline / SSE）

公式Xの旧DMもこれで受信していた。ポーリングではなくサーバーからのプッシュ配信である。2026-08-05に実機で疎通を確認済み。

- **接続**: `GET https://api.x.com/live_pipeline/events?topic=<トピック>`。認証はDM APIと同じ（公開Bearer + `x-csrf-token: <ct0>` + Cookie）。レスポンスは改行区切りのJSONストリーム。
- **トピック**: `/dm_update/<conversation_id>`。複数購読する場合はカンマ区切り。入力中表示は `/dm_typing/<conversation_id>`（本拡張では未使用）。
- **接続直後**に `/system/config` が届き `session_id` / `subscription_ttl_millis`（120000）/ `heartbeat_millis`（25000）を通知する。続いて `/system/subscriptions` で購読結果が返る。
- **購読の更新**: TTLが120秒しかないため、`POST /1.1/live_pipeline/update_subscriptions`（`livepipeline-session` ヘッダに `session_id`、body に `sub_topics` / `unsub_topics`）を**45秒間隔**で呼び続ける。
- **トピックは認可される**: 自分が参加していない会話IDや存在しないトピック名は `code: 32, "Unauthorized"` で拒否される。購読成功はサーバーの寛容さではなく正当な成立を意味する。
- **イベントに本文は含まれない**。ペイロードは `{"dm_update":{"conversation_id":"...","user_id":"..."}}` のみで、「この会話に更新があった」という通知に過ぎない。**受信後に `dm/conversation/<id>.json` で再取得する必要がある。**
- **接続は切れる。再接続が必須。** 実測で約13分後に `TypeError: network error` で切断された。このとき `update_subscriptions` は成功し続けていたため、**購読の成否と接続の生死は別物**である。監視すべきは後者。
- **ハートビートは空行**として送られる（JSON行ではない）。したがって「一定時間何も受信しない」ことを死活判定に使う。本実装では60秒無音でabortし、2秒後に再接続する。

### 5.7 絶対にやってはいけないこと（強い警告）

以下は Chat への不可逆な移行を招くため、拡張機能は絶対にトリガーしてはならない。

- **`/messages` 配下および `/i/chat` 配下への遷移を一切行わない**（`location.assign` / `location.href` 代入 / リンクのデフォルト遷移のすべて）。`/messages/conversations` すら `/i/chat/pin/new` まで自動で連れて行かれる。唯一の例外は `/i/chat` に迷い込んだ際の `/home` への離脱。
- プロフィールページの「メッセージ」ボタン（ネイティブのDOM要素）をプログラム的にクリックさせない。
- ツイート共有メニューの「チャット経由で送信」を使わない。
- 上記いずれかの結果として「新しいXチャットへようこそ」画面が表示されても、**「パスコードを作成」ボタンは絶対に押さない・自動化しない**。
- 拡張機能はこの一連の危険な導線を完全に迂回し、**旧REST DM APIへの直接fetchのみで閲覧・送信を完結させる**設計でなければならない。UIは自前のオーバーレイで提供し、XのSPAルーターには一切触れない。

---

## 6. エラーハンドリング方針

| 事象 | 検知方法 | UIの挙動 |
|---|---|---|
| `can_dm: false` | `UserByScreenName` レスポンスの `dm_permissions.can_dm` | 「この相手にはDMを送信できません」と表示し、送信ボタンを無効化 |
| screen_name該当ユーザーなし | `data.user` が空/欠落 | 「ユーザーが見つかりません」と表示し、rest_idをクリア |
| 本文が空 | 送信前のクライアント側バリデーション（trim後に長さ0） | 送信ボタンを無効化。誤って送られてもAPI呼び出し前に中断 |
| 本文空で403（code 151） | HTTP 403 かつ `errors[].code === 151` | 「メッセージ本文を入力してください」と表示（本来クライアント側で防ぐ） |
| CSRF不正・認証切れ | HTTP 401/403（code 151以外） | 「認証エラー。x.comに再ログインしてください」と表示 |
| レート制限超過 | `x-rate-limit-remaining` が0、または HTTP 429 | 「送信回数の上限に達しました。しばらく待って再試行してください」と表示。`x-rate-limit-reset`（epoch秒）があれば解除予定時刻を併記 |
| その他4xx/5xx | 上記以外のエラーステータス | レスポンスの `errors[].message` があればそれを、なければ汎用エラーメッセージを表示 |
| ネットワーク失敗 | fetchのreject | 「通信に失敗しました。再試行してください」と表示 |

方針:

- 送信APIのレスポンスヘッダー `x-rate-limit-limit` / `x-rate-limit-remaining` / `x-rate-limit-reset` を読み取り、`remaining` が少ない場合はUIに残回数を表示してユーザーに注意喚起してもよい。
- いかなるエラーでも、**エラー時は画面遷移を行わない**。入力内容（screen_name・本文）は保持し、再送信できるようにする。
- 送信中は送信ボタンを二重押下できないよう無効化する（多重送信・重複request_id防止）。

---

## 7. 既知のリスク・限界

- **GraphQL queryId の不安定性**: `UserByScreenName` のクエリID `2qvSHpkWTMS9i0zJAwDNiA` は、**Xフロントエンドのビルドごとに変わりうる不安定な値**であり、将来動かなくなる可能性がある。
  - 対策1（自動抽出）: 拡張機能起動時に、x.comが読み込み済みのJSバンドル（`<script>` タグの `src`、またはロード済みJSテキスト）を走査し、`"UserByScreenName"` の直前に現れるqueryId文字列を正規表現で動的抽出する運用を推奨する。抽出できた場合はハードコード値より優先する。
  - 対策2（手動更新）: 抽出に失敗した場合のフォールバックとして、ハードコードしたqueryIdを使う。動かなくなった際は、実ブラウザのDevToolsのネットワークタブから最新のqueryIdを確認し、手動で更新する運用とする（`storage` に保存する設計にすれば再ビルド不要）。
- **`features` パラメータの変動**: `UserByScreenName` の `features` フラグ集合もビルドで増減する。過不足があると400になりうる。動かない場合は実ブラウザのリクエストからコピーして更新する。
- **`dm/new2.json` 自体が塞がれる可能性**: Xがサーバー側でこの旧RESTエンドポイントを廃止・遮断すれば、本拡張機能は機能しなくなる。これは根本的な限界であり、回避策はない。
- **XのToS上のグレーさ**: 本拡張機能はX公式が想定しない内部API（private API）を利用する。XのTermsに照らしてグレーな利用であり、アカウントに対する何らかの制限リスクを完全には排除できない。利用は自己責任。
- **レート制限**: `dm/new2.json` にはレート制限がある。短時間の大量送信はブロックされうる。本拡張機能は自動大量送信を目的とせず、手動での1通ずつの送信を前提とする。
- **固定Bearerトークンの失効**: ハードコードするBearerトークンはWeb版共通の公開値だが、Xがローテーションすれば更新が必要になる。queryId同様、動かなくなった際の手動更新対象。

---

## 8. ディレクトリ構成案

Plasmoの標準的なプロジェクト構成に従う。`contents/` 配下のファイルはPlasmoが自動的にcontent scriptとしてバンドルする。既存プロジェクト `persister` と同じ `pnpm` + Plasmo + TypeScript構成。

```
x-old-chat/
├── DESIGN.md                 本設計書
├── package.json              pnpm + Plasmo設定。scriptsに "dev": "plasmo dev", "build": "plasmo build"。dependenciesに "plasmo"
├── tsconfig.json             Plasmo標準のTypeScript設定（Plasmoが生成するものを踏襲）
├── .prettierrc.mjs           整形設定（persisterに合わせる。任意）
├── assets/
│   └── icon.png              拡張機能アイコン（Plasmoが各サイズを生成）
├── components/
│   ├── DmViewer.tsx          会話一覧＋スレッド＋返信欄の2ペインオーバーレイ
│   ├── DmComposer.tsx        新規送信モーダル（宛先解決＋本文送信）
│   └── ui/                   shadcn/ui流の素のReactコンポーネント（Radix不使用）
│                             alert/ avatar/ button/ input/ label/ textarea/
├── contents/
│   ├── dm-modal.tsx          content scriptエントリ（CSUI）。PlasmoCSConfigのmatchesにx.com/*。
│   │                         DM導線リンクのクリックフック・ビューワ/モーダルの表示制御・Escape管理
│   └── hide-chat-entrypoints.ts  content scriptエントリ。Chatへの危険な導線をMutationObserverで
│                                 非表示化し、/i/chat に迷い込んだ際は /home へ離脱させる
├── lib/
│   ├── api.ts                送信・ユーザー解決層（UserByScreenName / dm/new2.json）＋共通ヘッダ・エラー整形
│   ├── dm.ts                 閲覧層（inbox_initial_state.json / conversation/<id>.json）とDM型定義
│   ├── livePipeline.ts       Live PipelineのSSE購読（再接続・購読更新・無音検知を内包）
│   ├── ids.ts                twidから自分ID取得・conversation_id生成（BigInt昇順ソート）
│   ├── cookies.ts            document.cookieからct0/twidを読むユーティリティ
│   ├── queryId.ts            ロード済みJSからUserByScreenNameのqueryIdを動的抽出
│   ├── utils.ts              cn()（clsx + tailwind-merge）
│   └── constants.ts          Bearerトークン・エンドポイントURL・DMクエリ・featuresフラグ・パス定数
└── styles/
    └── globals.css           Tailwind + CSS変数。`getStyle` でshadow DOMへ注入（必須部品）
```

補足:

- `package.json` の要点:
  - `"dependencies"` に `"plasmo"`。`"devDependencies"` に `"typescript"`、`@types` 類。
  - `"scripts"`: `"dev": "plasmo dev"`, `"build": "plasmo build"`, `"package": "plasmo package"`。
  - `"manifest"` フィールドでMV3の追加設定（`permissions` 等）を宣言できる。`storage` はqueryId保存を行う場合のみ追加。
- content scriptのマッチ・実行タイミングは各 `contents/*.ts` の `export const config: PlasmoCSConfig = { matches: ["https://x.com/*"], run_at: "document_idle" }` で宣言する。
- `contents/dm-modal.ts`（モーダル導線）と `contents/hide-chat-entrypoints.ts`（危険導線の非表示化）は責務が独立するため、別々のcontent scriptに分ける。両者とも共通ロジックは `lib/` から取り込む。
- ローカル動作確認は `pnpm dev` でビルドし、生成される `build/chrome-mv3-dev` を Chrome の「パッケージ化されていない拡張機能を読み込む」で読み込む。
- Bearerトークン・featuresフラグ・queryIdフォールバックは `lib/constants.ts` に集約し、動かなくなった際の更新箇所を1ファイルに閉じ込める。

---

## 9. 実装時の受け入れ基準（テスト観点）

以下をすべて満たすこと。テストは実機（ログイン済みx.com）で手動確認する。

1. **未接触の相手への新規送信**: 過去に一度も会話したことがない相手のscreen_nameを解決し、本文を入力して送信 → 200成功し、ビューワ内に当該スレッドが表示される。**この間にページ遷移が一切発生せず、「新しいXチャットへようこそ」画面やパスコード作成画面も表示されないこと。**
2. **既存会話への送信**: 既に会話がある相手へ送信 → 成功し、同スレッドに追記されて表示が更新される。
2a. **会話一覧の表示**: ビューワを開くと会話が新しい順に並び、相手のアバター・表示名・直近メッセージ・日時・未読インジケータが表示されること。
2b. **スレッドの表示**: 会話を選ぶと履歴が古い順に並び、自分と相手の発言が左右に分かれ、最下部までスクロールされていること。t.co短縮URLが展開表示され、絵文字リアクションが表示されること。
2c. **過去への遡及**: `status` が `AT_END` でないスレッドで「以前のメッセージを読み込む」を押すと、`max_id` により過去のメッセージが先頭に追加されること。
2d. **リアルタイム受信**: スレッドを開いたまま相手からメッセージが届くと、リロードも再選択もせずに末尾へ追加され、最下部までスクロールされること。会話を切り替えると前のスレッドの購読が解除され、新しいスレッドが購読されること。
3. **can_dm: false の拒否**: DMを受け付けない相手を解決したとき、「送信不可」が明示され、送信ボタンが無効化されて送信できないこと。
4. **本文空のクライアント側バリデーション**: 本文が空（または空白のみ）のとき送信ボタンが無効で、API呼び出しが発生しないこと。
5. **本文空のサーバー側403の扱い**: （バリデーションを迂回した場合でも）403 code 151 を受けたら適切なエラー表示がされ、遷移しないこと。
6. **送信成功後の挙動**: 成功時のみスレッドが更新され、失敗時は更新されず入力が保持されること。いずれの場合もページ遷移が起きないこと。
7. **危険な導線を一切踏まないこと**: `/messages` 配下・`/i/chat` 配下への遷移、ネイティブ「メッセージ」ボタンのクリック、「チャット経由で送信」、パスコード作成が、拡張機能の全フローを通じて一度も発生しないこと。DM導線リンクのデフォルト遷移がキャプチャフェーズで確実に抑止されていること。
8. **conversation_id生成の正しさ**: 桁数の異なる2つのIDでも、10進数として昇順ソートされた正しい会話IDが生成されること（BigInt比較）。
9. **自分ID取得**: `twid` クッキーから正しく自分の数値IDが取得できること。
10. **queryId動的抽出のフォールバック**: 抽出成功時は抽出値を使い、抽出失敗時はハードコード値にフォールバックして動作すること。
11. **多重送信防止**: 送信中は送信ボタンが無効化され、二重送信が起きないこと。
12. **レート制限表示**: レート制限に達した場合、ユーザーに分かるエラー/残回数が表示されること。
13. **プロフィールのメッセージボタン非表示**: ユーザープロフィールページを開いたとき、ネイティブの「メッセージ」ボタンが表示されないこと（`MutationObserver` により、ページ遷移やDOM再描画後も表示されないこと）。
14. **共有メニューの項目非表示**: ツイートの共有メニューを開いたとき、「チャット経由で送信」項目が表示されないこと。
15. **「チャット ベータ版」タブ非表示**: `a[role="tab"][href^="/i/chat"]` に該当するタブが表示されないこと（他の要素には影響しないこと）。
16. **UI導線**: サイドバーの「メッセージ(OLD)」クリックでビューワが開き、ページ遷移が発生しないこと。ビューワヘッダーの `+` ボタンで作成モーダルがビューワの上に重なって開き、閉じるとビューワに戻ること。
17. **`/i/chat` からの離脱**: ブックマーク等で `/i/chat` に直接アクセスした場合、`/home` へ離脱してビューワが自動的に開くこと。**無限リダイレクトループが発生しないこと**、XChatのパスコード画面が表示されないこと。
18. **Escapeキーの階層**: 作成モーダルが開いている状態でEscapeを押すとモーダルだけが閉じてビューワが残り、もう一度押すとビューワが閉じること。
