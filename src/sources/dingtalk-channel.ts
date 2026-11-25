/** DingTalk outbound channel: replies in the conversation a message came from, signed by a bot rather than the operator. */
import { createHmac } from 'node:crypto'
import type { OutboundMessage } from '../core/index.ts'
import type { SourceContext } from './host.ts'
import type { ChannelLink, ChannelLinks } from './kind.ts'
import { sendDwsBot } from './dingtalk-dws.ts'
import { dwsOf, streamOf, type DingtalkConfig } from './dingtalk-config.ts'
import { SOURCE } from './dingtalk-trigger.ts'

/** One custom group robot: the webhook token, and the signing secret when the robot requires a signature. */
export interface WebhookBot {
  name: string
  conversationId: string
  token: string
  secret?: string
}
/** A group robot as the channel reads it. */
export type ChannelBot = WebhookBot
/** DingTalk rejects a markdown body beyond about 5,000 bytes; the renderer keeps each message well inside that. */
const MAX_TEXT = 3_800

/** The heading and body one message renders as: the heading names the purpose, so a reader knows what to do. */
function render(message: OutboundMessage): { title: string; text: string } {
  const body = message.text.trim()
  const cut = body.length > MAX_TEXT ? `${body.slice(0, MAX_TEXT)}\n\n…（内容过长已截断，完整内容见面板）` : body
  switch (message.purpose) {
    case 'attention':
      return { title: '需要你决定', text: `### 🙋 需要你决定\n\n${cut}\n\n---\n\n直接回复这条消息告诉我你的决定，例如回复序号或补充要求。` }
    case 'result':
      return { title: '工单结果', text: `### ✅ 工单结果\n\n${cut}` }
    case 'answer':
      return { title: '回答', text: `### 💬 回答\n\n${cut}` }
    default:
      return { title: '已收到', text: `### 👀 已收到\n\n${cut}` }
  }
}

/** The signature a robot that requires one needs, as DingTalk documents it: HMAC-SHA256 over `<timestamp>\n<secret>`. */
function signed(bot: WebhookBot, timestamp: number): string {
  if (!bot.secret) return `timestamp=${timestamp}`
  const digest = createHmac('sha256', bot.secret).update(`${timestamp}\n${bot.secret}`).digest('base64')
  return `timestamp=${timestamp}&sign=${encodeURIComponent(digest)}`
}

/** Posts a markdown message through a custom group robot, which needs no application credentials. */
async function sendWebhook(bot: WebhookBot, title: string, text: string): Promise<void> {
  const timestamp = Date.now()
  const response = await fetch(`https://oapi.dingtalk.com/robot/send?access_token=${encodeURIComponent(bot.token)}&${signed(bot, timestamp)}`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ msgtype: 'markdown', markdown: { title, text } }),
  })
  const body = await response.json().catch(() => ({})) as { errcode?: number; errmsg?: string }
  if (body.errcode !== 0) {
    // 300001 is an invalid token and 310000 a signature mismatch: both are configuration, so the message can never arrive.
    const gone = body.errcode === 300001 || body.errcode === 310000
    const error = new Error(`DingTalk robot ${bot.name} refused the message: ${body.errmsg ?? 'unknown error'} (${body.errcode ?? response.status})`)
    if (gone) throw Object.assign(error, { gone: true })
    throw error
  }
}

/**
 * Delivers one message, preferring the reply address the triggering message carried, then a group robot for that
 * conversation, then the application robot through `dws`. Every path signs the message as a bot, never as the operator.
 * @param host The Source context.
 * @param message The queued message.
 * @returns `'gone'` when the conversation can never receive it, so the Outbox stops retrying.
 */
export async function sendDingtalk(host: Pick<SourceContext, 'commands' | 'config'>, message: OutboundMessage): Promise<'sent' | 'gone'> {
  const config = host.config<DingtalkConfig>(SOURCE)
  const conversationId = message.channel.address.conversationId
  if (!conversationId) throw new Error('Missing DingTalk reply target')
  const { title, text } = render(message)
  // 1. The one-time address the Stream callback carried replies in place with no sending permission.
  const webhook = message.channel.address.sessionWebhook
  const expiresAt = Number(message.channel.address.sessionWebhookExpiresAt ?? 0)
  if (webhook && (!expiresAt || expiresAt > Date.now())) {
    const response = await fetch(webhook, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ msgtype: 'markdown', markdown: { title, text } }),
    })
    if (response.ok) return 'sent'
    // An expired or rejected address falls through to a configured sender instead of dropping the message.
  }
  // 2. A group robot configured for this conversation needs no application credentials.
  const bot = config?.bots.find(item => item.conversationId === conversationId)
  if (bot) {
    try { await sendWebhook(bot, title, text) }
    catch (error) {
      if ((error as { gone?: boolean }).gone) return 'gone'
      throw error
    }
    return 'sent'
  }
  // 3. The application robot through dws, which keeps the message signed by a bot.
  const dws = config ? dwsOf(config) : undefined
  const robotCode = config ? streamOf(config)?.robotCode ?? config.streamClientId : undefined
  if (dws?.enabled && robotCode) {
    await sendDwsBot(host.commands, dws.cli, robotCode, conversationId, title, text)
    return 'sent'
  }
  throw new Error(`No DingTalk sender covers conversation ${conversationId}: set a group robot for it, or enable dws with an application robot code`)
}

/**
 * Names the conversation a message went to. DingTalk has no stable web address for a conversation, so the link is empty
 * unless the deployment knows one.
 * @param address The channel address.
 * @param links Deployment links.
 * @returns The label the panel shows.
 */
export function dingtalkLink(address: Record<string, string>, links: ChannelLinks): ChannelLink {
  const name = address.conversationName ?? address.conversationId ?? ''
  return { url: links.dingtalk?.[address.conversationId ?? ''] ?? '', label: { zh: `钉钉群 ${name}`, en: `DingTalk chat ${name}` } }
}