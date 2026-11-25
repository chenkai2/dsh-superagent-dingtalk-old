/** DingTalk reception: the Stream long connection for messages addressed to the robot, and `dws` polling for everything a person wrote. */
import { KV } from '../kv.ts'
import { dwsOf, streamOf, type DingtalkConfig } from './dingtalk-config.ts'
import { readDwsPage } from './dingtalk-dws.ts'
import { DingtalkStream } from './dingtalk-stream.ts'
import { dingtalkTrigger, type DingtalkMessageInput } from './dingtalk-trigger.ts'
import { pause } from './poll.ts'
import type { SourceContext } from './host.ts'

/** The health entry every part of this Source reports under. */
const HEALTH = 'dingtalk'

/**
 * Whether `text` addresses one of the configured robot names. A history read has no structural mention field, so this is
 * the only addressing signal it has; the admission table still decides whether an unaddressed message may become work.
 * @param text The message body.
 * @param names The robot display names to look for.
 * @returns True when the text names one of them with an `@`.
 */
export function addressedTo(text: string, names: readonly string[]): boolean {
  return names.some(name => name.length > 0 && text.includes(`@${name}`))
}

/**
 * Whether a message read from history may become a request. A message a tool sent through the operator's account is the
 * agent's own output, and reading it as input would make the agent answer itself.
 * @param message The message as the history read reported it.
 * @returns False for a message the platform marks as sent by an AI tool.
 */
export const ingestible = (message: { messageAiSendFlag?: string | null | undefined }): boolean => !message.messageAiSendFlag

/** Normalizes a Shanghai wall-clock timestamp so it can be compared with an ISO cursor. */
function storableTime(value: string): string {
  const time = Date.parse(/[+-]\d{2}:?\d{2}$|Z$/.test(value) ? value : `${value.replace(' ', 'T')}+08:00`)
  return Number.isFinite(time) ? new Date(time).toISOString() : ''
}

/**
 * Reads every configured group's messages newer than the stored cursor and ingests them.
 * A conversation advances its cursor only after its messages are ingested, so a failed run re-reads the same page and the
 * deterministic Trigger ID keeps that from creating a second request.
 * @param host The Source context.
 * @param config The current configuration.
 * @param tally Cleared on success and incremented on failure, so one interrupted read is not reported.
 */
async function pollGroups(host: SourceContext, config: DingtalkConfig, tally: { failures: number }): Promise<void> {
  const dws = dwsOf(config)
  if (!dws.enabled) return
  for (const group of config.groups) {
    const key = KV.dingtalk.cursor(group.conversationId)
    const stored = host.state.get(key)
    // A conversation this Source has never read starts now: earlier messages are not turned into requests.
    if (stored === undefined) { host.state.set(key, new Date().toISOString()); continue }
    const page = await readDwsPage(host.commands, dws.cli, group.conversationId, stored, dws.pageSize)
    let newest = stored
    for (const message of page.messages) {
      if (!ingestible(message)) continue
      const input: DingtalkMessageInput = {
        messageId: message.messageId,
        conversationId: message.openConversationId ?? message.conversationId ?? group.conversationId,
        at: message.createTime,
        text: message.text,
        senderId: message.senderOpenDingTalkId ?? message.senderId,
        senderName: message.sender,
        human: message.sendType === 'user',
        direct: false,
        mentioned: addressedTo(message.text, config.mentionNames.map(entry => entry.name)),
      }
      const trigger = dingtalkTrigger(input)
      if (trigger) await host.receive(trigger)
      const instant = storableTime(message.createTime)
      if (instant > newest) newest = instant
    }
    if (newest !== stored) host.state.set(key, newest)
  }
  tally.failures = 0
}

/** Runs one poll, reporting a failure without stopping the loop. */
async function pollSafely(host: SourceContext, config: DingtalkConfig, tally: { failures: number; last?: string }): Promise<void> {
  try {
    await pollGroups(host, config, tally)
    tally.last = undefined
    host.report(HEALTH, { state: 'ready', detail: dwsOf(config).enabled ? 'Reading configured groups' : 'Stream only' })
  } catch (error) {
    tally.failures += 1
    tally.last = error instanceof Error ? error.message : String(error)
    if (tally.failures >= config.failuresBeforeError) {
      host.report(HEALTH, { state: 'error', detail: `${tally.failures} consecutive failed reads; last: ${tally.last}` })
    }
  }
}

/** Whether a message belongs to a conversation this Source listens to. */
const listensTo = (config: DingtalkConfig, conversationId: string, direct: boolean): boolean =>
  direct ? config.directMessages : config.groups.some(group => group.conversationId === conversationId) || config.otherChats

/** Opens the Stream connection and keeps it for as long as the Source runs. */
async function runStream(host: SourceContext, signal: AbortSignal): Promise<void> {
  const config = host.config<DingtalkConfig>('dingtalk')
  const stream = config ? streamOf(config) : undefined
  if (!config || !stream) {
    host.report(HEALTH, { state: 'ready', detail: 'Stream robot not configured; reading through dws only' })
    return
  }
  const client = new DingtalkStream(stream, {
    async message(input, robotCode) {
      const current = host.config<DingtalkConfig>('dingtalk')
      if (!current || !listensTo(current, input.conversationId, input.direct)) return
      const trigger = dingtalkTrigger({ ...input, robotCode })
      if (trigger) await host.receive(trigger)
    },
    report(state, detail) { host.report(HEALTH, { state, detail }) },
  })
  try {
    await client.start()
  } catch (error) {
    host.report(HEALTH, { state: 'error', detail: `Stream failed to start: ${error instanceof Error ? error.message : String(error)}` })
    return
  }
  await new Promise<void>(resolve => { signal.addEventListener('abort', () => { resolve() }, { once: true }) })
  client.stop()
}

/**
 * Runs every configured transport until `signal` aborts: the Stream connection, and the `dws` poll loop.
 * @param host The Source context.
 * @param signal Aborts the run, closing the connection.
 */
export async function runDingtalk(host: SourceContext, signal: AbortSignal): Promise<void> {
  const config = host.config<DingtalkConfig>('dingtalk')
  if (!config) { host.report(HEALTH, { state: 'ready', detail: 'DingTalk Source is off' }); return }
  const tally = { failures: 0 }
  const polling = (async () => {
    while (!signal.aborted) {
      const current = host.config<DingtalkConfig>('dingtalk')
      if (current) await pollSafely(host, current, tally)
      await pause((current ? dwsOf(current).pollSeconds : 60) * 1000, signal)
    }
  })()
  await Promise.all([polling, runStream(host, signal)])
}