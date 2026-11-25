/** DingTalk Source: message normalization, mention detection, and the bot-signed Markdown the Channel posts. */
import { afterEach, expect, it, vi } from 'vitest'
import { sendDingtalk } from '../src/sources/dingtalk-channel.ts'
import { DingtalkConfigSchema } from '../src/sources/dingtalk-config.ts'
import { addressedTo, ingestible, readFrom } from '../src/sources/dingtalk-loops.ts'
import { StreamMessageSchema, dingtalkChannel, dingtalkTime, dingtalkTrigger, dingtalkTriggerId, streamText }
  from '../src/sources/dingtalk-trigger.ts'
import type { OutboundMessage } from '../src/core/index.ts'
import type { SourceContext } from '../src/sources/host.ts'

const message = (overrides: Partial<OutboundMessage> = {}): OutboundMessage => ({
  id: 'm1', channel: dingtalkChannel('cid/A', 'msg1'), text: '工单已完成', kind: 'reply', ticketId: 't1', purpose: 'result', ...overrides,
})

afterEach(() => { vi.unstubAllGlobals() })

/** A Source context whose only configured part is the Source's own settings. */
const hostWith = (config: unknown): Pick<SourceContext, 'commands' | 'config'> =>
  ({ commands: {} as never, config: <C,>() => config as C })

it('reads both timestamp forms DingTalk reports', () => {
  expect(dingtalkTime(1_764_000_000_000)).toBe(new Date(1_764_000_000_000).toISOString())
  // A history read prints Shanghai wall-clock time with no offset.
  expect(dingtalkTime('2026-11-25 11:49:55')).toBe('2026-11-25T03:49:55.000Z')
})

it('normalizes a history message and keeps a robot distinct from a person', () => {
  const human = dingtalkTrigger({ messageId: 'msg1', conversationId: 'cid/A', at: '2026-11-25 11:49:55', text: '@bot 看一下',
    senderId: 'DXiPuser', senderName: '陈凯', human: true, direct: false, mentioned: true })
  expect(human).toMatchObject({
    id: dingtalkTriggerId('msg1'), source: 'dingtalk', human: true, addressed: 'mention',
    threads: [{ source: 'dingtalk', id: 'dingtalk:cid/A' }],
    channel: { source: 'dingtalk', thread: 'dingtalk:cid/A', address: { conversationId: 'cid/A', messageId: 'msg1' } },
  })
  const robot = dingtalkTrigger({ messageId: 'msg2', conversationId: 'cid/A', at: 1_764_000_000_000, text: '战报',
    senderId: 'DXiPbot', human: false, direct: false, mentioned: false })
  expect(robot).toMatchObject({ human: false, meta: { sendType: 'robot' } })
  expect(robot?.addressed).toBeUndefined()
})

it('marks a direct message as addressed and drops a message with no text', () => {
  const direct = dingtalkTrigger({ messageId: 'msg3', conversationId: 'cid/D', at: 1, text: '帮我看看',
    senderId: 'DXiPuser', human: true, direct: true, mentioned: false })
  expect(direct?.addressed).toBe('direct')
  expect(dingtalkTrigger({ messageId: 'msg4', conversationId: 'cid/A', at: 1, text: '   ', senderId: 'x', human: true,
    direct: false, mentioned: true })).toBeUndefined()
})

it('detects a mention only from the configured robot names', () => {
  expect(addressedTo('@chenkai2 干活', ['chenkai2'])).toBe(true)
  expect(addressedTo('@chenkai2 干活', ['小凯助手'])).toBe(false)
  expect(addressedTo('chenkai2 干活', ['chenkai2'])).toBe(false)
  expect(addressedTo('任何文本', [])).toBe(false)
})

it('posts a bot-signed Markdown message through a group robot, and signs it when configured', async () => {
  const calls: { url: string; body: string }[] = []
  vi.stubGlobal('fetch', async (url: string, init: { body: string }) => {
    calls.push({ url, body: init.body })
    return { ok: true, json: async () => ({ errcode: 0 }) } as Response
  })
  const config = DingtalkConfigSchema.parse({
    bots: [{ name: '发布机器人', conversationId: 'cid/A', token: 'tok', secret: 'secret-value' }],
  })
  const host = hostWith(config)
  await expect(sendDingtalk(host, message({ purpose: 'attention', text: '要不要合并？' }))).resolves.toBe('sent')
  expect(calls[0]!.url).toContain('access_token=tok')
  expect(calls[0]!.url).toContain('sign=')
  const body = JSON.parse(calls[0]!.body) as { msgtype: string; markdown: { title: string; text: string } }
  expect(body.msgtype).toBe('markdown')
  // A question for a person is presented as one, with what to do next.
  expect(body.markdown.text).toContain('需要你决定')
  expect(body.markdown.text).toContain('直接回复这条消息')
  expect(body.markdown.text).toContain('要不要合并？')
})

it('reports a refused group robot as gone when the token or signature is wrong', async () => {
  vi.stubGlobal('fetch', async () => ({ ok: true, json: async () => ({ errcode: 300001, errmsg: 'token is not exist' }) }) as Response)
  const config = DingtalkConfigSchema.parse({ bots: [{ name: 'b', conversationId: 'cid/A', token: 'bad' }] })
  const host = hostWith(config)
  await expect(sendDingtalk(host, message())).resolves.toBe('gone')
})

it('prefers the reply address the Stream message carried, and falls back to a group robot when it fails', async () => {
  const urls: string[] = []
  let first = true
  vi.stubGlobal('fetch', async (url: string) => {
    urls.push(url)
    if (first) { first = false; return { ok: false } as Response }
    return { ok: true, json: async () => ({ errcode: 0 }) } as Response
  })
  const config = DingtalkConfigSchema.parse({ bots: [{ name: 'b', conversationId: 'cid/A', token: 'tok' }] })
  const host = hostWith(config)
  const channel = { ...dingtalkChannel('cid/A', 'msg1'), address: { conversationId: 'cid/A', messageId: 'msg1',
    sessionWebhook: 'https://example.test/hook', sessionWebhookExpiresAt: String(Date.now() + 60_000) } }
  await expect(sendDingtalk(host, message({ channel }))).resolves.toBe('sent')
  expect(urls[0]).toBe('https://example.test/hook')
  expect(urls[1]).toContain('access_token=tok')
})

it('refuses to send when no sender covers the conversation', async () => {
  const host = hostWith(DingtalkConfigSchema.parse({}))
  await expect(sendDingtalk(host, message())).rejects.toThrow(/No DingTalk sender covers conversation cid\/A/)
})
it('flattens the rich text a mention arrives in, and keeps a plain text body', () => {
  const rich = StreamMessageSchema.parse({ msgId: 'm1', conversationId: 'cid/A', createAt: 1, msgtype: 'richText',
    content: JSON.stringify({ richText: [{ text: '@小钉' }, { text: ' 看一下这个' }] }), isInAtList: true })
  expect(streamText(rich)).toBe('@小钉 看一下这个')
  const plain = StreamMessageSchema.parse({ msgId: 'm2', conversationId: 'cid/A', createAt: 1, msgtype: 'text', text: { content: 'hi' } })
  expect(streamText(plain)).toBe('hi')
  // A body this Source cannot read yields no text, so no Trigger is built from it.
  expect(streamText(StreamMessageSchema.parse({ msgId: 'm3', conversationId: 'cid/A', createAt: 1, msgtype: 'picture' }))).toBe('')
})

it('treats a message a tool sent through the operator account as agent output, not as a request', () => {
  // `sendType` reports both of these as `user`; only the AI flag separates the agent's own words from the operator's.
  expect(ingestible({ messageAiSendFlag: undefined })).toBe(true)
  expect(ingestible({ messageAiSendFlag: 'DWS' })).toBe(false)
  expect(ingestible({ messageAiSendFlag: null })).toBe(true)
})

it('reads from a few seconds before the cursor, so a late-indexed message is not skipped', () => {
  const cursor = '2026-11-25T09:11:55.000Z'
  expect(readFrom(cursor)).toBe('2026-11-25T09:11:50.000Z')
  // An unreadable cursor is passed through rather than turned into an invalid time.
  expect(readFrom('not-a-time')).toBe('not-a-time')
})
