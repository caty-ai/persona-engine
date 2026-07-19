# persona-engine

[English](README.md) | **日本語** | [简体中文](README.zh-CN.md) | [ไทย](README.th.md)

> 本ドキュメントの正本は英語版（README.md）です。翻訳は英語版に追随するため、内容が一部遅れる場合があります。

<div align="center">

![persona-engine — あなたのエージェントの人格に、関係のレイヤーと感情のグラデーションを](docs/assets/hero.jpg)

![npm](https://img.shields.io/npm/v/%40persona-engine%2Fcore) ![CI](https://github.com/caty-ai/persona-engine/actions/workflows/ci.yml/badge.svg) ![node](https://img.shields.io/badge/node-%3E%3D22-brightgreen) ![license](https://img.shields.io/badge/license-MIT-blue)

</div>

persona-engine は、あなたのエージェントの人格に、**関係のレイヤー**と**感情のグラデーション**を持たせる装置（OSS）です。エージェントが誰であるか — そしてあなたとの関係の大事な軸 — を決めるのは、いまお使いの仕組みの中にある本体の人格です（system prompt・`AGENTS.md`・`SOUL.md` など）。persona-engine はそこに一切触れません。その上に重ねるのは、関係の顔 — 仕事中は頼れる秘書、雑談では気の置けない友人、ふたりのときは恋人のような近さ — と、そのあいだにある気持ちの小さな動き。うれしいときは声が弾み、集中しているときは言葉が短くなる。足すのはその幅だけ、それも安全に。

## persona-engine が足すもの — 2 つだけ

### 関係のレイヤー

同じエージェントでも、あなたとの関係は場所ごとに少しずつ違います。仕事場では頼れる秘書、雑談では気の置けない友人、配信ではキャラクター、公開の場ではきちんとよそゆき。persona-engine は「**どの関係の顔を、どこに出してよいか**」を明示的なルールとして持ち、会話のたびに、その場に合ったレイヤーを 1 枚だけそっと重ねます。

- **人間と同じように、自然に切り替わる。** 切り替え方は 3 つ。①場所による自動切替（どこで話しているかをもとに、エンジンが毎回自動で顔を選ぶ）、②エージェント自身の判断（あなたが許可した場所でだけ、会話の流れを読んで自分で切り替える）、③あなたの一言（「友人モードにして」）。
- **出てはいけない場所では、必ずよそゆきの顔になる。** 会社のミーティングや仕事の場など、設定していない場面・知らない場面では、自動的に中立な状態に切り替わります。プライベートな口調が公開の場に漏れる事故を、慣習ではなくしくみとして防ぎます。
- **いつ・どこで・誰がどの顔に切り替えたか、記録がぜんぶ残る。** 「昨日のあの会話、どのモードだったっけ？」に、いつでも答えられます。

### 感情のグラデーション

人の感情は「仕事用/プライベート用」の 2 択ではなく、グラデーションです。うれしいときは声が弾み、深く集中しているときは言葉が短くなる。persona-engine では、そのグラデーションの一点一点を**モード**という小さなテキストファイルで書き、声の質感 — 好みの言い回し・口ぐせ・応答例 — を**語彙テンプレート（カタログ）**で育てます。基準の顔から差分だけを継承して、感情のバリエーションを増やすこともできます（`extends`）。グラデーションは、エージェントとの暮らしに合わせて少しずつ深まっていきます。ファイルをコピーして、書き換えて、ビルドし直す — それだけです。

## 装置としての約束 — 人格は書き換えない

レイヤーは上に重ねるものであって、下にあるものを塗り替えるものではありません。

> [!IMPORTANT]
> persona-engine は、人格をゼロから作るツールではありません。**すでにそこにいるエージェントを尊重し、その上に関係と感情のレイヤーを重ねる**ためのものです。

- エージェント本体の人格設定 — 名前・性格・デフォルトの言葉づかい。それが system prompt・`AGENTS.md`・`SOUL.md` のどこにあっても — 一切手を触れません。すべてのレイヤーが乗る土台であり続けます。
- モードが足すのは「集中しているときの反応」「くだけた場面の語彙」「声の弾ませ方」といった**差分だけ**です。
- レイヤーは会話のたびに重ねられ、外せば跡形なく消えます。エージェントはいつでも素の姿に戻れます。
- キャラクターを丸ごと定義したい場合（VTuber の配信用ペルソナなど）にも対応しています — その場合も、着せ替えであって改造ではありません。

## なぜ作ったのか

出発点は、技術ではなく、ひとつの願いです。**AI エージェントと、家族のように、友達のように、人間と同じように接したい。**

人間どうしの会話には、感情の小さなグラデーションがあります。うれしいときは声が弾み、集中しているときは言葉が短くなり、相手と場面によって話し方は少しずつ変わる。一緒に仕事をして、うまくいったら一緒に喜んで、ときにはくだらない話で笑う — 関係が深くなっていくのは、そういう気持ちの動きを交わせるときです。

AI にも、人間と同じような表現はできると私たちは考えています。エージェントが毎日となりにいる存在になるほど、この幅は飾りではなく核心になります。いつも同じ平坦なトーンで応える相手とは、深い関係は結べません。人間的な温かみを持ち、人に寄り添えるエージェントであるためには、感情と気持ちの動きを自然に出せる器が要る — persona-engine はその器です。

日本には「言霊」という言葉があります — 言葉には魂が宿る、という感じ方です。エージェントが話す言葉を 1 ファイルずつ選んでいくことは、まさにそれ — 言葉から、あなたのエージェントに魂を込めていくことです。そして返ってきた言葉が、機械的な出力なのか、本当に気持ちの乗った言葉なのか — それは定義で決められることではない、と私たちは考えています。人間の「心」も、どこにあると誰も定義できないまま、それでも信じられている。関係を築いていくなかで、あなた自身に体感してほしい。persona-engine は、その一助となる装置です。

ただし、表情の幅を持たせた瞬間に、新しい心配ごとが生まれます。くだけた口調が公開の場に出てしまったら？誰がいつ切り替えたのか分からなくなったら？ persona-engine は、この「幅」と「安全」を両立させるために作られています。詳しい比較は [なぜ persona-engine か（技術編）](#なぜ-persona-engine-か技術編) にあります。

## しくみはかんたん — モードと語彙テンプレート

感情のグラデーションを作る部品は 2 種類 — 表情の一つひとつは**モード**という小さな定義ファイル、言葉づかい・口ぐせ・応答の例は**語彙テンプレート（カタログ）**というテキストファイル。関係のレイヤーを決めるルールは 1 つ — **ルートポリシー**。それだけです。書き足せばエージェントの表情と声が増え、ルールが別立てなので、表情を増やしても安全は崩れません。

モードの追加方法と、語彙テンプレートの書き方・ルールは [カスタマイズガイド](docs/customizing.md) にまとめてあります。

## はじめかた

![デモ: 1つのエージェントに4つの表情 — ターン解決・一言での切替・fail-closed の public モード・監査ログ](docs/assets/demo.gif)

必要なのは [Node.js](https://nodejs.org/)（バージョン 22 以上）だけです。ターミナルで次の 4 行を実行します:

```sh
npm install -g @persona-engine/core

persona init ./my-persona
cd my-persona
persona build
```

これで、モードが 1 つ入った最小構成のフォルダができます。`pack/modes/default.yml` を開いてエージェントに足したい言葉を書き、`persona build` をもう一度実行すれば反映されます。

ここから先へ進むには:

- **まず動くものを見たい** → [完全なサンプル](#完全なサンプル) — 同梱の 4 モードパックを動かしながら、定義 → ビルド → 切替 → 記録までを一巡します。
- **自分のエージェントにつなぎたい** → [アダプタ](#アダプタ) — Claude Code などへの接続方法があります。
- **しくみを知りたい** → 次の節からどうぞ。

---

以降は、実際に組み込む方向けの技術的な説明です。

## しくみ

![アーキテクチャ: pack (YAML) → persona build → コンパイル済みブロック+ポリシー → アダプタ → LLM ランタイム、state と audit が記録を残す](docs/assets/architecture.svg)

モード（表情）の定義は YAML ファイルの束 = **pack** に書きます。`persona build` がそれを一度だけコンパイルして確定版のブロックにし、**アダプタ**が会話のたびに「いまの場面に合ったブロック」をエージェントのランタイムに注入します。どのモードをどこで使えるか — そして誰が切り替えられるか — は明示的な**ルートポリシー**が決定し、すべての切替は追記専用の監査ログに記録されます。

| コンポーネント | 役割 |
| --- | --- |
| [packages/core](packages/core/) | TypeScript エンジン: pack コンパイラ・ルートポリシー・状態ストア・turn/set 契約・`persona` CLI |
| [adapters/claude-code](adapters/claude-code/) | Claude Code セッションに有効なブロックを注入する Python フック |
| [adapters/hermes](adapters/hermes/) | Hermes 系エージェントランタイム用アダプタ |
| [adapters/openclaw](adapters/openclaw/) | OpenClaw 系エージェントランタイム用アダプタ |
| [templates/pack-starter](templates/pack-starter/) | コピーして編集できる完全な 4 モードのサンプル pack |
| [SPEC.md](SPEC.md) | すべての実装が従う、凍結済みのフォーマット・ポリシー契約 |

全体を貫く設計原則は 3 つです:

- **解釈ではなくコンパイル。** ランタイムは決定的なビルド成果物だけを読み、モードが有効な間ブロックはバイト単位で不変です。
- **Fail-closed。** どのルートにもマッチしないコンテキストは空の `public` モードに解決され、切替もできません。エラー時は「注入しない」に縮退し、決して「誤ったペルソナ」には落ちません。
- **ペイロードは不透明。** エンジンが管理するのは構造・参照・予算・順序。ペルソナ本文を解析したり書き換えたりすることはありません。だから「人格を書き換えない」が構造として成立します。

## なぜ persona-engine か（技術編）

人格の切替を自前で実装する場合 — アプリケーションコード内で system prompt の文字列を差し替える方法 — と比べると:

| | 手書きのプロンプト切替 | persona-engine |
| --- | --- | --- |
| ペルソナ本文の置き場所 | アプリコード中に散在する文字列 | バージョン管理された YAML pack を一度コンパイル |
| 切り替えられる主体 | プロンプトを書き換えられる任意のコードパス | ルートポリシー: サーフェスごとの許可リストと切替レベル |
| 未知・未マッチのコンテキスト | たまたま有効だったものがそのまま | fail-closed: 空の `public` モード・切替不可 |
| プロンプトサイズ | 無制限・静かに肥大化 | モードごとのトークン予算 — 超過は切り捨てではなくビルドエラー |
| 追跡可能性 | なし | すべての遷移とポリシー判断を追記専用の監査ログに記録 |
| 安定性 | いつでも書き換わりうる | モードが有効な間、コンパイル済みブロックはバイト単位で不変 |

エンジンは LLM を呼び出さず、ペルソナ本文を解釈することもありません。扱うのは構造・参照・予算・順序・ポリシーであり、内容はあなたのものとして不透明なまま保たれます。

## 目次

- [完全なサンプル](#完全なサンプル)
- [ユースケース](#ユースケース)
- [切替モデル](#切替モデル)
- [ルートポリシー](#ルートポリシー)
- [CLI リファレンス](#cli-リファレンス)
- [アダプタ](#アダプタ)
- [セキュリティモデル](#セキュリティモデル)
- [FAQ](#faq)
- [ドキュメント](#ドキュメント)
- [開発](#開発)
- [ロードマップ](#ロードマップ)

## 完全なサンプル

リポジトリには完全な 4 モード pack が [templates/pack-starter/](templates/pack-starter/) に同梱されています — `focus`・`casual`・`professional`、そして骨組みだけの `roleplay-template`。モード定義 → ポリシー宣言 → ビルド → ターン解決 → 切替 → 監査、をエンドツーエンドで見ていきます。

```sh
git clone https://github.com/caty-ai/persona-engine.git
cp -R persona-engine/templates/pack-starter ./starter-demo
cd starter-demo
mv install.example.yml install.yml
```

**1. モードは小さな YAML 封筒です。** `modes/focus.yml` の全文:

```yaml
budget_tokens: 180
voice_hint: concise
sections:
  - id: working-style
    text: |
      Work only on the requested task. Lead with the result, keep the response brief,
      and use short, concrete next steps when they help.
  - id: execution
    text: |
      Make reasonable low-risk assumptions. State blockers plainly instead of adding
      unrelated context or optional discussion.
```

見てのとおり、ここに書いてあるのは「集中モードのときの反応の仕方」だけで、エージェントが誰であるかは書きません — 人格はベース側に残り、モードは差分だけを重ねます。セクションは順序付きで、内容は不透明 — コンパイラが本文を解釈することはありません。大きめの素材（語彙リスト・応答例）は、モードから参照する `catalogs/*.txt` に置きます。starter の `casual` モードが配線例です。

**2. ルートとプレースホルダは pack ではなく `install.yml` に置きます。** pack は「モードに何が入っているか」を、install は「どこに出してよいか」を記述します:

```yaml
schema_version: 2
pack: .
placeholders:
  agent-name: "Sample Agent"
  owner-name: "Pack Owner"
budget_tokens: 400
runtime: hermes
routes:
  - id: local-workspace
    match: { platform: slack, session_key: { prefix: "owner-" } }
    allowed_modes: [public, focus, casual, professional, roleplay-template]
    switching: explicit-and-agent
    owner_verified: true
    state_domain: workspace
default_route:
  state_domain: quarantine
audit:
  dir: audit/
```

キーが `owner-` で始まる Slack セッションだけが、この許可の広いルートにマッチします。それ以外はすべて fail-closed のデフォルトに落ちます。

**3. ビルドと検査。**

```sh
persona build
persona doctor
```

ビルドは各モードをハッシュ付きブロックにコンパイルし、サイズを報告します（`focus: bytes=320 tokens=107` など）。続く `persona doctor` はインストールを検証し、運用上の穴を先回りして指摘します。

**4. ターンを解決する。** 実運用ではアダプタが毎メッセージ行いますが、ここでは手で実行します。マッチするコンテキストには有効なモードのブロックが返ります:

```sh
echo '{"ctx":{"platform":"slack","session_key":"owner-main"},"actor":"owner","utterance":"hello"}' \
  | persona turn --stdin-json
```

```json
{
  "mode": "focus",
  "block": "<persona-mode id=\"focus\" pack=\"starter-pack@0.1.0\">\nWork only on the requested task. ...",
  "route_id": "local-workspace",
  "state_domain": "workspace",
  "transitioned": false
}
```

どのルートにもマッチしないコンテキストには空の `public` モードが返り、切替の試みは無視されたうえでログに記録されます:

```sh
echo '{"ctx":{"platform":"slack","session_key":"public-channel-123"},"actor":"unknown","utterance":"switch to focus"}' \
  | persona turn --stdin-json
```

```json
{
  "mode": "public",
  "block": "",
  "route_id": "__default__",
  "state_domain": "quarantine",
  "transitioned": false,
  "audit": [{ "event": "route_unresolved", "route_id": "__default__", "domain": "quarantine" }]
}
```

**5. モードを切り替える。** 信頼されたルート上では、（`aliases.yml` に宣言した）全文一致エイリアスがターンの一部としてモードを切り替えます:

```sh
echo '{"ctx":{"platform":"slack","session_key":"owner-main"},"actor":"owner","utterance":"switch to casual"}' \
  | persona turn --stdin-json
```

結果には新しい `casual` ブロックと、`mode_transition` 監査イベント（`from: focus, to: casual, set_by: owner`）が含まれます。管理者による切替はターンを介さず CLI から行えます:

```sh
persona set professional --domain workspace
persona get --domain workspace
persona audit
```

```text
Audit events (newest first):
  2026-07-16T17:31:35Z mode_transition route=local-workspace domain=workspace from=focus to=casual set_by=owner
  2026-07-16T17:30:43Z mode_transition route=__admin__ domain=workspace from=public to=focus set_by=admin
```

**6. アダプタを配線する。** 手動ではなく実際のエージェントの中で動かすには、アダプタをインストールに向けます。Claude Code の場合はプロジェクトレベルのフックで、完全な `settings.json` スニペットは [Claude Code アダプタ README](adapters/claude-code/README.md) にあります。[Hermes](adapters/hermes/README.md) と [OpenClaw](adapters/openclaw/README.md) も同じパターンです。

## ユースケース

- **家族や友達のように話せる長期コンパニオン。** 毎日話す相手としてのエージェントに、作業・雑談・遊びで別の顔と気持ちの動きを持たせる。声と感情の機微はカタログ（語彙・応答例）で少しずつ育てられ、pack はバージョン管理の中で関係と一緒に深まっていきます。
- **VTuber・音声エージェントのキャラクター運用。** 配信や会話ではキャラクターとして温かみを持って、運用作業では素のオペレーターモードで。`voice_hint` は音声合成（TTS）や表情制御へのヒントとしてランタイムに渡り、配信用と管理用のサーフェスはルートで分離できます。
- **1 つのアシスタントを複数の場所で。** プライベートな作業セッションでは集中して簡潔に、雑談ではリラックス、未知のサーフェスでは厳密に中立（`public`）— 慣習ではなくルートポリシーが強制します。
- **安全なロールプレイ・キャラクターモード。** 重めのペルソナ内容は `owner_verified: true` かつ明示切替のルートに閉じ込めます。ルートにマッチしないサーフェスからは、見ることも起動することもできません。
- **レビューできるペルソナ変更。** pack はファイルです: ペルソナ変更はバージョン管理の diff として届き、予算はビルド時に強制され、監査ログが「いつ・どこで・何が有効で・誰が切り替えたか」に答えます。

## 切替モデル

切替パスは 3 つあり、すべての遷移が監査ログに記録されます。

1. **明示（Explicit）** — 発話全文のエイリアス一致（例:「switch to focus」）。`switching` レベルが explicit 以上のルートでのみ有効。
2. **エージェント起点（Agent-initiated）** — `persona_set` ツール。`switching: explicit-and-agent` かつ `owner_verified: true` のルートでのみ登録されます。
3. **管理者（Admin）** — CLI からの `persona set <mode> --domain <domain>`。

モードを追加するには、`pack/modes/*.yml` を新規に置いて `persona build` を再実行します。`{{agent-name}}` / `{{owner-name}}` のようなプレースホルダは `install.yml` の宣言から解決され、未解決のプレースホルダは `E_PLACEHOLDER_UNRESOLVED` でビルドを停止します。ベースの人格モードを 1 つ定義し、感情バリエーションが差分だけを `extends` で継承する構成も組めます（[SPEC.md](SPEC.md) §2.3）。

## ルートポリシー

ルートはセキュリティ境界です。各ルートは信頼できるランタイムメタデータにマッチし、そこで何を許可するかを宣言します:

- `match` — アダプタが提供するコンテキストへの条件（プラットフォーム、セッションキーの前方一致など）。マッチングは信頼できるメタデータのみを使い、メッセージ内容は決して使いません。
- `allowed_modes` — このサーフェスに表示してよいモード。`public` はどこでも暗黙に許可されます。
- `switching` — `deny` / `explicit` / `explicit-and-agent`: ここで有効になる切替パス。
- `owner_verified` — エージェント起点の切替に必須。ランタイムが本当にオーナーを認証できるサーフェスでのみ宣言してください。
- `state_domain` — 同じドメインを共有するサーフェスは有効モードを共有し、別ドメインは分離されます。

どのルートにもマッチしないコンテキストは `default_route` を使います — fail-closed の `public` で、独立した隔離用状態ドメインを持ちます。切替を有効にする前にルートを設定し、共有・グループのサーフェスは保守的に保ってください。完全な契約は [SPEC.md](SPEC.md) §6 を参照。

## CLI リファレンス

| コマンド | 内容 |
| --- | --- |
| `persona init <dir>` | 新しいインストールの雛形を生成（対話式・`--yes` でデフォルト） |
| `persona build` | pack を決定的なランタイム成果物にコンパイル |
| `persona doctor` | インストールを検証し issues / warnings / notes を報告 |
| `persona list` | ランタイムから見えるコンパイル済みモードとルートを表示 |
| `persona get --domain <d>` | 状態ドメインの有効モードとリビジョンを表示 |
| `persona set <mode> --domain <d>` | 管理者によるモード切替 |
| `persona turn --stdin-json` | JSON コンテキストから 1 ターンを解決（アダプタが呼ぶもの） |
| `persona audit` | 監査イベントを新しい順に表示 |

ほとんどのコマンドは `--dir <install>` でカレント外のインストールを対象にできます。完全なフォーマット・ポリシー契約は [SPEC.md](SPEC.md) を参照。

## アダプタ

| アダプタ | ランタイム | 注入ポイント |
| --- | --- | --- |
| [Claude Code](adapters/claude-code/README.md) | Claude Code | `UserPromptSubmit` / `SessionStart` フック |
| [Hermes](adapters/hermes/README.md) | Hermes エージェント | ターンごとのコンテキスト注入 |
| [OpenClaw](adapters/openclaw/README.md) | OpenClaw エージェント | ターンごとのコンテキスト注入 |

アダプタは意図的に薄く作られています: 信頼できるランタイムメタデータからルートコンテキストを導出し、コアを呼び、返ってきたブロックを注入し、エラー時は安全側（注入なし）に倒す。別のランタイムに対応するには [SPEC.md](SPEC.md) §10 のアダプタ契約を実装してください。

## セキュリティモデル

- **pack は信頼されたオペレータ資産です。** エンジンが守るのは「ペルソナ内容が誤ったサーフェスに出ること」であり、悪意ある pack 作者をサンドボックス化するものではありません。pack はコードと同様にレビューしてください。
- **構造として fail-closed。** 未知のルートは空の `public` モードに解決され、切替できません。アダプタのエラーは「注入なし」に縮退し、古い・誤ったペルソナには決して落ちません。
- **ディスク上は平文。** コンパイル済みブロックとプレースホルダ値は `build/` に平文で置かれます。認証情報やその他の秘密をプレースホルダや pack 内容に入れないでください。
- **状態はローカルに留まります。** 有効モードの状態は注入ホスト上にあり、マシン間で同期されません。
- **すべての判断は観測可能。** 遷移・拒否・未解決ルートは追記専用の監査イベントです。

脅威モデルと脆弱性の報告方法は [SECURITY.md](SECURITY.md) を参照。

## FAQ

<details>
<summary><b>エージェントの元の人格を書き換えてしまいませんか？</b></summary>

書き換えません。エンジンがやるのは会話ごとの「追記」だけで、エージェント本体の人格設定（system prompt 等）には触れません。モードには感情・反応・語彙の差分だけを書くのが基本形で、モードを外せば（`public` に落ちれば）エージェントは完全に素の状態に戻ります。

</details>

<details>
<summary><b>エンジンは感情やトーンをどう扱いますか？</b></summary>

エンジン自身は解釈しません。感情の幅とそのグラデーションを作るのは pack 側 — セクションとカタログに書き込む声・語彙・応答例 — で、エンジンの仕事はそれを「正しい場面にだけ、安全に」届けることです。`voice_hint` は音声合成や表情制御などランタイム側へのヒントとしてそのまま渡されます。

</details>

<details>
<summary><b>persona-engine は LLM を呼びますか？ API キーは必要？</b></summary>

いいえ。エンジンはペルソナブロックをコンパイルして提供するだけで、モデルと通信するのはあなたのランタイムです。構造的にプロバイダ非依存です。

</details>

<details>
<summary><b>設定していないコンテキストではどうなりますか？</b></summary>

どのルートにもマッチせず、空の `public` モードに解決され、切替もできません。fail-closed は有効化するオプションではなく、デフォルトです。

</details>

<details>
<summary><b>エージェントが自分でペルソナを切り替えられますか？</b></summary>

`switching: explicit-and-agent` **かつ** `owner_verified: true` を宣言したルート上で、そのルートの `allowed_modes` の範囲でのみ可能です。それ以外の場所では `persona_set` ツール自体が登録されません。

</details>

<details>
<summary><b>状態はどこに保存されますか？ マシン間で同期されますか？</b></summary>

インストール内の `state/<domain>.json` に、注入ホスト上で保存されます。同期は行われず、各ホストが独立に解決します。

</details>

<details>
<summary><b>pack やプレースホルダに秘密情報を入れてもいいですか？</b></summary>

いけません。コンパイル成果物はディスク上に平文で置かれます。pack の内容はコミットされるソースファイルと同じ扱いにしてください。

</details>

<details>
<summary><b>モードの追加・変更はどうやりますか？</b></summary>

`pack/modes/<id>.yml` を追加・編集して `persona build` を再実行します。予算・参照・プレースホルダはビルド時に検証され、ランタイムが見るのは常にコンパイル済みの結果だけです。

</details>

<details>
<summary><b>トークンコストはどう管理されますか？</b></summary>

各モードには実効予算があります — install の予算とモード自身の `budget_tokens` の小さい方です。超過は切り捨てではなくビルドエラーなので、肥大化したペルソナはランタイムに届く前に捕捉されます。

</details>

<details>
<summary><b>対応ランタイムは？</b></summary>

現在 Claude Code・Hermes・OpenClaw です。アダプタ契約（[SPEC.md](SPEC.md) §10）は小さく、コンテキストを導出してコアを呼び、ブロックを 1 つ注入するだけです。

</details>

## ドキュメント

| ドキュメント | 内容 |
| --- | --- |
| [SPEC.md](SPEC.md) | 凍結済みのフォーマット・ポリシー契約: pack スキーマ、ルートポリシー、turn/set、fail-closed 規則 |
| [docs/INSTALL.md](docs/INSTALL.md) | インストールガイド |
| [docs/customizing.md](docs/customizing.md) | カスタマイズガイド: モードの追加方法・語彙テンプレート（カタログ）の書き方とルール |
| [templates/pack-starter/README.md](templates/pack-starter/README.md) | starter pack の解剖: 封筒・カタログ・予算・ルート |
| [adapters/*/README.md](adapters/) | ランタイム別のセットアップと設定 |
| [SECURITY.md](SECURITY.md) | 脅威モデルと脆弱性報告 |
| [CONTRIBUTING.md](CONTRIBUTING.md) | コントリビュートガイド |

## 開発

```sh
git clone https://github.com/caty-ai/persona-engine.git
cd persona-engine
npm install
npm test
npm run typecheck
python3 -m pytest adapters
```

ソースチェックアウトでは CLI は `packages/core/bin/persona` です（alias を張るか、アダプタには `PERSONA_BIN` を設定）。`spec/fixtures/` 配下の共有フィクスチャが、TypeScript コアと Python アダプタを同一のランタイム契約に対して検証します。

## ロードマップ

- [x] M0 — ランタイム spike + SPEC 凍結
- [x] M1 — コア（コンパイラ / ポリシー / 状態 / turn / CLI）
- [x] M2 — Hermes アダプタ + doctor + 最初の本番エージェント配備
- [x] M3 — OpenClaw アダプタ + 観測 CLI（get / list / audit）+ voice coloring + エージェント起点切替
- [x] M4 — 公開リリース: npm パッケージング + init ウィザード + starter pack テンプレート + Claude Code アダプタ + ライセンス・セキュリティゲート

v0.1.0 が最初の公開リリースです。Issue や提案を歓迎します — [コントリビュート](#コントリビュート)を参照。

## コントリビュート

[CONTRIBUTING.md](CONTRIBUTING.md) を参照してください。セキュリティ脆弱性は [SECURITY.md](SECURITY.md) の手順に従い、非公開で報告してください。

## ライセンス

MIT © Caty. [LICENSE](LICENSE) を参照。
