/** Normalizes DingTalk messages from the Stream callback and the dws history read into domain Triggers. */
import { z } from 'zod'
import { key, type ChannelRef, type Trigger } from '../core/index.ts'

export const SOURCE = 'dingtalk'
/** Conversation kinds DingTalk reports: `1` is a one-to-one conversation, `2` a group. */
const DIRECT = '1'
/** Constructs a DingTalk reply channel address; `messageId` is the message a reply quotes, when one is known. */
export const dingtalkChannel = (conversationId: string, messageId?: string, extra: Record<string, string> = {}): ChannelRef =>
  ({ source: SOURCE, thread: `${SOURCE}:${conversationId}`, address: { conversationId, ...messageId ? { messageId } : {}, ...extra } })
/** One conversation is one Thread: a group's messages and a direct conversation's messages each reply in place. */
export const dingtalkThreadId = (conversationId: string): string => `${SOURCE}:${conversationId}`
/** Deterministic Trigger ID for a DingTalk message, so every read path for it produces the same ID and the Engine deduplicates. */
export const dingtalkTriggerId = (messageId: string): string => key(SOURCE, messageId)

/**
 * Parses a DingTalk timestamp into ISO-8601. The Stream callback sends epoch milliseconds, while `dws chat message list`
 * prints Shanghai wall-clock time without an offset; an unqualified value is read as UTC+08:00.
 * @param value Epoch milliseconds, or `YYYY-MM-DD HH:mm:ss`.
 * @returns The instant as an ISO-8601 string.
 * @throws when the value is neither form.
 */
export function dingtalkTime(value: string | number): string {
  if (typeof value === 'number' || /^\d{11,}$/.test(String(value))) return new Date(Number(value)).toISOString()
  const text = String(value).trim().replace(' ', 'T')
  const time = Date.parse(/[+-]\d{2}:?\d{2}$|Z$/.test(text) ? text : `${text}+08:00`)
  if (!Number.isFinite(time)) throw new Error(`Unreadable DingTalk message time: ${String(value)}`)
  return new Date(time).toISOString()
}

/** A message read by `dws chat message list`; `sendType` distinguishes a person from a robot. */
export const DwsMessageSchema = z.looseObject({
  messageId: z.string(),
  openConversationId: z.string().nullish(),
  conversationId: z.string().nullish(),
  createTime: z.string(),
  sender: z.string().default(''),
  senderId: z.string().default(''),
  senderOpenDingTalkId: z.string().nullish(),
  sendType: z.string().default('user'),
  text: z.string().default(''),
})
export type DwsMessage = z.infer<typeof DwsMessageSchema>

/** A robot message as the Stream callback delivers it. */
export const StreamMessageSchema = z.looseObject({
  msgId: z.string(),
  conversationId: z.string(),
  conversationType: z.string().default('2'),
  chatbotUserId: z.string().optional(),
  robotCode: z.string().optional(),
  senderId: z.string().default(''),
  senderNick: z.string().default(''),
  senderStaffId: z.string().optional(),
  createAt: z.number(),
  msgtype: z.string().default('text'),
  text: z.looseObject({ content: z.string().default('') }).default({ content: '' }),
  sessionWebhook: z.string().optional(),
  sessionWebhookExpiredTime: z.number().optional(),
  atUsers: z.array(z.looseObject({ dingtalkId: z.string().optional(), staffId: z.string().optional() })).default([]),
  isInAtList: z.boolean().optional(),
})
export type StreamMessage = z.infer<typeof StreamMessageSchema>

/** What a normalized message carries into a Trigger, independent of which transport read it. */
export interface DingtalkMessageInput {
  messageId: string
  conversationId: string
  /** Milliseconds since the epoch, or a Shanghai wall-clock string. */
  at: string | number
  text: string
  senderId: string
  senderName?: string
  /** `true` for a person; the history read reports robots as `robot`. */
  human: boolean
  direct: boolean
  /** Whether the message addresses the agent: always true for a group message the Stream callback delivered. */
  mentioned: boolean
  /** Present on a message the Stream callback delivered; a reply can go there without any sending permission. */
  sessionWebhook?: string | undefined
  sessionWebhookExpiredTime?: number | undefined
  robotCode?: string | undefined
  /** Set when a Thread's message is quoted, so a reply can quote it too. */
  quoteMessageId?: string | undefined
}

/**
 * Builds a Trigger for a normalized DingTalk message.
 * @param input The message as either transport normalized it.
 * @returns The Trigger, or `undefined` when the text is empty and the message can carry no request.
 */
export function dingtalkTrigger(input: DingtalkMessageInput): Trigger | undefined {
  const text = input.text
  if (!text.trim()) return undefined
  const thread = dingtalkThreadId(input.conversationId)
  return {
    id: dingtalkTriggerId(input.messageId),
    source: SOURCE,
    threads: [{ source: SOURCE, id: thread }],
    actor: { source: SOURCE, id: input.senderId },
    human: input.human,
    ...(input.direct ? { addressed: 'direct' as const } : input.mentioned ? { addressed: 'mention' as const } : {}),
    at: dingtalkTime(input.at),
    text,
    channel: dingtalkChannel(input.conversationId, input.messageId),
    meta: {
      conversationId: input.conversationId,
      messageId: input.messageId,
      senderName: input.senderName ?? '',
      sendType: input.human ? 'user' : 'robot',
      direct: input.direct,
      mentioned: input.mentioned,
      ...input.sessionWebhook ? { sessionWebhook: input.sessionWebhook } : {},
      ...input.sessionWebhookExpiredTime ? { sessionWebhookExpiredTime: input.sessionWebhookExpiredTime } : {},
      ...input.robotCode ? { robotCode: input.robotCode } : {},
      ...input.quoteMessageId ? { quoteMessageId: input.quoteMessageId } : {},
    },
  }
}