# persona-engine v2 SPEC

> Status: **REVIEWED**（クロスモデル2系統通過: glm-panel 4レンズ + Fugu Ultra 3ラウンド最終 SHIP, 2026-07-10）。main へのマージをもって **FROZEN**。以後の変更は Issue + 再レビュー必須
> 改訂: 2026-07-12 — オーナー承認済み決裁 #57（§6.1 route id 制約: [a-z0-9-]+ 必須・予約名（__default__/__admin__ 等 __ 前置全般）禁止 / §4.1 E_ROUTE_ID_INVALID 追加）を反映
> 改訂: 2026-07-12 — オーナー承認済み決裁 #49（§4 build/*.json regular-file ガード）/ #53（§2.4/§3 alias 文字列への placeholder 置換）を反映
> 改訂: 2026-07-11 — オーナー承認済み決裁 #40（§4 policy.json 形状明記）/ #42（§7.3 ロック機構 O_EXCL 化）/ #43（§4.1 `E_PARSE` 追加・§4 `engine_range` 搬送）を反映
> 正本度: 本書が実装の単一正。設計背景・実機スパイク記録は内部設計文書（非公開）に別置
> 対象 Issue: #18（M0）。実装: #19-#22（M1）、#33/#24/#25（M2）、#23/#26-#28（M3）

本書の規範語: **MUST / MUST NOT / SHOULD / MAY**（RFC 2119 準拠の意で用いる）。

---

## 0. 不変条件（違反 = 実装バグ）

1. `public` = **空センチネル**。注入バイト数 0。ベース人格（SOUL.md 等）はエンジン管轄外
2. 未知・未解決の route は **fail-closed**: `public` 固定・切替不可
3. すべての切替（明示トリガー / エージェント自発 / CLI / 将来の UI）は **コアの policy 評価を必ず通過**する。拒否は「却下」であり別モードへの「丸め」ではない
4. ランタイム（turn パス）は YAML を **一切パースしない**。読むのは `build/` のコンパイル済み成果物と `state/` のみ
5. 状態は注入を行うホストに置く。マシン間 state 同期はしない
6. 注入ブロックは **モード不変のあいだバイト同一**（prompt cache を壊さない）
7. **不透明ペイロード原則**: エンジン・アダプタ・本 SPEC はモード/カタログの**内容**を解釈しない。扱うのは封筒（スキーマ・予算・参照・順序）のみ
8. アダプタのホストランタイム（OpenClaw / Hermes）は hook/middleware 失敗を **fail-open** で扱う（両 spike で確証）。よって **fail-closed はエンジン側で内製**する: アダプタ callback は全体を例外捕捉し、異常時は「無注入 + 監査記録」に落とす。ホストの安全機構に依存してはならない

---

## 1. 用語

| 用語 | 意味 |
|---|---|
| pack | 配布可能な人格差分一式（`pack/`）。「どんな人格か」 |
| install | 受け入れ側の設定と成果物（`~/.persona-engine/<agent>/`）。「どのサーフェスで何を許すか」 |
| mode | 切替単位。`public` は予約モード（空注入）で全 pack に暗黙に存在する |
| route | 受信メッセージの出所クラス。install の `routes` で宣言 |
| route ctx | アダプタが trusted runtime context から導出する route 判定入力（§6.2）。**モデル出力・メッセージ本文から作ってはならない** |
| state_domain | モード状態の共有単位。route → domain は多対一 |
| block | モードごとのコンパイル済み注入テキスト（`build/modes/<mode>.md`） |
| actor | 操作主体: `owner` / `agent` / `admin`(CLI) / `unknown` |

## 2. Pack schema v2（`pack/`）

```
pack/
├── manifest.yml        # 必須
├── modes/<mode>.yml    # 1ファイル=1モード。ファイル名 stem = mode id
├── aliases.yml         # 明示切替の全文一致エイリアス
└── catalogs/**         # 不透明な著者資産（任意の形式・エンジンは参照解決のみ）
```

### 2.1 manifest.yml

```yaml
schema_version: 2            # 必須。int。本 SPEC は 2 のみ定義
pack_version: "2.0.0"        # 必須。semver 文字列
name: sample-persona         # 必須。[a-z0-9-]+
engine:
  min: "0.1.0"               # 必須。対応エンジン範囲（semver）
  max: null                  # 任意。null = 上限なし
default_budget_tokens: 600   # 任意。グローバル注入予算の既定
```

- `schema_version != 2` → build error `E_SCHEMA_VERSION`
- mode id `public` を `modes/` に置くことは**禁止**（暗黙予約）→ `E_RESERVED_MODE`

### 2.2 modes/<mode>.yml（封筒スキーマ）

```yaml
extends: <mode-id>           # 任意。単一継承
budget_tokens: 400           # 任意。このモードの宣言予算（既定は manifest の値）
voice_hint: <string>         # 任意。read-only メタ（M3 #28 用。注入されない）
sections:                    # 注入本文（不透明）。順序付きリスト
  - id: tone                 # 必須。[a-z0-9_-]+。継承マージのキー
    text: |                  # 不透明テキスト。エンジンは解釈しない
      ...
catalog_refs:                # 任意。ビルド時にカタログ抜粋を section 化
  - path: catalogs/<file>    # pack 相対。正規化解決後に pack/catalogs/ 配下で
                             # なければ E_CATALOG_REF（`..`・絶対パス・symlink 脱出を拒否）。
                             # 存在しない場合も E_CATALOG_REF
    id: <section-id>         # 展開先 section id（衝突は通常 sections と同規則）
    priority: 10             # 小さいほど先頭。同値は path 昇順（決定論）
```

- mode id = ファイル名 stem。`[a-z0-9-]+` 以外 → `E_MODE_ID`
- `sections[].text` と catalog 抜粋の**内容**にエンジンは踏み込まない（不変条件7）。検証は UTF-8 妥当性とトークン数のみ
- **規範（内容非検証）**: private 用途のモードは「共有メモリ/長期記憶へこのモードの内容を記録しない」規範文を著者が section として含める**べき**（SHOULD）。エンジンは検証できない。`doctor` は install 設定から記憶共有の警告のみ行う（§9）

### 2.3 継承マージ規則（`extends`）

コンパイラは mode を親→子の順に解決してから placeholder 適用・予算検証を行う。

| 型 | 規則 |
|---|---|
| scalar（`budget_tokens`, `voice_hint` 等） | 子が置換 |
| map | 深いマージ（子キー優先、再帰） |
| `sections`（順序付き id リスト） | **id 単位の add / remove / replace**（下記） |
| `catalog_refs` | 同上（キーは `id`） |

`sections` の子側表現:

```yaml
sections:
  - id: tone            # 親に同 id あり → text を置換（位置は親の位置を維持）
    text: ...
  - id: extra           # 親に無い id → 末尾に追加
    text: ...
  - id: boundaries
    remove: true        # 親から削除
```

- 継承チェーン: 循環 → `E_EXTENDS_CYCLE`、未定義親 → `E_EXTENDS_UNKNOWN`、深さ > 8 → `E_EXTENDS_DEPTH`
- `remove: true` と `text` の同時指定 → `E_SECTION_CONFLICT`。存在しない id への `remove` → `E_SECTION_UNKNOWN`（typo 検出）。同一ファイル内の id 重複（catalog_refs の展開先含む）→ `E_SECTION_DUP`

**ブロック描画の決定論（golden fixtures の前提）**:

1. 解決順序: 親の sections 順を保持し、子の新規 id は子ファイル内の出現順で末尾に追加（replace は親の位置を維持 — 上記）
2. `catalog_refs` は `(priority 昇順, path 昇順)` で並べ、**通常 sections の後**に section として追加
3. `path` は UTF-8 テキストファイルを指し、**ファイル全体**が section text になる。エンジンはファイル内抜粋を行わない（抜粋は著者がファイル分割で表現する — 不透明原則の帰結）
4. 最終ブロック = `<persona-mode …>` ヘッダ + 各 section text を `\n\n` で連結 + 終了タグ（§5 の正規形適用後）。section id はブロックに出力しない

### 2.4 aliases.yml（明示切替トリガー）

```yaml
aliases:
  sweet-gf:
    - "あまあまモード"
    - "switch to sweet"
  public:
    - "仕事モードに戻って"
```

- **発話全体一致のみ**（正規化後）。部分一致・正規表現は**禁止**（設計確定事項: 誤爆排除）
- build 時、各 alias 文字列にも install.yml の `placeholders` による `{{key}}` 置換を適用する。未解決の `{{key}}` が残る → `E_PLACEHOLDER_UNRESOLVED`
- alias の処理順序は **placeholder 置換 → normalization v1 → 衝突・予約名検査**（この順序を MUST）とする。`triggers.json` には置換・正規化済み alias を焼き込み、ランタイムでの置換は行わない
- alias は置換前から空文字列である場合、または placeholder 置換と normalization v1 の後に空文字列となる場合、`E_PARSE` として build を拒否する
- 予約コマンド `/persona <mode-id>` は全 install で常に有効（pack 定義不要）。置換後の alias が normalization v1 後に `/persona` で始まる → `E_ALIAS_RESERVED`
- 置換後の alias の正規化衝突（2モードが同一正規形を持つ / 同一モード内重複）→ `E_ALIAS_COLLISION`
- 未定義モードへの alias → `E_ALIAS_UNKNOWN_MODE`

**発話正規化（normalization v1）** — triggers.json に `normalization: 1` として焼き込み、アダプタ/コアは同一実装を使う:

1. Unicode NFKC
2. 前後空白 trim、連続空白（タブ・全角空白含む）を半角スペース1個に縮約
3. ASCII 範囲のみ小文字化（非 ASCII の case-fold はしない）
4. それ以外の変形（句読点除去等)は**しない**（過剰正規化は誤爆側に倒れるため）

## 3. Install schema（`~/.persona-engine/<agent>/install.yml`）

pack と分離する（配布物が受け入れ先のポリシーを決めてはならない）。

```yaml
schema_version: 2
pack: /path/to/pack          # or git URL（取得は CLI の責務。build は解決済みローカスのみ見る）
placeholders:                # ビルド時にブロック内と alias 文字列内の {{key}} を置換
  agent_name: アシスタント
  owner_name: オーナー
budget_tokens: 600           # 任意。pack 既定を上書きする最終予算
runtime: hermes              # openclaw | hermes | claude-code | generic(CLI駆動)
routes: [...]                # §6.1
audit:
  dir: audit/                # install 相対のみ。絶対パス・`..` を含む → E_AUDIT_DIR
```

- ブロック中または alias 文字列中の `{{key}}` が placeholders に無い → `E_PLACEHOLDER_UNRESOLVED`（**黙って残さない**。エラーメッセージは発生箇所が alias であるかを識別可能にする）
- placeholders に**秘匿値を置くことを禁止**（README/SECURITY に明記。ブロックは平文で `build/` に出る）。`doctor` は build 成果物を一般的な secret パターン（API key 形状等）で走査し**警告**する（§9。完全検出は不可能 — 責務は operator）
- **YAML の読み込みは build/CLI 時のみ・safe loader 固定**（任意オブジェクト実体化を許すローダの使用禁止。未知タグ → build error）。pack は v2 では trusted-operator 前提の資産であり、第三者 pack の受け入れゲート（scan・provenance）は M4 OSS リリースゲートで定義する

## 4. Build 成果物（`build/`）— ランタイムが読む唯一の形式

`persona build` は pack + install.yml から以下を生成する。**すべて JSON / md**（不変条件4）。

```
build/
├── manifest.json    # {schema_version, pack_name, pack_version, engine_version,
│                    #  engine_range: {min, max},  ← pack 宣言の対応範囲を搬送（#43。
│                    #    max は null 可（上限なし — §2.1 と同義）。
│                    #    build は自 engineVersion が範囲外なら error — §4.1 注記）
│                    #  built_at, content_hash, counter: "pe-count-v1",
│                    #  modes: {<id>: {bytes, tokens, sha256, voice_hint?}}}
├── modes/<id>.md    # モードごとの完成ブロック（正規形・§5）。public は生成しない
├── triggers.json    # {normalization: 1, reserved_prefix: "/persona",
│                    #  aliases: {"<正規化発話>": "<mode-id>", ...}}
└── policy.json      # {routes: [...], domains: [...], modes: [<id>...],
                     #  default_route: {state_domain}, audit_dir}（§6 の全評価入力 +
                     #  §8 の audit_dir 焼き込み。#40）
```

- `content_hash` の正規形: 入力ファイル群を「pack 相対パス昇順、各エントリ = `<path>\0<UTF-8 バイト列（LF 正規化なし・バイトそのまま）>\0`」で連結した sha256。OS・YAML ライブラリ差で揺れない（バイト定義のため）。アダプタ/turn は起動時に `manifest.json` の `schema_version`・engine 互換を検証し、不一致は **無注入 + 監査**（fail-closed。§8）
- ランタイムが `build/manifest.json`・`build/policy.json`・`build/triggers.json` を読む際は、`build/modes/*.md` と同じく symlink を追跡しない方法（`O_NOFOLLOW` または同等機構）で open し、open 後の fd を `fstat` して通常ファイルであることを検証する。**包含する `build/` ディレクトリ自体にも同じ要件を適用**する: symlink を追跡せずに open（`O_DIRECTORY|O_NOFOLLOW` 相当）し、leaf open の前後でディレクトリの dev/ino 同一性を検証する（ディレクトリ差し替えによる TOCTOU を含めて封じる — leaf のみのガードは `build/` 全体の symlink 置換で迂回可能なため）。違反は F3 `build_invalid` として監査し、**無注入・切替不可**（§8）
  - **受容された限界**（#49 決裁）: TypeScript の leaf file open は絶対パス文字列を再解決するため、`open()` syscall 前後に不可避の狭い ABA 窓が残る（Node に `openat` 相当がないため）。leaf と包含する `build/` ディレクトリの dev/ino を open 前後で比較して差し替えを検出し、相違があれば F3 `build_invalid` として fail-closed する。この窓を検出的にではなく構造的に閉じるには `openat` 相当の primitive を備えるランタイムが必要であり、Python 実装は `dir_fd` anchored open によりこれを満たす
- **ビルドは all-or-nothing**: 1 つでも error があれば `build/` を更新しない（tmp dir → rename の原子的置換）

### 4.1 build error 一覧（すべて exit≠0・`build/` 非更新）

`E_PARSE` `E_SCHEMA_VERSION` `E_RESERVED_MODE` `E_MODE_ID` `E_EXTENDS_CYCLE` `E_EXTENDS_UNKNOWN` `E_EXTENDS_DEPTH` `E_SECTION_CONFLICT` `E_SECTION_UNKNOWN` `E_SECTION_DUP` `E_CATALOG_REF` `E_ALIAS_RESERVED` `E_ALIAS_COLLISION` `E_ALIAS_UNKNOWN_MODE` `E_PLACEHOLDER_UNRESOLVED` `E_BUDGET_EXCEEDED` `E_ROUTE_ID_INVALID` `E_ROUTE_OVERLAP` `E_ROUTE_UNKNOWN_MODE` `E_ROUTE_BAD_MATCH` `E_ROUTE_BAD_DOMAIN` `E_ROUTE_SWITCHING_UNVERIFIED` `E_DEFAULT_ROUTE` `E_AUDIT_DIR`

- `E_PARSE`（#43 追加）: 入力ファイル（manifest.yml / modes/*.yml / aliases.yml / install.yml）の YAML 構文エラー・safe loader 拒否（未知タグ等）・トップレベル形状の解釈不能。置換・正規化後に空となる alias（§2.4）も本コード。より特定的なコードに確定できる場合はそちらを優先する（文脈流用 — 例: malformed envelope を `E_SECTION_CONFLICT` で報告する — は禁止。誤誘導のため）
- `schema_version` が対応範囲より新しい場合も `E_SCHEMA_VERSION`（前方互換を仮定しない。エラーメッセージにエンジン更新を促す文言を含める）。**build の engineVersion が pack の `engine.min`/`engine.max` 範囲外の場合も `E_SCHEMA_VERSION`**（メッセージで engine range 違反と明示。#43）

- `E_BUDGET_EXCEEDED`: モードのコンパイル済みブロックの計数トークン > 有効予算。**有効予算 = min(install.budget_tokens ?? pack.default_budget_tokens ?? 600, mode.budget_tokens ?? ∞)**。グローバル上限は常に存在する（600 は規範既定値 — 全予算未宣言でも無制限にならない）。**黙った切り詰めは禁止**（設計確定: 禁止事項が落ちる事故の方が重い）
- **計数器（規範）**: `pe-count-v1` = `ceil(UTF-8 バイト長 / 3)`。決定論・言語非依存・保守側（過大評価方向）。build と doctor は同一計数器を使い、`manifest.json` に `{counter: "pe-count-v1", tokens: n}` を記録。実トークンとの乖離は将来の counter バージョンで改善（manifest の counter id で判別）

## 5. ブロック正規形とバイト安定性

- ブロックは自己完結タグで包む: `<persona-mode id="<mode-id>" pack="<name>@<version>">\n…\n</persona-mode>`（他 plugin と連結されても境界が判別できる — OpenClaw spike 反映事項7）
- コンパイラ出力は最初から **LF・行末空白なし・前後 trim 済みの正規形**とする（OpenClaw 側の `normalizeStructuredPromptSection` を通っても不変、Hermes 側では素通しでも同一 — OpenClaw spike §Q4）
- ランタイムはブロックを**ファイルからロードしてメモリ保持**し、再構築・再整形しない。同一モードのあいだ**バイト同一**を保証（不変条件6）
- タイムスタンプ・乱数・カウンタ等の動的要素をブロックへ入れることを**禁止**

## 6. Route policy

### 6.1 routes 宣言（install.yml）

```yaml
routes:
  - id: slack-work                 # 必須。install 内一意。[a-z0-9-]+ 以外・予約名（__ 前置全般）→ E_ROUTE_ID_INVALID
    match: { platform: slack }     # §6.2 のキーに対する等値 or prefix
    allowed_modes: [public]
    switching: deny                # deny | explicit | explicit-and-agent
    state_domain: work
  - id: voice-private
    match: { platform: api_server, session_key: { prefix: "voice-" } }
    allowed_modes: [public, ...]
    switching: explicit-and-agent
    owner_verified: true       # この route の全発話が owner 由来であることの operator 宣言
                               # （認証済み音声・owner DM 等）。既定 false
    state_domain: private      # [a-z0-9_-]{1,64} 以外 → E_ROUTE_BAD_DOMAIN（ファイル名に直結するため）
default_route:                 # 任意。**構成可能なのは state_domain のみ**
  state_domain: quarantine     # allowed_modes は [public]・switching は deny に固定
                               # （不変条件2の実体。緩和記述があれば E_DEFAULT_ROUTE）
                               # default_route 節ごと省略した場合の state_domain も "quarantine"
```

- route id は `[a-z0-9-]+` に一致しなければならず、`__default__`、`__admin__`、またはその他の `__` で始まる名前を使用してはならない（engine 内部の synthetic route id 用予約領域。§7.1 の `"__default__"` sentinel および CLI の `"__admin__"` sentinel を参照）→ 違反は build 時のみ検査する `E_ROUTE_ID_INVALID`。
- **owner_verified による構造的強制**: `switching: deny` 以外を宣言する route は `owner_verified: true` でなければならない → 違反は `E_ROUTE_SWITCHING_UNVERIFIED`。turn() は owner トリガーを **route.owner_verified が真の場合のみ**受理する（§7.1）。actor の owner 性はアダプタの申告ではなく route の性質で証明する（OpenClaw spike: senderId 非存在への構造的回答）
- **group/channel 型サーフェスの縮退規則（両 spike 反映）**: 複数人が発話し得るサーフェスの route に `owner_verified: true` を宣言してはならない（operator 責務）。`doctor` は match が group を包含し得るのに owner_verified な route を警告する

- `match` の値: 文字列（等値）または `{prefix: "<s>"}`（前方一致）。それ以外 → `E_ROUTE_BAD_MATCH`。**match のキーは install の `runtime` に対応する §6.2 のキー集合に属さなければならない**（未知キー → `E_ROUTE_BAD_MATCH`。typo が「常に不一致の死んだ route」として沈黙するのを防ぐ）
- **欠落キーの意味論**: `match` が参照する ctx キーが実行時に欠落/undefined の場合、その route は**不一致**（キー無視で緩く一致させることを禁止。例: `channel_id` を match に使う route は、`channel_id` が undefined の CLI 経路 run にマッチしない → default 方向に倒れる）
- **評価は「唯一マッチ」原則**: ある route ctx に対しマッチし得る route が複数存在する組があればビルド時に `E_ROUTE_OVERLAP`。実行時の優先順位規則は**存在しない**。**重複判定アルゴリズム（規範）**: route A, B について、両者の match キーの和集合の各キー k で制約が交差するなら overlap。交差規則: (a) 片方に k が無い = 無制約（すべてと交差）(b) 等値 vs 等値 = 値が同一 (c) 等値 vs prefix = prefix が値の前方部分列 (d) prefix vs prefix = 一方が他方の前方部分列。全キー交差 → `E_ROUTE_OVERLAP`（保守側判定: 実際には到達不能な組合せも重複と数える。これは意図的）
- `allowed_modes` の未定義モード → `E_ROUTE_UNKNOWN_MODE`。`public` は常に暗黙に許可される（明示不要だが書いてもよい）
- `switching` の意味: `deny`=いかなる切替も不可 / `explicit`=owner の明示トリガーと admin のみ / `explicit-and-agent`=明示 + エージェント自発（`persona_set`）。owner_verified との結合規則は §6.1 冒頭（構造的強制）を参照

### 6.2 route ctx（アダプタ → コアの入力契約）

route ctx は **trusted runtime context のみ**から作る。キーはランタイム別に本 SPEC で固定:

| runtime | キー | 出所（trusted） |
|---|---|---|
| openclaw | `session_key_rest`, `channel_id?` | hook `ctx.sessionKey` を `agent:<agentId>:<rest>` に**構造化パース**した `<rest>`（OpenClaw spike: `includes` 判定禁止・`explicit:` 形偽陽性あり）。`channel_id` は `ctx.channelId`（CLI 経路では undefined 許容必須） |
| hermes | `platform`, `session_id`, `session_key?`, `api_mode` | middleware context 直渡しの `platform`（第一シグナル）・`session_id`。`session_key` は sessions.json 逆引き or `X-Hermes-Session-Key`（到達性は M2 受け入れテストで確定）。**信頼境界**: api_server の session_key はクライアント申告値（Bearer 認証内）。よって session_key prefix で private へ昇格する route は「その api_server に到達できる全認証クライアントが同一信頼レベル」であることが前提 — install の README に明記し、doctor が警告表示する |
| claude-code (M4) | 予約 | — |
| generic (CLI) | 呼び出し側が `--ctx k=v` で自己申告**しない**。CLI は route を評価せず actor:admin 経路のみ（契約4） |

- パース失敗・必須キー欠落・逆引き失敗 → route 未解決 → **default_route + 監査**（§8）
- OpenClaw の許可 prefix は routes の match として**明示列挙**する。サブエージェント (`subagent:`)・cron・`explicit:` 形 key はどの route にもマッチさせず default（public）に落とす — これが委譲 run への persona 混入防止を兼ねる（OpenClaw spike 反映事項2）

### 6.3 policy 必須契約（5点・設計凍結分）

1. **解決時再検証**: 遷移時だけでなく**毎ターンの block 解決時**にも `current_mode ∈ route.allowed_modes` を検証。共有 domain に不許可モードが残っていた場合は **public を返す**（state は書き換えない。private block を注入しない）。監査に `resolve_downgrade` を記録
2. **引数の最小化**: `persona_set` ツールのモデル可視引数は `mode` のみ。route / sender / session / actor は trusted runtime context から束縛（モデル自己申告禁止）
3. **ツール自体の出し分け**: `switching` がエージェント切替を許可しない route では `persona_set` をその turn のツール集合に**存在させない**。実装: OpenClaw = tool factory の null 返し / Hermes = `llm_request` middleware で tools 配列から除去 + `pre_tool_call`/`tool_request` で hard-deny。**いずれの場合もコアの policy 再評価は残す**（二重防御）。route はセッション内で不変なので tools 配列は session 内安定（cache を割らない — OpenClaw spike §Q3）
4. **CLI も同じゲート**: CLI `persona set` は `actor: admin` として認可規則を通す。admin は switching 値に関わらず遷移可能だが、**遷移先が対象 domain を共有するいずれかの route の allowed_modes に含まれない場合は拒否**する（どの route からも解決不能なモードを植え付けない）。route の自己申告は不可
5. **route 重複は build error**（§6.1 の唯一マッチ原則）

## 7. turn() / set() 契約（言語中立）

コア実装は TypeScript（`packages/core`）。**Hermes アダプタは Python 薄実装を持つ**（Hermes spike の決定: subprocess 起動レイテンシ回避）。両実装は本節の契約と §11 の共有 golden fixtures に適合しなければならない。turn() は「`build/` 成果物 + `state/` ファイルプロトコル」に対する純粋な手続きとして定義され、言語・プロセス形態に依存しない。

### 7.1 turn(input) → TurnResult

```
input  = { ctx: map,               # route ctx（§6.2）
           utterance?: string,     # 受信発話（明示トリガー判定用。正規化前）
           actor: "owner"|"unknown",  # 発話者が owner と確定できる場合のみ owner
           turn_key?: string }     # ランタイムの turn 識別子（§7.4）
result = { mode: string,           # 解決モード
           block: string,          # 注入バイト列（public なら ""）
           route_id: string,       # 解決 route（default は "__default__"）
           state_domain: string,
           transitioned: bool,
           rejected?: {requested_mode, reason},
           degraded?: bool,        # 監査/status 書き出し失敗時 true（§8）
           audit: [event...] }     # 参考コピー（書き出し責務はコア — §8）
```

処理順（**単一 state スナップショットで完結** — 設計 §2.4 凍結分）:

1. `ctx` → route 解決（未解決 = default_route）
2. `utterance` があれば正規化（§2.4 normalization v1）→ `triggers.json` 全文一致 + 予約コマンド解釈。**マッチは `route.owner_verified == true` かつ `actor == "owner"` かつ route.switching ∈ {explicit, explicit-and-agent} の場合のみ有効**（owner 性の証明は route 宣言 — §6.1）
3. トリガーが有効なら遷移試行: `target ∈ route.allowed_modes` を検証 → OK なら state 遷移（§7.3 の原子的 CAS）。NG なら reject（現モード維持）
4. block 解決: 遷移後（または現）スナップショットの `current_mode` に**契約1の解決時再検証**を適用 → block ロード
5. TurnResult 返却。**呼び出し側はこの block をそのまま注入し、state を再読してはならない**

- 同一ターン保証: トリガー発話そのものに新モードで応答する（手順 2-4 が同一呼び出し内のため、ランタイムの hook 発火順序に依存しない）
- turn() は **LLM 応答後の処理を持たない**（後処理 hook 不要 = アダプタ最小契約が保てる）

### 7.2 set(input) → SetResult（persona_set ツール / CLI）

```
input  = { ctx: map | null,        # tool 経路: trusted ctx（契約2）。CLI: null
           actor: "agent"|"admin",
           requested_mode: string,
           domain?: string }        # actor:admin のみ・必須（CLI は --domain 明示。暗黙選択禁止）
```

```
result = SetResult { ok: bool, mode: string,        # 遷移後（reject 時は現）モード
                     transitioned: bool,
                     rejected?: {requested_mode, reason},
                     degraded?: bool,                # §8 と同義
                     audit: [event...] }
```

- `actor: agent` — route.switching == `explicit-and-agent` かつ route.owner_verified かつ `requested_mode ∈ allowed_modes` の場合のみ許可。**反映は次ターン**（生成中プロンプトは不変。設計 §2.5 凍結: 1ターンの継ぎ目は漏れではなく UX 仕様）
- `actor: admin` — 契約4の規則。対象 domain は `domain` 引数で**明示必須**（省略・未知 domain は拒否。「install に routes が1つしかない」場合も暗黙化しない）
- すべて `set_by: agent|admin` として監査記録

### 7.3 State store（`state/<domain>.json`）

```json
{ "v": 1, "revision": 42, "mode": "sweet-gf", "set_by": "owner|agent|admin",
  "set_at": "<ISO8601>", "route_id": "voice-private" }
```

- `v` は state ファイル形式バージョン。エンジンは自分より新しい `v` を **F2 扱い**（public 解決・書き換え拒否）とし、古い `v` は遷移時に最新形式へ書き直してよい

- **原子的遷移プロトコル**（#42 改訂）: ① `<domain>.lock` を**排他ロックファイル取得**（`open(O_CREAT|O_EXCL)`・timeout 2s・バックオフ再試行）② 再読して `revision` 確認 ③ 新 state を `<domain>.json.tmp` に書き fsync ④ rename ⑤ ロックファイル削除（自トークン確認のうえ）。revision 不一致（並行遷移）は再評価 1 回、なお不一致なら reject。**機構を O_EXCL とする根拠**: TS core（CLI）と Python 薄実装（Hermes turn パス）が同一 state ディレクトリを同時に触るため、ロックは両言語で相互運用可能な同一プロトコルでなければならない（flock は Node コアに存在せず、flock/非flock の混在は排他にならない）
  - stale lock（クラッシュ残骸）は mtime 閾値で回収してよい。**受容された限界**（#42 決裁）: 閾値を超えて停止した生存保持者の刈り取り・解放時の狭い競合窓は許容する — クリティカルセクションは通常 sub-ms、最悪影響は1遷移の lost update に限定され、state ファイル自体の整合は原子 rename が常に保証する。doctor がロック滞留を検査する（M2 #25）
- **初期状態**: state ファイル不在は破損ではなく**暗黙の `{v:1, revision:0, mode:"public"}`** として読む（fresh install で F2 を発火させない）。初回遷移が lock 下で `revision:1` のファイルを tmp→rename で作成する。lock ファイルは必要時に作成してよい
- lock timeout / JSON 破損 → **遷移せず public 解決 + 監査 `state_error`**（fail-closed）。破損ファイルは `doctor` が隔離・再初期化
- state ファイルにモード**内容**は置かない（mode id のみ。不透明原則）

### 7.4 turn 内複数解決の安定性（Hermes 反映事項）

Hermes の `llm_request` middleware は 1 ターン（tool ループ）中に複数回発火する。アダプタは `turn_key`（Hermes: `turn_id`）ごとに TurnResult を**キャッシュし、同一 turn 内の全 API コールに同一バイト列を注入**しなければならない（単一スナップショット原則の turn 内延長 + cache 安定）。turn_key が取れないランタイムでは「セッション毎の解決キャッシュ + 遷移時無効化」を代替とし、その旨をアダプタ docs に明記する。

## 8. Fail-closed 規則と観測性（enumerated）

**原則: 安全側に壊れる。ただし無言で壊れない。**

| # | 事象 | 挙動 | 監査 event |
|---|---|---|---|
| F1 | route 未解決（ctx 欠落・パース失敗・逆引き失敗） | default_route（public/deny） | `route_unresolved` |
| F2 | state lock timeout / 破損 | public 解決・遷移拒否 | `state_error` |
| F3 | `build/` 欠落・manifest 非互換・block ファイル欠落 | **無注入**（public 相当）・切替不可 | `build_invalid` |
| F4 | アダプタ callback 内の未捕捉例外 | callback 全包囲 try/except で**無注入**に落とし、**コアが公開する `report_adapter_error(error, ctx?)` API を呼ぶ**（監査ファイルへの書き込み自体はコア実装の内部 — アダプタはファイルを直接触らない。この API 呼び出しも失敗したらホストのログ機構に warn を出して黙る） | `adapter_error` |
| F5 | 解決時再検証 NG（共有 domain に不許可モード） | public block 返却（state 不変） | `resolve_downgrade` |
| F6 | 切替 reject（policy 却下） | 現モード維持 | `switch_rejected` |

**書き出し責務**: `audit.jsonl` と `status.json` の書き出しは **turn()/set() 実装（コア/薄実装）の内部責務**であり、アダプタの4責務（§10）には含まれない。書き出し失敗は block 解決を**妨げない**（人格の可用性 > 観測性）が、TurnResult に `degraded: true` を立て、ホストのログ機構へ warn を出す（doctor は status 鮮度で検出）。

**観測性（GLM 最終ゲート指摘の凍結）**:

- `<audit_dir>/audit.jsonl`（append-only）: 全遷移・全 reject・F1-F5。`audit_dir` は install.yml の `audit.dir`（既定 `audit/`）を **build が検証して `policy.json` に焼き込む**（ランタイムは YAML を読まないため — 不変条件4）。検証: install root 相対・`..`/絶対パス拒否に加え、**realpath 解決後も install root 配下**であること（symlink 脱出も `E_AUDIT_DIR`）。ランタイムは open 時にも realpath 封じ込めを再確認し、違反時は書き込まず degraded 扱い。行形式 `{ts, event, route_id, domain, from?, to?, set_by?, reason?}`。**発話本文・ブロック内容は記録しない**（不透明原則・ログ経由の漏洩防止）
- `state/status.json`（毎 turn 原子更新）: `{ts, route_id, mode, block_sha256, block_bytes, engine, turn_key?}`（`engine` = 実装 id `"ts@x.y.z" | "py@x.y.z"` — §11 のドリフト調査用） — 「今なにが注入されたか」の最終事実。status コマンド（M3 #26）と doctor の一次情報
- Hermes は `middleware_trace`（source/reason）を返し、ホスト側 observer ログにも痕跡を残す（MAY）

## 9. doctor 検査項目（M2 #25 / 拡充分含む・凍結は項目定義のみ）

1. `build/manifest.json` 整合（schema/engine 互換・content_hash・block ファイル実在・トークン再計数一致）
2. 注入到達性: 直近 `status.json` の鮮度、audit の F 系イベント率
3. **OpenClaw**: `plugins.entries.<id>.hooks.allowPromptInjection !== false` / voice route prefix の hook 到達性（agent CLI に `--session-key` が無いバージョンあり — 2026.4.5 実測）/ ツール名衝突 diagnostics
4. **Hermes**: plugin enable 状態 / `conversation`→`session_id` 写像の実測（M2 受け入れテストで手順確定）/ bootstrap 予算（該当時）
5. routes 静的点検: group 包含 route の switching≠deny 警告（§6.1 縮退規則）/ 到達不能 route / voice- prefix の宣言漏れ
6. 共有メモリ漏れ警告: private モード許可 install でホストの共有メモリ設定を点検し警告（v2 は警告まで。domain 分離は v3、M4 前に再評価ゲート — 設計 §2.7）
7. secret パターン走査: `build/modes/*.md` に API key 形状等が混入していれば警告（§3）
8. api_server 信頼境界の表示: session_key prefix で昇格する route がある install では、当該前提（§6.2 hermes 欄）を doctor 出力に常時表示

## 10. アダプタ契約（Addendum A2 の凍結）

アダプタの責務は以下 4 点**のみ**（これ以外を実装してはならない）:

1. trusted runtime context から route ctx（§6.2）を導出
2. `turn()` を 1 turn につき論理 1 回呼ぶ（§7.4 のキャッシュ許容）
3. 返った block を最も request-scoped な位置に注入
4. （対応ランタイムのみ）`persona_set` を policy に従い登録/出し分け

| | OpenClaw（M3 #23） | Hermes（M2 #33） |
|---|---|---|
| 形態 | typed plugin package（`openclaw.plugin.json` + dist/index.js）、core を in-process import | Python plugin 1個（`register(ctx)`）、turn() Python 薄実装 |
| 注入 | `before_prompt_build` 戻り値 **`appendSystemContext` のみ**（prepend 系・`systemPrompt` 置換は禁止 — OpenClaw spike §Q4: cache boundary の後ろに入り切替時も stable prefix 生存） | `llm_request` middleware で `messages`（chat）/`instructions`（responses）へ system ブロック挿入。`api_mode` で分岐 |
| tool | `registerTool(factory, {name:"persona_set"})` + 不許可 route で null | `register_tool` + middleware で tools 配列から除去 + `pre_tool_call` hard-deny |
| owner 判定 | route の `owner_verified` 宣言（音声=gateway 認証・DM=per-sender session）が唯一の規範的根拠。tool factory の `senderIsOwner` は**追加の防御層として併用してよい（MAY）**が、これを owner 証明として `owner_verified` の代わりに使ってはならない | 同左（platform + session key の owner_verified route）。group 縮退規則適用 |
| utterance 抽出 | `event.prompt`（現在発話が直接届く） | **chat mode**: request `messages` の**最後の `role=="user"` メッセージ**のみ（履歴・assistant・tool メッセージ・引用は走査しない）。**responses mode**: request `input` が文字列ならその全体（本番クライアントは現在発話のみを単一文字列で送る — Hermes spike REF）、構造化配列なら **最後の `role=="user"` の message アイテムの text パートのみ**（非 message アイテム・tool 結果・assistant 出力は走査しない）。どちらのモードでもトリガー判定は **turn の初回 API コールのみ**（2回目以降は §7.4 キャッシュを返す — tool ループ中の再トリガー・履歴中の過去トリガー再発火を構造的に排除） |
| 禁止 | `before_agent_start`（2相発火・legacy）への注入 / includes 判定 / 本番インスタンス改変 | bootstrap 書換による切替（per-session 反映しかしない — Hermes spike Q5）/ Hermes の fail-open への依存 |

ランタイムが per-turn 注入点を持たない場合（将来の別ランタイム）: 縮退（session-scoped 再生成 + invalidation、または bootstrap 書換 + グローバル state）を**正直に文書化**し、「v2 保証（per-surface 分離・同一ターン反映）を満たさない」ことを README に明記する。

## 11. 適合性（conformance）

- `spec/fixtures/`（M1 #20 で整備）は**2スイートに分割**する:
  - **compile suite**（TS コンパイラのみが対象）: 継承マージ / 描画決定論 / build error 全種 / 予算計数
  - **runtime suite**（TS core と Python 薄実装の両方が対象）: 正規化・トリガー判定 / policy 契約1-5 / turn()・set() 手順（reject・downgrade・fail-closed F1-F6・初期状態）/ 並行遷移（revision CAS）。入力は `build/` 成果物形式（Python 側はコンパイラを実装しない）
- **TS core と Python 薄実装は runtime suite を全通過**しなければならない（等価性の担保。turn() 契約の言語中立性はこれで検証する）
- **カバレッジ下限**: fixtures は policy 契約1-5 の各分岐・F1-F6 の各事象・§6.1 欠落キー意味論を**最低1ケースずつ**含む（TS/Py ドリフトが「fixture がたまたま踏まない authz 分岐」に潜む事故の防止）。`status.json` に実装 id（`engine: "ts@x.y.z" | "py@x.y.z"`）を記録しドリフト調査可能にする
- fixtures の発話・ブロックはすべてダミーコンテンツ（実 pack 内容を持ち込まない）

## 12. 互換・バージョニング

- `schema_version` は pack / install / build manifest で独立して持ち、engine は自分の対応範囲外を **F3 扱い**で拒否
- `build/` 形式の変更は engine minor up + `persona build` 再実行で吸収（アダプタは build 形式にのみ依存）
- v1 資産の移行は `persona migrate`（#22）: v1 modes/index/catalogs → v2 pack 骨格を機械変換し、**内容ファイルはバイトコピー**（不透明原則。エンジン開発者が内容を読まずに移行できる形にする）

---

## Appendix A: spike 由来の凍結事項トレース

| 事項 | 出典 |
|---|---|
| Hermes = `llm_request` middleware・fail-open・turn 内複数発火 | 内部スパイク記録（Hermes・非公開）Q1 |
| Hermes route ctx = platform 直渡し・session_key は M2 実測 | 同 Q3 |
| bootstrap 書換は per-session → 切替手段として不成立 | 同 Q5 |
| turn() 言語中立化・Python 薄実装 + 共有 fixtures | 同 決定節 |
| OpenClaw = appendSystemContext 一択・cache boundary 後方 | 内部スパイク記録（OpenClaw・非公開）Q4 |
| sessionKey 構造化パース・prefix 明示列挙 = サブエージェント混入防止 | 同 Q2/反映2 |
| senderId 非存在 → owner 判定は route 性質で代替 | 同 Q1 |
| tool factory null 返し・session 内ツール出し入れ禁止 | 同 Q3 |
| allowPromptInjection / --session-key バージョン差 → doctor | 同 Q2/Q4 |
