/** Reads a DingTalk conversation as thread context through `dws`, so an assessment sees what a person actually wrote. */
import type { Commands } from '../infra/commands.ts'
import type { ContextMessage, ContextPart, ContextPartName } from './kind.ts'
import type { ThreadContext } from './kind.ts'
import type { Trigger } from '../core/index.ts'
import { readDwsPage } from './dingtalk-dws.ts'
import { dingtalkTime } from './dingtalk-trigger.ts'

/** The configuration the reader needs: the operator's `dws` and how many messages one page holds. */
/** The reader's configuration. */
export interface ReadConfig {
  dwsEnabled?: boolean
  dwsCli?: string
  readPageSize?: number
}

/** A message as the context reader reports it: `bot` marks a robot, which can never authorize work on its own. */
const toContext = (message: { messageId: string; sender: string; senderId: string; createTime: string; text: string
  sendType: string }): ContextMessage => ({
  id: message.messageId,
  from: message.sender || message.senderId,
  at: dingtalkTime(message.createTime),
  text: message.text,
  ...message.sendType === 'robot' ? { bot: true as const } : {},
})

/**
 * Reads one page of the conversation a Trigger came from.
 * @param commands The deployment's command runner.
 * @param trigger The Trigger whose conversation is read.
 * @param part `thread` reads the conversation; `root` and `parent` fall back to it, because DingTalk has no topic roots.
 * @param cursor An ISO instant to read older messages before; the first page when omitted.
 * @param config The reader's configuration.
 * @returns The page, oldest first, and the cursor for the next older page.
 * @throws when `dws` is not enabled, because then no reader can see the conversation.
 */
export async function readDingtalkThread(commands: Commands, trigger: Trigger, part: ContextPartName, cursor: string | undefined,
  config: ReadConfig): Promise<ContextPart> {
  if (!config.dwsEnabled) return { messages: [], body: { reason: 'dws is disabled, so no conversation history can be read' } }
  const conversationId = String(trigger.meta.conversationId ?? trigger.channel?.address.conversationId ?? '')
  if (!conversationId) return { messages: [], body: { reason: 'the Trigger names no conversation' } }
  const size = config.readPageSize ?? 20
  const page = await readDwsPage(commands, config.dwsCli ?? 'dws', conversationId, cursor, size, 'older')
  const messages = page.messages.map(toContext).sort((a, b) => a.at.localeCompare(b.at))
  const oldest = page.messages.reduce<string | undefined>((last, message) => {
    const at = dingtalkTime(message.createTime)
    return last === undefined || at < last ? at : last
  }, undefined)
  return {
    messages,
    ...page.hasMore && oldest ? { next: oldest } : {},
    body: { conversationId, part },
  }
}

/** The Thread context a Source kind exposes to assessments. */
export const dingtalkThreadContext: ThreadContext<ReadConfig> = {
  messageId: trigger => trigger.channel?.address.messageId ?? String(trigger.meta.messageId ?? ''),
  read: readDingtalkThread,
}
