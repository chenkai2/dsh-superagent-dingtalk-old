/** DingTalk source kind definition and Cordis plugin entry. */
import type { Context } from '@deepseek-ai/cordis'
import { z } from 'zod'
import { dingtalkLink, sendDingtalk } from './dingtalk-channel.ts'
import { DingtalkConfigSchema, dwsOf, streamOf, type DingtalkConfig } from './dingtalk-config.ts'
import { runDingtalk } from './dingtalk-loops.ts'
import { dingtalkThreadContext } from './dingtalk-read.ts'
import { sourceContext } from './host.ts'
import type { Localized, SourceKind } from './kind.ts'

export { SOURCE, dingtalkChannel, dingtalkThreadId, dingtalkTime, dingtalkTrigger, dingtalkTriggerId } from './dingtalk-trigger.ts'
export type { DingtalkMessageInput } from './dingtalk-trigger.ts'
export { DingtalkConfigSchema, dwsOf, streamOf } from './dingtalk-config.ts'
export type { DingtalkConfig, DingtalkGroup } from './dingtalk-config.ts'
export { addressedTo, runDingtalk } from './dingtalk-loops.ts'
export { DingtalkStream } from './dingtalk-stream.ts'

const SOURCE = 'dingtalk'

/**
 * DingTalk Source: reads a conversation through the operator's `dws` CLI, receives messages addressed to an application
 * robot over the Stream long connection, and replies as a bot so its words are never attributed to the operator.
 */
export const dingtalkKind: SourceKind<DingtalkConfig> = {
  kind: SOURCE,
  title: { zh: '钉钉', en: 'DingTalk' },
  description: {
    zh: '读取配置的群和私聊：用 dws 以你本人身份读取全量消息，用 Stream 机器人接收 @ 它的消息；回复一律以机器人身份发出。',
    en: 'Reads the configured groups and direct messages: dws reads them as the operator, and a Stream robot receives the messages that address it; every reply is posted as a bot.',
  },
  schema: DingtalkConfigSchema,
  fields: [
    { key: 'groups', type: 'rows', label: { zh: '接收的群', en: 'Groups' },
      hint: { zh: '点 dws 读取的群与 Stream 接收的群取交集以外的部分由“其他群”和“接收私聊”决定。选“全部消息”时，群里没 @ 机器人的消息也会读到，由策略的接收表决定是否成为候选。',
        en: 'The groups read by dws and received by Stream. "All" also reads messages that do not address the robot; the Policy admission table decides whether they become candidates.' },
      columns: [
        { key: 'conversationId', type: 'text', label: { zh: '群 openConversationId', en: 'Group openConversationId' }, pattern: '[^\\s]+' },
        { key: 'name', type: 'text', label: { zh: '群名', en: 'Name' }, optional: true },
        { key: 'listen', type: 'select', label: { zh: '接收', en: 'Receive' }, options: [
          { value: 'mentions', label: { zh: '仅 @', en: '@ only' } }, { value: 'all', label: { zh: '全部消息', en: 'All' } }] },
      ] },
    { key: 'otherChats', type: 'switch', label: { zh: '接收其他群里 @ 机器人的消息', en: 'Receive mentions in other groups' } },
    { key: 'directMessages', type: 'switch', label: { zh: '接收私聊', en: 'Direct messages' } },
    { key: 'dwsEnabled', type: 'switch', label: { zh: '用 dws 读取消息', en: 'Read messages through dws' },
      hint: { zh: '以你本人身份读取群消息，能看到没有 @ 机器人的消息和历史。关闭后只能靠 Stream 接收 @ 机器人的消息。', en: 'Reads a group as the operator, including messages that do not address the robot and their history. When off, only messages that address the robot through Stream are received.' } },
    { key: 'dwsCli', type: 'text', label: { zh: 'dws 命令', en: 'dws command' },
      hint: { zh: '命令名或绝对路径。执行器以 dws 调用它读取消息；智能体不得以它发送消息，发送只走机器人身份。', en: 'A command name or absolute path. Executors call it as dws to read; agents must never send with it, because sending is bot-signed only.' } },
    { key: 'mentionNames', type: 'rows', label: { zh: '机器人显示名', en: 'Robot display names' },
      hint: { zh: 'dws 读到的消息没有结构化的 @ 信息，只能按文本里的“@名字”判断有没有 @ 机器人。填机器人在群里的显示名。', en: 'A message read by dws carries no structured mention, so "@name" in the text is the only signal; enter the robot\'s display name in the group.' },
      columns: [{ key: 'name', type: 'text', label: { zh: '名字', en: 'Name' }, pattern: '.{1,40}' }] },
    { key: 'streamClientId', type: 'text', label: { zh: 'Stream 机器人 ClientID（AppKey）', en: 'Stream robot ClientID (AppKey)' },
      hint: { zh: '企业内部应用的 AppKey。应用需添加机器人能力、消息接收模式选 Stream，并发布版本。留空则不接收 Stream 消息。', en: 'The AppKey of the internal application. The application needs the robot capability, Stream as its receiving mode, and a published version. Leave empty to receive nothing over Stream.' } },
    { key: 'streamClientSecret', type: 'text', label: { zh: 'Stream 机器人 Client*', en: 'Stream robot Client*' } },
    { key: 'streamRobotCode', type: 'text', label: { zh: '发送用 robotCode', en: 'robotCode for sending' },
      hint: { zh: '没有配置群机器人时，用它经 dws 以机器人身份发送。留空则用 AppKey。', en: 'Used through dws to post as a bot when no group robot covers a conversation. Defaults to the AppKey.' } },
    { key: 'bots', type: 'rows', label: { zh: '群机器人（webhook）', en: 'Group robots (webhook)' },
      hint: { zh: '每个群一个自定义机器人，只管发不管收；有加签时填 *。它的回复署名是机器人，不会冒充你。', en: 'One custom robot per group; it only posts and receives nothing. Fill the * when the robot signs its requests. Its messages are signed by the robot and never impersonate the operator.' },
      columns: [
        { key: 'name', type: 'text', label: { zh: '名字', en: 'Name' }, pattern: '.{1,40}' },
        { key: 'conversationId', type: 'text', label: { zh: '群 openConversationId', en: 'Group openConversationId' }, pattern: '[^\\s]+' },
        { key: 'token', type: 'text', label: { zh: 'access_token', en: 'access_token' }, pattern: '[^\\s]+' },
        { key: 'secret', type: 'text', label: { zh: '*（可选）', en: '* (optional)' }, optional: true },
      ] },
    { key: 'dwsPollSeconds', type: 'number', advanced: true, min: 10, max: 3600, label: { zh: '轮询间隔 / 秒', en: 'Polling interval / seconds' } },
    { key: 'dwsPageSize', type: 'number', advanced: true, min: 1, max: 100, label: { zh: '每次读取条数', en: 'Messages per read' } },
    { key: 'readPageSize', type: 'number', advanced: true, min: 1, max: 50, label: { zh: '线程上下文每页条数', en: 'Thread context page size' } },
    { key: 'failuresBeforeError', type: 'number', advanced: true, min: 1, max: 20, label: { zh: '连续失败几次后报告异常', en: 'Failed reads before reporting an error' } },
  ],
  health: ['dingtalk'],
  scope({ meta }, config) {
    if (meta.direct === true) return config.directMessages ? { listened: true, observed: false, row: 'direct' } : { listened: false, reason: 'direct_messages_not_allowed' }
    const group = config.groups.find(item => item.conversationId === meta.conversationId)
    if (group) return { listened: true, observed: group.listen === 'all', row: group.conversationId }
    return config.otherChats ? { listened: true, observed: false, row: 'other' } : { listened: false, reason: 'chat_not_allowed' }
  },
  channel: {
    allowed: (address, config) => dingtalkKind.scope!({ meta: { conversationId: address.conversationId ?? '', direct: address.direct === 'true' } }, config).listened,
    send: sendDingtalk, link: dingtalkLink,
  },
  threadContext: dingtalkThreadContext,
  find: query => ({ threads: [], terms: [...new Set(query.match(/cid\/[A-Za-z0-9+/=]+/g) ?? [])] }),
  policy: {
    unnamed: { person: { zh: '钉钉用户', en: 'DingTalk user' }, bot: { zh: '钉钉机器人', en: 'DingTalk bot' } },
    schema: z.object({
      allowed: z.array(z.object({ id: z.string().trim().min(1), name: z.string().trim().max(100).optional() }).strict())
        .refine(users => new Set(users.map(user => user.id)).size === users.length, 'Duplicate ids').default([]),
      bots: z.array(z.object({ id: z.string().trim().min(1), name: z.string().trim().max(100).optional() }).strict())
        .refine(bots => new Set(bots.map(bot => bot.id)).size === bots.length, 'Duplicate ids').optional(),
    }).strict(),
    fields: [
      { key: 'allowed', type: 'rows', label: { zh: '能发起工作的钉钉用户', en: 'DingTalk users who may originate work' },
        hint: { zh: '填成员的 staffId 或 openDingTalkId。名单为空时任何请求都不会成为工单。', en: 'Fill a member\'s staffId or openDingTalkId. While the list is empty no request can become a Ticket.' },
        columns: [{ key: 'id', type: 'text', label: { zh: 'staffId / openDingTalkId', en: 'staffId / openDingTalkId' }, pattern: '[^\\s]+' },
          { key: 'name', type: 'text', label: { zh: '名字', en: 'Name' }, optional: true }] },
      { key: 'bots', type: 'rows', label: { zh: '消息可以成为候选的机器人', en: 'Bots whose messages may become candidates' },
        hint: { zh: '名单里的机器人发的消息成为推断的候选，交给评估；它们不能发起明确的请求，也不能停止工单。', en: 'Messages of a bot on this list become inferred candidates for an assessment; they never make an explicit request or stop a ticket.' },
        columns: [{ key: 'id', type: 'text', label: { zh: 'openDingTalkId', en: 'openDingTalkId' }, pattern: '[^\\s]+' },
          { key: 'name', type: 'text', label: { zh: '名字', en: 'Name' }, optional: true }] },
    ],
    explicit: { zh: '名单内的人 @ 机器人或私聊机器人，总是明确的请求。', en: 'Someone on the list who mentions the robot or messages it directly always makes an explicit request.' },
    rows(stored) {
      const config = DingtalkConfigSchema.parse(stored)
      const mentions = { zh: '仅 @', en: '@ only' }
      return [
        ...config.groups.map(group => ({ id: group.conversationId, label: group.name || group.conversationId,
          note: group.listen === 'all' ? { zh: '全部消息', en: 'All' } : mentions,
          cells: { listedUnaddressed: group.listen === 'all', unlistedAddressed: true, unlistedUnaddressed: group.listen === 'all' } })),
        { id: 'other', label: { zh: '其他群', en: 'Other groups' }, note: config.otherChats ? mentions : { zh: '不接收', en: 'Not received' },
          cells: { listedUnaddressed: false, unaddressedAddressed: false, unlistedAddressed: config.otherChats, unlistedUnaddressed: false } },
        { id: 'direct', label: { zh: '私聊', en: 'Direct messages' }, note: config.directMessages ? { zh: '接收', en: 'Received' } : { zh: '不接收', en: 'Not received' },
          cells: { listedUnaddressed: false, unlistedAddressed: config.directMessages, unlistedUnaddressed: false } },
      ]
    },
  },
  environment: {
    variables: [
      { key: 'DSH_SUPERAGENT_DINGTALK_CHAT', description: { zh: '接下工单的钉钉会话 openConversationId；工单不是从钉钉来的时为空', en: 'openConversationId of the DingTalk conversation that started the ticket; empty when the ticket did not start on DingTalk' } },
      { key: 'DSH_SUPERAGENT_DINGTALK_ROBOT', description: { zh: '接收这条消息的机器人；回复一律以机器人身份发出，不得以你本人名义发言', en: 'The robot that received the message. Every reply is posted as a bot and must never speak as the operator' } },
    ],
    values: ({ trigger }) => ({
      DSH_SUPERAGENT_DINGTALK_CHAT: trigger?.source === SOURCE ? String(trigger.meta.conversationId ?? '') : '',
      DSH_SUPERAGENT_DINGTALK_ROBOT: trigger?.source === SOURCE ? String(trigger.meta.robotCode ?? '') : '',
    }),
  },
  facts: (deployment): Record<string, Localized | string> => deployment ? {} : {},
}

export const name = 'dsh-superagent-dingtalk'
export const inject = ['orchestrator']
/**
 * Registers the DingTalk Source kind and runs its transports.
 * @param ctx The Cordis context the bundle mounts in.
 */
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.orchestrator.sources.register(dingtalkKind), 'dingtalk: source kind')
  ctx.effect(() => {
    const controller = new AbortController()
    const running = runDingtalk(sourceContext(ctx.orchestrator, dingtalkKind), controller.signal)
    return async () => { controller.abort(); await running }
  })
}