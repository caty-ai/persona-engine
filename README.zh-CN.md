# persona-engine

[English](README.md) | [日本語](README.ja.md) | **简体中文** | [ไทย](README.th.md)

> 本文档的权威版本为英文版（README.md）。翻译版本跟随英文版更新，内容可能略有滞后。

<div align="center">

![persona-engine — 让 AI 智能体在每个时刻都有合适的表情](docs/assets/hero.jpg)

![npm](https://img.shields.io/npm/v/%40persona-engine%2Fcore) ![CI](https://github.com/caty-ai/persona-engine/actions/workflows/ci.yml/badge.svg) ![node](https://img.shields.io/badge/node-%3E%3D22-brightgreen) ![license](https://img.shields.io/badge/license-MIT-blue)

</div>

persona-engine 让 AI 智能体在不同场景拥有不同的"表情"。工作时是可靠搭档的样子，闲聊时是亲近朋友的样子，直播时是角色的样子——**原有的人格保持不变**，只是安全地为它加上情感的幅度和场景化的反应。

## persona-engine 能做什么

- **表情和语气随场景变化。** 工作场合简短可靠，私下亲近如挚友或伴侣，闲聊时轻松柔和——同一个智能体，每个时刻都有合适的面孔。
- **像人一样自然地切换。** 换脸有三种方式：① 按场所自动切换（引擎根据对话发生的地方，每一轮自动选择合适的面孔）；② 智能体自行判断（只在你允许的地方，它读懂对话的走向自己切换）；③ 你的一句话（"switch to focus"）。
- **在不该展现个性的地方，保证换上得体的面孔。** 公司会议、公开频道，或任何未配置过的地方，智能体自动回到中立状态。私下的语气泄漏到公开场合，被机制本身而非约定所阻止。
- **原有人格从不被改写。** persona-engine 做的只是在每轮对话上轻轻叠加一层合适的表情。摘掉模式，智能体立刻恢复原本的自己。
- **每次切换都有完整记录。** 谁在哪里、何时换成了哪张面孔——"昨天那段对话是哪个模式？"永远有答案。
- **表情和词汇都可以按你的喜好培养。** 表情是**模式**，用词是**词汇目录**——都是普通文本文件。复制、编辑、添加，仅此而已。

## 内核很简单——模式与词汇目录

自动切换的背后只有两种零件。每张面孔是一个**模式**——一个小小的定义文件；用词、口头禅和示例回应放在**词汇目录**里——模式引用的普通文本文件。添加文件，智能体的表情就增多；编辑文件，声音就贴近你的喜好。"哪张面孔可以出现在哪里、谁可以切换"作为规则（路由策略）单独决定——所以增加表情不会削弱安全。

如何添加模式、如何编写词汇目录的规则，都汇总在[定制指南](docs/customizing.md)里。

## 我们最珍视的一点——人格从不被改写

> [!IMPORTANT]
> persona-engine 不是从零构建人格的工具。它的存在是为了**尊重已经在那里的智能体，在其之上叠加情感**。

- 智能体自身的人格定义——名字、性格、默认的说话方式——从不被触碰。
- 模式添加的只是**差异**：专注时的反应方式、轻松场合的词汇、声音明亮几分。
- 这一层按对话轮叠加，摘掉后不留痕迹。智能体随时可以回到素颜。
- 也支持定义完整角色（比如 VTuber 的舞台人格）——即便如此，那也是换装，不是改造。

## 我们为什么做这个

出发点不是技术问题，而是一个愿望：**希望与 AI 智能体相处，像与家人、与朋友、与人相处一样。**

人与人的对话里有细微的情感渐变。有好消息时声音会亮起来；专注时话会变短；说话的方式随对象和时刻悄悄变化。一起工作，事情成了一起高兴，为无聊的小事一起笑——关系正是在这些细小的情感流动中变深的。

我们相信 AI 也能像人一样承载表达。智能体越是成为每天陪在你身边的存在，这种幅度就越不是装饰，而是核心。永远用同一种平板语气回应的对象，无法与之建立深的关系。要让智能体拥有人的温度、能贴近人，就需要一个能让情感及其流动自然流露的容器——persona-engine 就是那个容器。

但给了智能体这种幅度的那一刻，新的担忧也随之而来。轻松的语气出现在公开场合怎么办？没人知道是谁在何时切换的怎么办？persona-engine 正是为了同时守住两者——幅度与安全——而存在的。详细对比见[为什么选择 persona-engine？（技术篇）](#为什么选择-persona-engine技术篇)。

## 快速上手

![演示: 一个智能体，四张面孔——解析轮次、一句话切换、fail-closed 的 public 模式、审计日志](docs/assets/demo.gif)

你只需要 [Node.js](https://nodejs.org/)（22 或更高版本）。在终端运行这四行：

```sh
npm install -g @persona-engine/core

persona init ./my-persona
cd my-persona
persona build
```

这会创建一个含有一个模式的最小文件夹。打开 `pack/modes/default.yml`，写下你想加给智能体的话，再次运行 `persona build` 即可生效。

接下来去哪里：

- **先看点能跑的** → [完整示例](#完整示例)——端到端运行内置的四模式包：定义、构建、切换、审计。
- **接入你的智能体** → [适配器](#适配器)——如何接入 Claude Code 等运行时。
- **了解内部机制** → 继续往下读。

---

以下是技术层，面向要把 persona-engine 接入智能体的人。

## 工作原理

![架构: pack (YAML) → persona build → 编译块+策略 → 适配器 → LLM 运行时，state 与 audit 留存记录](docs/assets/architecture.svg)

模式（表情）的定义写在一组 YAML 文件里——即 **pack**。`persona build` 把它一次性编译成定稿的块，**适配器**在每轮对话中把"适合此刻的块"注入智能体的运行时。哪个模式允许出现在哪里——以及谁可以切换——由显式的**路由策略**决定，且每次切换都记录到只追加的审计日志中。

| 组件 | 职责 |
| --- | --- |
| [packages/core](packages/core/) | TypeScript 引擎：pack 编译器、路由策略、状态存储、turn/set 契约、`persona` CLI |
| [adapters/claude-code](adapters/claude-code/) | 向 Claude Code 会话注入当前块的 Python 钩子 |
| [adapters/hermes](adapters/hermes/) | 面向 Hermes 系智能体运行时的适配器 |
| [adapters/openclaw](adapters/openclaw/) | 面向 OpenClaw 系智能体运行时的适配器 |
| [templates/pack-starter](templates/pack-starter/) | 可直接复制修改的完整四模式示例 pack |
| [SPEC.md](SPEC.md) | 所有实现共同遵循的冻结格式与策略契约 |

贯穿始终的三条设计原则：

- **编译，而非解释。** 运行时只读取确定性的构建产物；模式激活期间块保持逐字节不变。
- **Fail-closed。** 未匹配任何路由的上下文解析为空的 `public` 模式且无法切换。出错时降级为"不注入"，绝不落到"错误的人格"。
- **载荷不透明。** 引擎管理结构、引用、预算和顺序，从不解析或改写你的人格文本——因此"人格从不被改写"在结构上成立。

## 为什么选择 persona-engine？（技术篇）

与自己动手实现人格切换——在应用代码里替换 system prompt 字符串——相比：

| | 手写提示词切换 | persona-engine |
| --- | --- | --- |
| 人格文本的位置 | 散落在应用代码中的字符串 | 版本管理的 YAML pack，一次编译 |
| 谁可以切换 | 任何能改提示词的代码路径 | 路由策略：按场景的允许列表和切换级别 |
| 未知 / 未匹配的上下文 | 恰好处于激活状态的那个 | fail-closed：空的 `public` 模式，禁止切换 |
| 提示词大小 | 无限制、悄悄膨胀 | 每个模式有 token 预算——超出是构建错误而非截断 |
| 可追溯性 | 无 | 只追加的审计日志记录每次切换和策略决定 |
| 稳定性 | 随时可能被改动 | 模式激活期间，编译块保持逐字节不变 |

引擎从不调用 LLM，也从不解释你的人格文本。它管理的是结构、引用、预算、顺序和策略——内容始终属于你，并保持不透明。

## 目录

- [完整示例](#完整示例)
- [使用场景](#使用场景)
- [切换模型](#切换模型)
- [路由策略](#路由策略)
- [CLI 参考](#cli-参考)
- [适配器](#适配器)
- [安全模型](#安全模型)
- [FAQ](#faq)
- [文档](#文档)
- [开发](#开发)
- [路线图](#路线图)

## 完整示例

仓库在 [templates/pack-starter/](templates/pack-starter/) 中附带了一个完整的四模式 pack——`focus`、`casual`、`professional`，以及仅有骨架的 `roleplay-template`。我们端到端走一遍：定义模式、声明策略、构建、解析轮次、切换、审计。

```sh
git clone https://github.com/caty-ai/persona-engine.git
cp -R persona-engine/templates/pack-starter ./starter-demo
cd starter-demo
mv install.example.yml install.yml
```

**1. 模式是一个小的 YAML 信封。** 这是 `modes/focus.yml` 的全文：

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

注意它包含的内容：只有专注状态下这张面孔如何反应——从不定义智能体是谁。人格留在基座一侧；模式叠加的是差异。sections 是有序且不透明的——编译器从不解释其中的文本。较大的素材（词汇表、示例对话）放在模式引用的 `catalogs/*.txt` 文件中；starter 中的 `casual` 模式展示了接线方式。

**2. 路由和占位符放在 `install.yml`，** 而不是 pack 里。pack 描述"模式包含什么"，install 描述"允许出现在哪里"：

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

只有会话键以 `owner-` 开头的 Slack 会话才能匹配这条宽松路由，其余一切都落入 fail-closed 的默认路由。

**3. 构建与检查。**

```sh
persona build
persona doctor
```

构建把每个模式编译成带哈希的块并报告其大小（如 `focus: bytes=320 tokens=107`）。随后 `persona doctor` 验证安装，并在运维隐患造成影响之前提前指出。

**4. 解析一轮对话。** 实际使用中适配器会在每条消息上自动完成；这里我们手动执行。匹配的上下文会得到当前模式的块：

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

未匹配任何路由的上下文得到空的 `public` 模式——其切换请求被忽略并记录在案：

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

**5. 切换模式。** 在受信任的路由上，（在 `aliases.yml` 中声明的）全句别名会在轮次中完成模式切换：

```sh
echo '{"ctx":{"platform":"slack","session_key":"owner-main"},"actor":"owner","utterance":"switch to casual"}' \
  | persona turn --stdin-json
```

结果包含新的 `casual` 块和一条 `mode_transition` 审计事件（`from: focus, to: casual, set_by: owner`）。管理员切换不经过轮次，直接用 CLI：

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

**6. 接入适配器。** 要在真实的智能体内运行而不是手动执行，把适配器指向这个安装即可。对 Claude Code 来说是一个项目级钩子——完整的 `settings.json` 片段见 [Claude Code 适配器 README](adapters/claude-code/README.md)；[Hermes](adapters/hermes/README.md) 和 [OpenClaw](adapters/openclaw/README.md) 在各自的运行时上遵循相同模式。

## 使用场景

- **像家人和挚友一样交谈的长期伙伴。** 给每天与你对话的智能体不同的面孔和情感流动——工作、闲聊、玩耍各有其貌。声音与情感的细腻处通过目录（词汇、示例回应）逐渐培养，pack 在版本管理中随关系一起变深。
- **VTuber / 语音智能体的角色运营。** 直播和对话中带着温度以角色示人，维护工作时切回朴素的操作员模式。`voice_hint` 作为语音合成（TTS）和表情控制的提示传给运行时，直播场景与管理场景由路由分离。
- **一个助手，多个场景。** 在私人工作会话中专注简洁，闲聊时轻松随和，在所有未识别的场景中严格中立（`public`）——由路由策略强制执行，而非靠约定。
- **安全的角色扮演 / 角色模式。** 把较重的人格内容限制在 `owner_verified: true` 且显式切换的路由上。不匹配该路由的场景既看不到它，也无法激活它。
- **可审查的人格变更。** pack 就是文件：人格变更以版本管理中的 diff 形式出现，预算在构建时强制执行，审计日志可以回答"何时、何地、哪个模式激活、谁切换的"。

## 切换模型

共有三条切换路径；每次切换都记录在审计日志中。

1. **显式（Explicit）** — 全句别名匹配（例如 "switch to focus"）。仅在 `switching` 级别为 explicit 或更高的路由上生效。
2. **智能体发起（Agent-initiated）** — `persona_set` 工具。仅在 `switching: explicit-and-agent` 且 `owner_verified: true` 的路由上注册。
3. **管理员（Admin）** — 通过 CLI 执行 `persona set <mode> --domain <domain>`。

要添加模式，放入新的 `pack/modes/*.yml` 文件并重新运行 `persona build`。`{{agent-name}}` / `{{owner-name}}` 等占位符从 `install.yml` 的声明中解析；未解析的占位符会以 `E_PLACEHOLDER_UNRESOLVED` 中止构建。也可以定义一个基础人格模式，让情感变体通过 `extends` 只继承差异部分（[SPEC.md](SPEC.md) §2.3）。

## 路由策略

路由是安全边界。每条路由匹配可信的运行时元数据，并声明该处允许的行为：

- `match` — 对适配器提供的上下文的条件（平台、会话键前缀等）。匹配只使用可信元数据，绝不使用消息内容。
- `allowed_modes` — 该场景允许展示的模式。`public` 在任何地方都被隐式允许。
- `switching` — `deny` / `explicit` / `explicit-and-agent`：此处启用哪些切换路径。
- `owner_verified` — 智能体发起切换的必要条件；只在运行时能真正认证所有者的场景上声明。
- `state_domain` — 共享同一域的场景共享激活模式；不同的域相互隔离。

未匹配任何路由的上下文使用 `default_route`——fail-closed 的 `public`，并拥有独立的隔离状态域。请先配置路由再启用切换，并让共享 / 群组场景保持保守。完整契约见 [SPEC.md](SPEC.md) §6。

## CLI 参考

| 命令 | 作用 |
| --- | --- |
| `persona init <dir>` | 生成新安装的脚手架（交互式，或用 `--yes` 取默认值） |
| `persona build` | 把 pack 编译为确定性的运行时产物 |
| `persona doctor` | 验证安装并报告 issues / warnings / notes |
| `persona list` | 展示运行时视角下的已编译模式与路由 |
| `persona get --domain <d>` | 显示某状态域的激活模式与修订号 |
| `persona set <mode> --domain <d>` | 管理员模式切换 |
| `persona turn --stdin-json` | 从 JSON 上下文解析一轮对话（适配器调用的接口） |
| `persona audit` | 按时间倒序打印审计事件 |

大多数命令接受 `--dir <install>` 以指向当前目录之外的安装。完整的格式与策略契约见 [SPEC.md](SPEC.md)。

## 适配器

| 适配器 | 运行时 | 注入点 |
| --- | --- | --- |
| [Claude Code](adapters/claude-code/README.md) | Claude Code | `UserPromptSubmit` / `SessionStart` 钩子 |
| [Hermes](adapters/hermes/README.md) | Hermes 智能体 | 每轮上下文注入 |
| [OpenClaw](adapters/openclaw/README.md) | OpenClaw 智能体 | 每轮上下文注入 |

适配器刻意保持轻薄：从可信运行时元数据推导路由上下文，调用核心，注入返回的块，出错时安全降级（不注入）。要支持其他运行时，请实现 [SPEC.md](SPEC.md) §10 中的适配器契约。

## 安全模型

- **pack 是受信任的运营者资产。** 引擎防范的是"人格内容出现在错误的场景"，而不是沙箱化恶意的 pack 作者。请像审查代码一样审查 pack。
- **结构性 fail-closed。** 未知路由解析为空的 `public` 模式且无法切换。适配器错误降级为"不注入"——绝不会是过期或错误的人格。
- **磁盘上是明文。** 编译块和占位符值以明文形式存放在 `build/` 中。绝不要把凭据或其他机密放进占位符或 pack 内容。
- **状态保留在本地。** 激活模式的状态位于注入主机上，不在机器之间同步。
- **每个决定都可观测。** 切换、拒绝和未解析路由都是只追加的审计事件。

威胁模型与漏洞报告方式见 [SECURITY.md](SECURITY.md)。

## FAQ

<details>
<summary><b>它会改写我的智能体原有的人格吗？</b></summary>

不会。引擎只做每轮的追加，从不触碰智能体自身的人格定义（system prompt 等）。模式的本意是差异——情感、反应、词汇——而不是身份。摘掉模式（落回 `public`），智能体就完全回到素颜。

</details>

<details>
<summary><b>引擎如何处理情感和语气？</b></summary>

它不解释这些。情感的幅度及其渐变是在 pack 一侧构成的——你写进 sections 和目录的声音、词汇、示例回应——引擎的工作是把它们安全地、只送到正确的场合。`voice_hint` 原样传给运行时一侧（TTS、表情控制）作为提示。

</details>

<details>
<summary><b>persona-engine 会调用 LLM 吗？需要 API 密钥吗？</b></summary>

不会。它只编译并提供人格块；与模型通信的是你的运行时。引擎在结构上与提供商无关。

</details>

<details>
<summary><b>在从未配置过的上下文中会发生什么？</b></summary>

它不匹配任何路由，解析为空的 `public` 模式，且无法切换。fail-closed 是默认行为，不是需要开启的选项。

</details>

<details>
<summary><b>智能体可以自行决定切换人格吗？</b></summary>

只有在声明了 `switching: explicit-and-agent` **且** `owner_verified: true` 的路由上，并且只能在该路由的 `allowed_modes` 范围内。在其他任何地方，`persona_set` 工具根本不会被注册。

</details>

<details>
<summary><b>状态存储在哪里？会在机器之间同步吗？</b></summary>

存储在安装目录内的 `state/<domain>.json`，位于注入主机上。不做任何同步；每台主机独立解析。

</details>

<details>
<summary><b>可以把机密放进 pack 或占位符吗？</b></summary>

不可以。编译产物在磁盘上是明文。请把 pack 内容当作任何会被提交的源码文件对待。

</details>

<details>
<summary><b>如何添加或修改模式？</b></summary>

添加或编辑 `pack/modes/<id>.yml`，重新运行 `persona build`。预算、引用和占位符都在构建时验证；运行时只会看到编译结果。参见[定制指南](docs/customizing.md)。

</details>

<details>
<summary><b>token 成本如何控制？</b></summary>

每个模式都有生效预算——取 install 预算与模式自身 `budget_tokens` 中较小者。超出是构建错误而非截断，因此过大的人格在到达运行时之前就会被拦下。

</details>

<details>
<summary><b>支持哪些运行时？</b></summary>

目前是 Claude Code、Hermes 和 OpenClaw。适配器契约（[SPEC.md](SPEC.md) §10）很小——推导上下文、调用核心、注入一个块。

</details>

## 文档

| 文档 | 内容 |
| --- | --- |
| [SPEC.md](SPEC.md) | 冻结的格式与策略契约：pack 模式、路由策略、turn/set、fail-closed 规则 |
| [docs/INSTALL.md](docs/INSTALL.md) | 安装指南 |
| [docs/customizing.md](docs/customizing.md) | 定制指南：添加模式的方法、编写词汇目录的规则 |
| [templates/pack-starter/README.md](templates/pack-starter/README.md) | starter pack 解析：信封、目录、预算、路由 |
| [adapters/*/README.md](adapters/) | 各运行时的安装与配置 |
| [SECURITY.md](SECURITY.md) | 威胁模型与漏洞报告 |
| [CONTRIBUTING.md](CONTRIBUTING.md) | 贡献指南 |

## 开发

```sh
git clone https://github.com/caty-ai/persona-engine.git
cd persona-engine
npm install
npm test
npm run typecheck
python3 -m pytest adapters
```

对源码检出而言，CLI 位于 `packages/core/bin/persona`（可以设置别名，或为适配器设置 `PERSONA_BIN`）。`spec/fixtures/` 下的共享夹具用同一份运行时契约同时验证 TypeScript 核心与 Python 适配器。

## 路线图

- [x] M0 — 运行时 spike + SPEC 冻结
- [x] M1 — 核心（编译器 / 策略 / 状态 / turn / CLI）
- [x] M2 — Hermes 适配器 + doctor + 首个生产智能体部署
- [x] M3 — OpenClaw 适配器 + 可观测 CLI（get / list / audit）+ voice coloring + 智能体发起切换
- [x] M4 — 公开发布：npm 打包 + init 向导 + starter pack 模板 + Claude Code 适配器 + 许可与安全闸门

v0.1.0 是首个公开版本。欢迎提交 Issue 与建议——见[贡献](#贡献)。

## 贡献

见 [CONTRIBUTING.md](CONTRIBUTING.md)。安全漏洞请按 [SECURITY.md](SECURITY.md) 中的说明私下报告。

## 许可证

MIT © Caty. 见 [LICENSE](LICENSE)。
