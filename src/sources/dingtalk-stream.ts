/** Receives DingTalk robot messages over the official Stream long connection. */
import { DWClient, TOPIC_ROBOT } from 'dingtalk-stream'
import { StreamMessageSchema, type DingtalkMessageInput } from './dingtalk-trigger.ts'
import type { Health } from './host.ts'

/** The credentials and identity of the application robot that receives messages. */
export interface StreamConfig {
  clientId: string
  clientSecret: string
  /** The robot that posts; defaults to `clientId`, which is what an application robot uses. */
  robotCode?: string
}

/** What the Stream client reports upward: one normalized message per callback, and its own health. */
export interface StreamHandlers {
  /** Receives a message the robot was addressed in; in a group the platform delivers only addressed messages. */
  message(input: DingtalkMessageInput, robotCode: string): Promise<void>
  /** Reports the connection state, so a refused connection shows on the overview instead of failing silently. */
  report(state: Health['state'], detail: string): void
}

/**
 * Holds one Stream connection and turns its callbacks into domain messages.
 * A connection the platform refuses means the application robot is not published or its receiving mode is not Stream;
 * the failure is reported once, because a person must change it in the DingTalk developer console.
 */
export class DingtalkStream {
  private client: DWClient | undefined
  private stopped = false
  constructor(private readonly config: StreamConfig, private readonly handlers: StreamHandlers) {}
  /** The robot code this connection receives for. */
  get robotCode(): string { return this.config.robotCode ?? this.config.clientId }

  /**
   * Opens the connection and registers the robot message topic.
   * @throws when the credentials are rejected, so the Source reports the failure instead of waiting silently.
   */
  async start(): Promise<void> {
    const client = new DWClient({ clientId: this.config.clientId, clientSecret: this.config.clientSecret, keepAlive: true })
    this.client = client
    client.registerCallbackListener(TOPIC_ROBOT, (frame) => {
      this.handleRobot(frame.data)
      return { status: 'SUCCESS' } as const
    })
    client.on('connect', () => this.handlers.report('ready', `Stream connected as ${this.robotCode}`))
    client.on('disconnect', () => { if (!this.stopped) this.handlers.report('starting', 'Stream disconnected; reconnecting') })
    client.on('error', (error: Error) => this.handlers.report('error', `Stream failed: ${error?.message ?? 'unknown error'}`))
    await client.connect()
  }

  /** Closes the connection; a later `start` opens a new one. */
  stop(): void {
    this.stopped = true
    try { this.client?.disconnect() }
    catch { /* The SDK throws when the socket is already gone; nothing is left to release. */ }
    this.client = undefined
  }

  private handleRobot(data: string): void {
    let parsed: ReturnType<typeof StreamMessageSchema.safeParse>
    try { parsed = StreamMessageSchema.safeParse(JSON.parse(data)) }
    catch { return /* A frame this Source cannot read carries no request; it is acknowledged regardless. */ }
    if (!parsed.success) return
    const message = parsed.data
    const direct = message.conversationType === '1'
    // A message the robot itself sent must never become a request: it would echo the agent's own words back as work.
    if (message.chatbotUserId && message.senderId === message.chatbotUserId) return
    const input: DingtalkMessageInput = {
      messageId: message.msgId,
      conversationId: message.conversationId,
      at: message.createAt,
      text: message.text.content,
      senderId: message.senderStaffId || message.senderId,
      senderName: message.senderNick,
      human: true,
      direct,
      // A group message reaches the robot only when it addresses the robot.
      mentioned: !direct,
      robotCode: message.robotCode ?? this.robotCode,
    }
    void this.handlers.message(input, input.robotCode ?? this.robotCode)
      .catch((error: unknown) => this.handlers.report('error', `Stream message handling failed: ${String(error)}`))
  }
}