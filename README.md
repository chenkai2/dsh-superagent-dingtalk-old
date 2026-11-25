# dsh-superagent-dingtalk

> **非官方 fork。** 基于 DeepSeek 的 [dsh-superagent-prototype](https://github.com/deepseek-ai/dsh-superagent-prototype)（MIT，研究原型），只做加法：上游的 GitHub 与飞书 Source 原样保留，新增一个**钉钉** Source。

给 [DeepSeek Harness](https://www.deepseek.com/en/harness/) 加一条钉钉通道：在群里 @ 机器人派活，它自己开工作面、干活，再把结果以**机器人身份**发回原对话；需要你拍板时会发一条「需要你决定」，你回一句它就接着干。

```sh
dsh plugin --profile superagent add @chenkai114/dsh-superagent-dingtalk
```

装完在 `cordis.patch.yml` 里把 `dsh-superagent-dingtalk` 那行的 `disabled` 去掉，重启后到面板 **来源 → 钉钉** 填配置。详细步骤见 [docs/006-deployment.md](docs/006-deployment.md) 的 DingTalk 小节。

## 它解决的两个真问题

**读和写必须用不同身份。** 钉钉没有「机器人读群全量消息」的接口，但**操作者本人的 OAuth 身份**能读到自己在的群的全部消息；反过来，机器人只能收到 @ 它的消息，却能稳定发消息。所以：

- **读**：`dws` 以操作者身份轮询，拿到全量消息与历史；
- **写**：一律以**机器人身份**发出（`sessionWebhook`、群机器人 webhook、或 `dws ... send-by-bot`）。

结果是 agent 说的话永远署名机器人，不会冒充操作者。

**「谁在说话」有三个正交信号。** `sendType: user` + 无标记是真人；`sendType: user` + `messageAiSendFlag` 是工具借你的账号发的（客户端显示「通过AI发送」），必须跳过，否则 agent 会把自己上一轮的输出当成新指令；`sendType: robot` 是机器人。详见下文。

## 这个 fork 增加了什么

本仓库是 [dsh-superagent-prototype](https://github.com/deepseek-ai/dsh-superagent-prototype) 的 fork，只做加法：官方模板里的 GitHub 与飞书 Source 原样保留，新增一个 **钉钉** Source（`dsh-superagent/dingtalk-watch`）。

| 需求 | 实现 |
| --- | --- |
| 支持 dws 通道 | `dws chat message list` 以**操作者本人身份**读群消息，含没有 @ 机器人的消息与历史；轮询游标存在 KV 里，重启不丢 |
| 可设置 Stream 模式的钉钉机器人 | `streamClientId` / `streamClientSecret`，走官方 `dingtalk-stream` 长连接接收 `/v1.0/im/bot/messages/get` |
| 设置监听的群 | `groups` 每行一个 `openConversationId`，可选「仅 @」或「全部消息」；另有「其他群」与「接收私聊」开关 |
| 设置群 Bot 的 token + * | `bots` 每行一个自定义机器人（`access_token` + 可选的加签 *），只管发不管收 |
| 待决策消息反馈给用户 | 工单的 `attention` 问题渲染成「需要你决定」的结构化消息，正文末尾写明如何回复；用户回复即为该工单的新输入，执行器继续 |
| 优化消息展示样式 | 回复按用途分三种标题（需要你决定 / 工单结果 / 已收到），Markdown 渲染，超长自动截断并指向面板 |

### 为什么读和写用两种身份

钉钉没有「以机器人身份读取群全量消息」的接口，但**操作者的 OAuth 身份**能读到自己在的群的全部消息；反过来，机器人身份只能收到 @ 它的消息，却可以稳定地发消息。

所以这个 Source 把两件事拆开：

- **读**：`dws` 以操作者身份轮询，拿到全量消息与历史；
- **写**：一律以**机器人身份**发出（`sessionWebhook`、群机器人 webhook、或 `dws chat message send-by-bot`）。

结果是 agent 说的话永远署名机器人，不会冒充操作者。同理，读到 `sendType: robot` 的消息时它属于机器人，执行器会把它排除在「谁在派活」之外，避免把自己的输出当成新指令。

### 怎么分辨「谁在说话」

钉钉给了三个正交信号，合起来能唯一判定一条消息是谁发的：

| `sendType` | `messageAiSendFlag` | 含义 | 本 Source 的处理 |
| --- | --- | --- | --- |
| `user` | 无 | 真人打的字 | 人可以派活 |
| `user` | `DWS` | **工具通过操作者账号发的**（客户端显示「通过AI发送」） | 跳过：这是 agent 自己的输出，当输入会自激 |
| `robot` | — | 机器人发的 | 只能作为候选，永远不能单独授权工作 |

第二行是这套设计的关键。`dws chat message send` 以操作者身份发出，`sendType` 是 `user`，光看这个字段无法和自己的发言区分；钉钉用 `messageAiSendFlag` 补上了这层。所以：

- **本 Source 从不用 `dws chat message send`**，回复一律走机器人身份（`sendType: robot`）；
- 历史读取时，带 `messageAiSendFlag` 的消息**直接跳过**，避免把自己的话读成新指令；
- 实测限制：Stream 回调的报文里**没有**这个字段，只有 `dws chat message list` 有。所以 Stream 路径靠「本 Source 不发操作者消息」来保证；轮询路径有结构化的双重保护。

### 打开它

钉钉 Source 在 bundle 里默认 `disabled: true`。启用方式：

1. 在 profile 的 `cordis.patch.yml` 里把 `dsh-superagent-dingtalk` 那一行的 `disabled` 去掉；
2. 重启 `dsh-superagent`，打开面板 → **来源 → 钉钉**；
3. 填 `dws 命令`（通常是 `dws` 或包装脚本的绝对路径），至少填一个群；
4. 二选一配收件：Stream 机器人（实时、只收 @）或群机器人 webhook（只发）；
5. 在**策略**里把能派活的钉钉账号（staffId 或 openDingTalkId）加进允许名单——名单为空时任何请求都不会变成工单。

见 [docs/006-deployment.md](docs/006-deployment.md) 的 DingTalk 小节。

## Setup

Setup has many steps, so an agent does it with you. Ask your coding agent:

> Read SETUP.md in this repository and set up dsh-superagent with me.

It asks one short question at a time, shows the full plan once, and then installs and configures everything. [SETUP.md](SETUP.md) is what it follows.

## Documentation

Read the numbered documents in order; each builds only on the ones before it.

- [000 Philosophy](docs/000-philosophy.md)
- [001 Domain model](docs/001-domain.md)
- [002 Authorization](docs/002-authorization.md)
- [003 Execution](docs/003-execution.md)
- [004 Prompts](docs/004-prompts.md)
- [005 Panel](docs/005-panel.md)
- [006 Deployment](docs/006-deployment.md): manual setup, configuration, upgrades and troubleshooting
- [007 Architecture](docs/007-architecture.md)
- [008 Cookbook](docs/008-cookbook.md): adding a Source

## Development

`pnpm check` runs the typecheck, the tests and the build.

## License

[MIT](LICENSE)
