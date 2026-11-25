/** DingTalk Source configuration: which conversations are listened to, and which transports read and write them. */
import { z } from 'zod'

/** One conversation the Source listens to; `all` also reads messages that do not address the robot. */
export const DingtalkGroupSchema = z.object({
  conversationId: z.string().trim().min(1),
  name: z.string().trim().max(60).optional(),
  listen: z.enum(['mentions', 'all']).default('mentions'),
}).strict()
export type DingtalkGroup = z.infer<typeof DingtalkGroupSchema>

/** A custom group robot: it posts to its own conversation and needs no application credentials. */
export const DingtalkBotSchema = z.object({
  name: z.string().trim().min(1).max(40),
  conversationId: z.string().trim().min(1),
  token: z.string().trim().min(1),
  secret: z.string().trim().min(1).optional(),
}).strict()
export type DingtalkBot = z.infer<typeof DingtalkBotSchema>

/**
 * The Source configuration. Fields are flat because the Settings form edits top-level keys only; the accessors below
 * group them for the code that uses them.
 */
export const DingtalkConfigSchema = z.object({
  groups: z.array(DingtalkGroupSchema)
    .refine(groups => new Set(groups.map(group => group.conversationId)).size === groups.length, 'Duplicate conversation IDs')
    .default([]),
  bots: z.array(DingtalkBotSchema)
    .refine(bots => new Set(bots.map(bot => bot.conversationId)).size === bots.length, 'Duplicate conversation IDs')
    .default([]),
  /** The application robot whose Stream connection receives messages addressed to it. */
  streamClientId: z.string().trim().default(''),
  streamClientSecret: z.string().trim().default(''),
  /** The robot that posts through the OpenAPI; an application robot uses its AppKey. */
  streamRobotCode: z.string().trim().default(''),
  /** The operator's `dws` CLI, which reads a conversation as the operator. */
  dwsEnabled: z.boolean().default(true),
  dwsCli: z.string().trim().min(1).default('dws'),
  dwsPollSeconds: z.number().int().min(10).max(3600).default(60),
  dwsPageSize: z.number().int().min(1).max(100).default(50),
  /** Robot display names whose `@name` in a message counts as addressing the agent; only a history read needs them. */
  mentionNames: z.array(z.object({ name: z.string().trim().min(1).max(40) }).strict())
    .refine(entries => new Set(entries.map(entry => entry.name)).size === entries.length, 'Duplicate robot names')
    .default([]),
  otherChats: z.boolean().default(false),
  directMessages: z.boolean().default(true),
  readPageSize: z.number().int().min(1).max(50).default(20),
  failuresBeforeError: z.number().int().min(1).max(20).default(3),
}).strict()
export type DingtalkConfig = z.infer<typeof DingtalkConfigSchema>

/** The Stream robot credentials, or `undefined` when either half is unset. */
export const streamOf = (config: DingtalkConfig): { clientId: string; clientSecret: string; robotCode?: string } | undefined =>
  config.streamClientId && config.streamClientSecret
    ? { clientId: config.streamClientId, clientSecret: config.streamClientSecret,
      ...config.streamRobotCode ? { robotCode: config.streamRobotCode } : {} }
    : undefined

/** The `dws` settings the readers, the poll loop and the channel share. */
export const dwsOf = (config: DingtalkConfig): { enabled: boolean; cli: string; pollSeconds: number; pageSize: number } =>
  ({ enabled: config.dwsEnabled, cli: config.dwsCli, pollSeconds: config.dwsPollSeconds, pageSize: config.dwsPageSize })