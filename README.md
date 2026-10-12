# ソングリスト

スマートフォンにも対応した、歌う曲とキーを管理するWebアプリです。初期データには添付CSVの有効な617曲（154組のアーティスト）を登録しています。CSVにある最終歌唱日、キー、移調値、曲調、備考と補助情報も引き継ぎます。

## できること

- 曲名・アーティスト名で検索
- アーティスト名と曲名の読み仮名順、最後に歌った日順で並べ替え
- 原曲キーから半音単位で移調し、歌うキーと平行調を表示
- 最後に歌った日の記録、備考、一覧表示の切り替え
- ログインしたユーザーが自分専用の曲リストを編集し、CSVを取り込み・書き出し
- Googleで「アーティスト名 曲名 Chordwiki」を検索
- 検索条件つきの共有URLをコピー
- GitHub上のJSONを公開データとして読み込み、編集結果をGitHubへ保存

## GitHub PagesとSupabaseの初回設定

アプリのファイル一式を専用のGitHubリポジトリのルートに置きます（`index.html`、`app.js`、`styles.css`、`config.js`、`data/`、`supabase/`）。GitHub Pagesをそのリポジトリの `main` ブランチ・ルートから公開してください。初期の曲一覧は `data/songs.json` にあります。

### 1. Supabaseでアカウントと個人リストを用意する

1. Supabaseプロジェクトを作成し、Authenticationのメール登録を有効にします。
2. `Project URL` と公開用の `anon` / `publishable` keyを控えます。Secret keyやservice-role keyはブラウザーへ置かないでください。
3. SupabaseのSQL Editorで [`20261012000000_user_song_lists.sql`](20261012000000_user_song_lists.sql) の内容を実行します。このテーブルはログイン中の本人だけが読み書きできるRLSポリシーを持ちます。
4. デプロイしたアプリで「ログイン」→「新規登録」を行い、ユーザー名・メールアドレス・パスワードを登録します。確認メールが届く設定ならメール内のリンクを開きます。
5. SupabaseのAuthentication → Usersから、現在のオーナーアカウントのUUIDを確認します。
6. `config.js` の `supabaseUrl`、`supabaseAnonKey`、`adminUserId`を設定してGitHubへ反映します。

ログインなしではGitHub上の公開リストを閲覧・検索できます。ログインするとユーザーごとの個人リストを読み込み、追加・編集・削除・CSV入出力ができます。未登録ユーザーは空のリストから始まります。既存データは `adminUserId` のオーナーが初めてログインしたときに、そのユーザーの個人リストへ一度だけ引き継がれます。オーナーが編集した公開用一覧は従来どおりGitHubにも同期されます。

```js
window.SONGLIST_CONFIG = {
  supabaseUrl: "https://YOUR_PROJECT.supabase.co",
  supabaseAnonKey: "YOUR_PUBLIC_ANON_OR_PUBLISHABLE_KEY",
  adminUserId: "YOUR_OWNER_USER_UUID",
  songsDataUrl: "https://raw.githubusercontent.com/YOUR_OWNER/YOUR_REPOSITORY/main/data/songs.json",
  githubSyncReady: true,
  syncFunctionName: "songlist-github-sync"
};
```

`githubSyncReady` は、Edge FunctionのデプロイとSecrets設定が完了した後に `true` にしてください。

### 2. オーナーの公開一覧をGitHubへ同期する

編集時の保存はSupabase Edge FunctionがGitHub Contents APIを呼び出して行います。GitHubトークンはブラウザーへ出さず、SupabaseのFunction Secretにだけ登録します。

1. 対象リポジトリだけにContentsの読み書きを許可したGitHub fine-grained tokenを作ります。
2. Supabase CLIでこのフォルダーをプロジェクトとしてリンクし、以下のFunction secretsを登録します。

```sh
supabase link --project-ref YOUR_PROJECT_REF
supabase secrets set \
  GITHUB_TOKEN=YOUR_FINE_GRAINED_TOKEN \
  GITHUB_REPOSITORY=YOUR_OWNER/YOUR_REPOSITORY \
  GITHUB_BRANCH=main \
  GITHUB_FILE_PATH=data/songs.json \
  SONGLIST_ADMIN_UID=YOUR_OWNER_USER_UUID
supabase functions deploy songlist-github-sync
```

SupabaseがFunctionへ提供する `SUPABASE_URL` と `SUPABASE_ANON_KEY` を使ってセッションを確認します。FunctionはセッションのユーザーUUIDが `SONGLIST_ADMIN_UID` と一致する場合だけGitHubのファイルを更新します。公開キーやUUIDを見ただけでは更新できません。

### 3. GitHub Pagesの公開データURLを合わせる

`config.js` の `songsDataUrl` は、上の例のように `data/songs.json` のGitHub Raw URLにします。これにより、Pagesの公開リストはGitHubに保存された最新データを読み込みます。Raw URLはリポジトリをPublicにしている場合に公開閲覧できます。

## CSV

- 「CSVを書き出す」は全曲と補助情報をUTF-8 CSVで保存します。
- 「CSVを取り込む」はこのアプリのCSV形式と、添付の「ソングリスト - リスト.csv」形式の両方を読み取ります。
- 「追加・更新する」はアーティスト名と曲名が一致した曲を更新します。「すべて置き換える」は現在の全曲を置き換えます。
- 最初のデータ変換では、アーティストと曲名が空の行や数式エラーを除き、617件を登録しています。元CSVには読み仮名全体がないため、既存データは元表の頭文字や補完できた先頭文字だけの場合があります。曲を編集して読み仮名を入力すると、その読みで一覧を並べ替えます。新しい曲を追加するときはアーティスト名と曲名の読み仮名も入力してください。
- 移調値が「-12 or -5」と記録されていた1曲は、初期値に先頭の「-12」を選び、元の表記全体は補助データに保存しています。

## データの分離

- 個人リストはSupabaseの `song_lists` に保存し、RLSで本人のアカウント以外から読み書きできないようにします。
- `adminUserId` のオーナーだけがEdge Functionを通じて公開用の `data/songs.json` も更新できます。一般ユーザーの編集はGitHubへ送信しません。
- 公開用JSONはGitHub Pagesから誰でも取得できるデータです。公開リストに含めた曲情報は公開されるものとして扱ってください。

## ローカルで表示する

`index.html`を直接開くと、同梱した初期曲一覧を使って閲覧・検索・ソートできます。Supabase認証とGitHub同期を使う場合は、GitHub PagesなどのWebサーバーに配置してください。アプリ本体にNode.jsなどのビルド手順はありません。
