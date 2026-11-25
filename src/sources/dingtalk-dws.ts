/** Reads DingTalk conversations through the official `dws` CLI acting as the operator, and sends as a group bot. */
import { z } from 'zod'
import { validItems, type Commands } from '../infra/commands.ts'
import { DwsMessageSchema, type DwsMessage } from './dingtalk-trigger.ts'

/** `dws chat message list` prints the page and its completeness; `messages` is what this Source reads. */
const PageSchema = z.looseObject({ messages: z.array(z.unknown()).default([]), hasMore: z.boolean().default(false) })

/** Formats an instant as the `YYYY-MM-DD HH:mm:ss` in UTC+08:00 that `dws --time` accepts. */
export function dwsTime(instant: string): string {
  const at = new Date(instant)
  if (!Number.isFinite(at.getTime())) throw new Error(`Unreadable cursor time: ${instant}`)
  const shifted = new Date(at.getTime() + 8 * 60 * 60 * 1000)
  return shifted.toISOString().slice(0, 19).replace('T', ' ')
}

/** The message fields this Source reads; `sendType` is what separates a person from a robot. */
const FIELDS = 'messageId,createTime,sender,senderId,senderOpenDingTalkId,sendType,text'

/**
 * One page of a conversation's messages newer than `since`, oldest first.
 * @param commands The deployment's command runner.
 * @param cli The `dws` command name or absolute path.
 * @param conversationId The conversation's `openConversationId`.
 * @param since Exclusive lower bound; the caller advances it to the newest message it ingested.
 * @param limit Messages per page.
 * @returns The readable messages and whether the conversation has more beyond this page.
 */
export async function readDwsPage(commands: Commands, cli: string, conversationId: string, since: string | undefined,
  limit: number, direction: 'newer' | 'older' = 'newer'): Promise<{ messages: DwsMessage[]; hasMore: boolean }> {
  const args = ['chat', 'message', 'list', '--conversation-id', conversationId, '--direction', direction,
    '--limit', String(limit), '--fields', FIELDS, '-f', 'json']
  if (since) args.push('--time', dwsTime(since))
  const page = PageSchema.parse(JSON.parse(await commands.run(cli, args)))
  return { messages: validItems(DwsMessageSchema, page.messages), hasMore: page.hasMore }
}

/**
 * Sends a message as a group bot through the DingTalk OpenAPI, so the message is signed by the bot rather than the operator.
 * @param commands The deployment's command runner.
 * @param cli The `dws` command name or absolute path.
 * @param robotCode The robot that posts, named on the Settings card.
 * @param conversationId The target conversation.
 * @param title The message title the client shows above the body.
 * @param text The Markdown body.
 * @throws CliError when the CLI refuses, such as a robot the group does not contain.
 */
export async function sendDwsBot(commands: Commands, cli: string, robotCode: string, conversationId: string, title: string,
  text: string): Promise<void> {
  await commands.run(cli, ['chat', 'message', 'send-by-bot', '--robot-code', robotCode,
    '--conversation-id', conversationId, '--title', title.slice(0, 64), '--text', text])
}
