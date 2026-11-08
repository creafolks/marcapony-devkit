import { errorFromResponse, PERSONA_LIMIT_CODES, ServerError } from '../errors.js'
import { path, type ApiPath } from '../path.js'
import { create, get, unwrap, type Transport } from '../transport.js'
import type {
  ListPersonasParams,
  PersonaConversation,
  PersonaDoneEvent,
  PersonaEvent,
  PersonaHistoryEntry,
  PersonaMessage,
  PersonaMessageResult,
  PersonaReply,
  PersonaReportReason,
  PersonaSummary,
  PersonaTurnOptions,
  StartPersonaChatOptions,
} from '../types/index.js'

/** A message can take a while: the whole answer, or the whole stream, gets this long. */
export const PERSONA_MESSAGE_TIMEOUT_MS = 120_000
/** The most history entries the API accepts with one message. */
export const PERSONA_HISTORY_MAX_ENTRIES = 30
/** The longest history entry the API accepts. */
export const PERSONA_HISTORY_MAX_CHARS = 2000

export interface ResumePersonaChatOptions {
  /** The signed entries kept from earlier messages of this conversation. */
  history?: readonly PersonaHistoryEntry[]
  /** Whether Marcapony keeps the transcript, as `start` reported it. When true, no history is sent. */
  storesTranscripts?: boolean
}

/**
 * One conversation with a character. Send one message at a time: a second
 * `send` or `stream` while one is running throws.
 */
export interface PersonaChat {
  /** The conversation id. Store it to `resume` the conversation later. */
  readonly id: string
  readonly slug: string
  /** True when Marcapony keeps the transcript; null when not known (after `resume` without it). */
  readonly storesTranscripts: boolean | null
  /** True while the app is in test mode, as `start` reported it. */
  readonly testMode: boolean
  /**
   * The signed entries sent with each message when the transcript is not kept,
   * extended after every answer: at most 30, the oldest dropped first.
   */
  readonly history: readonly PersonaHistoryEntry[]
  /** Sends a message and waits for the whole answer. Never retried. */
  send(text: string, options?: PersonaTurnOptions): Promise<PersonaReply>
  /**
   * Sends a message and yields the answer as it is written. Never retried.
   * The history is extended once `done` arrives; stopping early leaves it as
   * it was.
   */
  stream(text: string, options?: PersonaTurnOptions): AsyncIterable<PersonaEvent>
  /** Reports an answer as unsafe, wrong or otherwise bad. */
  report(messageId: string, reason: PersonaReportReason, options?: { note?: string }): Promise<void>
  /** Tells Marcapony that you checked the visitor (for example with Turnstile). */
  verify(): Promise<void>
  /** The stored messages, when Marcapony keeps the transcript (otherwise `NotFoundError`). */
  transcript(): Promise<PersonaMessage[]>
}

function messagesPath(slug: string, id: string): ApiPath {
  return path`/personas/${slug}/conversations/${id}/messages`
}

/** The entries one finished turn adds to the history, in order. */
function turnEntries(
  userText: string,
  answer: Pick<PersonaMessageResult, 'messageId' | 'text' | 'signature'> &
    Pick<PersonaDoneEvent, 'userMessageId' | 'userSignature'>,
): PersonaHistoryEntry[] {
  const entries: PersonaHistoryEntry[] = []
  // A message the safety check refused comes back without a signature and
  // never goes back to the character.
  if (answer.userMessageId && answer.userSignature) {
    entries.push({
      role: 'user',
      // The API signs the message as it read it: trimmed.
      text: userText.trim(),
      messageId: answer.userMessageId,
      signature: answer.userSignature,
    })
  }
  if (answer.signature) {
    entries.push({
      role: 'assistant',
      text: answer.text,
      messageId: answer.messageId,
      signature: answer.signature,
    })
  }
  return entries
}

/**
 * The history after a turn: within the API's limits, so the next message is
 * accepted. A signed entry cannot be shortened, so an answer over the length
 * limit is left out rather than cut.
 */
export function extendHistory(
  history: readonly PersonaHistoryEntry[],
  added: readonly PersonaHistoryEntry[],
): PersonaHistoryEntry[] {
  return [...history, ...added]
    .filter((entry) => entry.text.length <= PERSONA_HISTORY_MAX_CHARS)
    .slice(-PERSONA_HISTORY_MAX_ENTRIES)
}

function isEvent(value: unknown): value is { type: string; [key: string]: unknown } {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { type?: unknown }).type === 'string'
  )
}

/** The HTTP status an error frame in a stream stands for. */
function statusOfStreamError(code: string): number {
  if (code === 'persona_unavailable') return 403
  if (['service_unavailable', 'feature_paused', 'beta_budget_reached'].includes(code)) return 503
  if (code === 'rate_limited' || (PERSONA_LIMIT_CODES as readonly string[]).includes(code)) {
    return 429
  }
  return 500
}

class Chat implements PersonaChat {
  private entries: PersonaHistoryEntry[]
  private busy = false

  constructor(
    private readonly t: Transport,
    readonly slug: string,
    readonly id: string,
    readonly storesTranscripts: boolean | null,
    readonly testMode: boolean,
    history: readonly PersonaHistoryEntry[],
  ) {
    // Validated before any request: an empty or dotted id would reach another route.
    messagesPath(slug, id)
    this.entries = [...history]
  }

  get history(): readonly PersonaHistoryEntry[] {
    return this.entries
  }

  private body(text: string): { text: string; history?: PersonaHistoryEntry[] } {
    return this.storesTranscripts === true ? { text } : { text, history: this.entries }
  }

  private claim(): void {
    if (this.busy) {
      throw new Error(
        'marcapony-sdk: a message of this conversation is still running. Wait for it before sending the next.',
      )
    }
    this.busy = true
  }

  async send(text: string, options?: PersonaTurnOptions): Promise<PersonaReply> {
    this.claim()
    try {
      const result = unwrap(
        await this.t.request<{ data: PersonaMessageResult }>({
          method: 'POST',
          path: messagesPath(this.slug, this.id),
          body: this.body(text),
          timeoutMs: PERSONA_MESSAGE_TIMEOUT_MS,
          retry: false,
          signal: options?.signal,
        }),
      )
      this.entries = extendHistory(this.entries, turnEntries(text, result))
      return {
        messageId: result.messageId,
        text: result.text,
        turn: result.turn,
        testMode: result.testMode === true,
      }
    } finally {
      this.busy = false
    }
  }

  stream(text: string, options?: PersonaTurnOptions): AsyncIterable<PersonaEvent> {
    return { [Symbol.asyncIterator]: () => this.run(text, options) }
  }

  private async *run(text: string, options?: PersonaTurnOptions): AsyncGenerator<PersonaEvent> {
    this.claim()
    const route = messagesPath(this.slug, this.id)
    try {
      // The text of each message, by id, as the server signs it.
      const texts = new Map<string, string>()
      let current: string | null = null
      for await (const frame of this.t.stream({
        method: 'POST',
        path: route,
        body: this.body(text),
        timeoutMs: PERSONA_MESSAGE_TIMEOUT_MS,
        signal: options?.signal,
      })) {
        if (!isEvent(frame)) continue
        if (frame.type === 'error') {
          const code = typeof frame.code === 'string' ? frame.code : 'server_error'
          const message = typeof frame.error === 'string' ? frame.error : 'The answer failed'
          throw errorFromResponse(statusOfStreamError(code), { error: { code, message } }, null, {
            method: 'POST',
            path: route,
          })
        }
        const event = frame as unknown as PersonaEvent
        if (event.type === 'message_start') {
          current = event.messageId
          texts.set(current, '')
        } else if (event.type === 'text' && current !== null) {
          texts.set(current, (texts.get(current) ?? '') + event.content)
        } else if (event.type === 'done') {
          const answer = texts.get(event.messageId) ?? ''
          this.entries = extendHistory(this.entries, turnEntries(text, { ...event, text: answer }))
          yield event
          return
        }
        yield event
      }
      throw new ServerError(
        0,
        'server_error',
        `POST ${route}: the stream ended before the answer was complete`,
      )
    } finally {
      this.busy = false
    }
  }

  async report(
    messageId: string,
    reason: PersonaReportReason,
    options?: { note?: string },
  ): Promise<void> {
    await create(this.t, path`/personas/${this.slug}/conversations/${this.id}/reports`, {
      messageId,
      reason,
      ...(options?.note ? { note: options.note } : {}),
    })
  }

  async verify(): Promise<void> {
    await create(this.t, path`/personas/${this.slug}/conversations/${this.id}/verify`)
  }

  transcript(): Promise<PersonaMessage[]> {
    return get(this.t, messagesPath(this.slug, this.id))
  }
}

export function personasResource(transport: Transport) {
  return {
    /** The characters this app may talk to. */
    list: (params?: ListPersonasParams): Promise<PersonaSummary[]> =>
      get(transport, path`/personas`, params),
    /** One character by slug. A character not granted to this app answers `NotFoundError`. */
    get: (slug: string, params?: ListPersonasParams): Promise<PersonaSummary> =>
      get(transport, path`/personas/${slug}`, params),
    /** Starts a conversation. */
    start: async (slug: string, options: StartPersonaChatOptions = {}): Promise<PersonaChat> => {
      const { idempotencyKey, ...input } = options
      const started = await create<PersonaConversation>(
        transport,
        path`/personas/${slug}/conversations`,
        input,
        { idempotencyKey },
      )
      return new Chat(
        transport,
        slug,
        started.conversationId,
        started.storesTranscripts,
        started.testMode === true,
        [],
      )
    },
    /** Continues a conversation the app stored. Makes no request. */
    resume: (
      slug: string,
      conversationId: string,
      options: ResumePersonaChatOptions = {},
    ): PersonaChat =>
      new Chat(
        transport,
        slug,
        conversationId,
        options.storesTranscripts ?? null,
        false,
        options.history ?? [],
      ),
  }
}

/**
 * Conversations with the account's characters. Only on the client from
 * `createClient`: calls on behalf of a signed-in person (`forRequest`) cannot
 * reach characters.
 */
export type PersonasResource = ReturnType<typeof personasResource>
