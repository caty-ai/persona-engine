# persona-engine

![status](https://img.shields.io/badge/status-pre--release-orange)
![node](https://img.shields.io/badge/node-%3E%3D22-brightgreen)
![license](https://img.shields.io/badge/license-MIT-blue)

## 概要

persona-engine は、LLM エージェントで人格モードを安全に切り替えるための policy 駆動エンジンです。YAML で pack を定義し、一度コンパイルしてから、ランタイムアダプタで turn ごとに完成ブロックを注入します。

## 特徴

- ランタイムは YAML ではなくコンパイル済み成果物だけを読みます。
- 未知の route は空の `public` モードへ解決され、切替できません。
- エンジンはコンテンツの意味を解釈せず、構造・参照・予算・順序だけを扱います。
- 明示切替、エージェント切替、CLI 操作はすべて core の policy 評価を通ります。
- 同じモードが有効な間、コンパイル済みブロックはバイト列として不変です。

## アーキテクチャ

```text
pack/ (YAML) -> persona build -> build/ (完成ブロック + policy) -> adapter -> LLM runtime
```

アダプタは信頼できるランタイムメタデータから route context を導出し、core にブロック解決を依頼して、ランタイムの request-scoped 拡張ポイントへそのまま注入します。

## クイックスタート

Node.js 22 以上が必要です。

```sh
git clone https://github.com/caty-ai/persona-engine.git
cd persona-engine
npm install
alias persona="$PWD/packages/core/bin/persona"
persona init ./my-persona
```

## Pack の作成と build

starter pack を作成してから、コンパイル済み成果物を build します。

```sh
cd my-persona
persona build
persona doctor
```

## Starter pack

汎用的な 4 モードの v2 pack は [templates/pack-starter/](templates/pack-starter/) にある。コピーして `install.example.yml` を `install.yml` にし、pack 名・placeholder・route policy を用途に合わせて編集してから `persona build` / `persona doctor` を実行する。

## 使い方（切替の3経路）

モードの切替経路は 3 つ。どれも audit ログに記録される。

1. **明示切替（explicit）** — 発話全文一致のエイリアス（例: 「(モード名)にして」）。route の `switching` が explicit 以上の面でだけ有効
2. **エージェント自発（agent）** — `persona_set` tool。`switching: explicit-and-agent` かつ `owner_verified: true` の route のみに登録される
3. **管理操作（admin）** — `persona set <mode> --domain <domain>`（CLI）

モードを増やすには `pack/modes/*.yml` を追加して `persona build` し直す。`{{agent-name}}` / `{{owner-name}}` などのプレースホルダーは `install.yml` の宣言で解決され、未解決があれば build が `E_PLACEHOLDER_UNRESOLVED` で止まる。

## Route policy の設定

install 設定では pack、runtime、routes、placeholders、audit の場所を選びます。切替を有効にする前に routes を設定してください。共有・グループサーフェスでは特に保守的な設定が必要です。

## CLI

```sh
persona build
persona list
persona get --domain default
persona set public --domain default
persona audit
```

完全なフォーマットと policy 契約は [SPEC.md](SPEC.md) を参照してください。

## アダプタ

- [Claude Code](adapters/claude-code/README.md)
- [Hermes](adapters/hermes/README.md)
- [OpenClaw](adapters/openclaw/README.md)

## 安全上の注意

pack は信頼できる運用者の資産として扱ってください。placeholders や pack の内容へ資格情報などの秘密を入れないでください。コンパイル済みブロックはディスク上で平文です。state は注入を行うホストに保持され、マシン間では同期されません。

## ドキュメント

- [設置ガイド](docs/INSTALL.md)
- [セキュリティポリシー](SECURITY.md)
- [コントリビュートガイド](CONTRIBUTING.md)

## 開発

```sh
npm install
npm test
npm run typecheck
python3 -m pytest adapters
```

`spec/fixtures/` の共有 fixture は、TypeScript core と Python adapter が同じ runtime 契約を満たすことを検証します。

## ロードマップ

- [x] M0 — ランタイム実機 spike + SPEC 確定
- [x] M1 — core（compiler / policy / state / turn / CLI）
- [x] M2 — Hermes アダプタ + doctor + 実運用エージェント 1 体へ配備
- [x] M3 — OpenClaw アダプタ + 観測 CLI（get / list / audit）+ 音声 coloring + エージェント自発切替
- [ ] M4 — 公開リリース: npm パッケージング + init ウィザード / starter pack テンプレート / Claude Code アダプタ / ライセンス・セキュリティゲート

## コントリビュート

[CONTRIBUTING.md](CONTRIBUTING.md) を参照してください。セキュリティ上の問題は [SECURITY.md](SECURITY.md) の手順に従い、非公開で報告してください。

## ライセンス

MIT © Caty。詳しくは [LICENSE](LICENSE) を参照してください。
