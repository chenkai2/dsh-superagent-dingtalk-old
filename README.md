# dsh-superagent

> **Research prototype for reference only, not an official DeepSeek product.** This code grew out of our team's day-to-day development work, with much of the engineering done by coding agents. Treat it as research code, not production-ready software. It may still contain bugs, and its coding style and engineering practices may be inconsistent. Review and adapt it before using it in your own environment.
>
> We have adapted it for publication, so it is not identical to our internal version or the implementation described in *Exploring Super-agent Design: Towards a More Autonomous Agent System*. Some designs discussed in the article are directions for future development and are not implemented in this prototype.

dsh-superagent is a proactive coding agent for one GitHub repository, packaged as a bundle for [DeepSeek Harness](https://www.deepseek.com/en/harness/). It listens to GitHub and, optionally, Feishu. When someone allowed asks the agent for work, it opens a work item, works on it in its own agent session and directory, and answers in the original conversation, for example with a pull request. A web panel shows what needs a person.

It is also a way of working with an agent: **take as little human attention as possible, and give as much value as possible.** An agent that can act for a whole team can also waste a whole team's attention, so it acts only when asked or when a rule the team wrote allows it, and speaks only when someone must act or can use a result. [docs/000-philosophy.md](docs/000-philosophy.md) explains the principle and what it asks of the operator.

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
