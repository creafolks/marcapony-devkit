/** A character the app may talk to, as the account's owner set it up. */
export interface PersonaSummary {
  slug: string
  name: string
  description: string
  avatarUrl: string | null
  /** The first line the character says, before the visitor writes anything. */
  greeting: string
  starterQuestions: string[]
  /**
   * False while the character is switched off, paused for this app or not
   * enabled for apps. A conversation with it answers `PersonaUnavailableError`.
   */
  available: boolean
}

export interface ListPersonasParams {
  /** The locale of the names, descriptions and greetings. Defaults to the account's. */
  locale?: string
}

export interface StartPersonaChatOptions {
  /**
   * Your own opaque id for the player or visitor (never an e-mail address).
   * Marcapony stores only a keyed hash of it, used for the per-player limits.
   */
  endUser?: string
  /** The visitor's IP address, for the limit on new players per address. Never stored. */
  endUserIp?: string
  locale?: string
  /** At most 10 string values of at most 200 characters, kept with the conversation and never shown to the character. */
  metadata?: Record<string, string>
  /**
   * Ask for a bot check (for example Turnstile) before the first message and
   * after every 10 messages: until `verify()` is called, a message answers
   * `VerificationRequiredError`.
   */
  requireVerification?: boolean
  /** Makes a retried start return the same conversation. */
  idempotencyKey?: string
}

/** What the API answers when a conversation starts. */
export interface PersonaConversation {
  conversationId: string
  channel: 'app'
  /** True when Marcapony keeps the transcript; then no history has to be sent. */
  storesTranscripts: boolean
  testMode?: true
}

/**
 * One signed message of a conversation whose transcript Marcapony does not
 * keep. The API signs every answer and every accepted visitor message; send
 * the entries back unchanged with the next message, or it answers 422
 * `invalid_history`.
 */
export interface PersonaHistoryEntry {
  role: 'user' | 'assistant'
  text: string
  messageId: string
  signature: string
}

/** The JSON answer of one message, as the API sends it. */
export interface PersonaMessageResult {
  messageId: string
  text: string
  /** The signature of the answer, when the transcript is not kept. */
  signature?: string
  /** The id and signature of the visitor's message, when the transcript is not kept and the message passed the check. */
  userMessageId?: string
  userSignature?: string
  /** The number of visitor messages in the conversation so far. */
  turn: number
  testMode?: true
}

/** A finished answer. */
export interface PersonaReply {
  /** The id `report()` takes. */
  messageId: string
  text: string
  turn: number
  /** True while the app is in test mode: a cheaper model answered and nothing was charged. */
  testMode: boolean
}

export type PersonaReportReason = 'unsafe' | 'wrong' | 'other'

/** One stored message, from `transcript()`. */
export interface PersonaMessage {
  messageId: string
  role: 'user' | 'assistant'
  text: string
  createdAt: string
}

/** The answer's id, sent before its first text. */
export interface PersonaMessageStartEvent {
  type: 'message_start'
  messageId: string
}

/** A piece of the answer. */
export interface PersonaTextEvent {
  type: 'text'
  content: string
}

/** The character looked something up. */
export interface PersonaToolCallEvent {
  type: 'tool_call'
  id?: string
  name?: string
  args?: unknown
}

export interface PersonaToolResultEvent {
  type: 'tool_result'
  id?: string
  name?: string
  success?: boolean
}

/**
 * The message with this id was withdrawn by the safety check: remove what was
 * shown of it. A new `message_start` follows with the replacement answer.
 */
export interface PersonaRetractEvent {
  type: 'retract'
  messageId: string
}

/** The answer is complete. */
export interface PersonaDoneEvent {
  type: 'done'
  messageId: string
  turn: number
  signature?: string
  userMessageId?: string
  userSignature?: string
  testMode?: true
}

/**
 * The events of a streamed answer. An `error` frame is never yielded: the
 * iterator throws it as the matching `MarcaponyError` subclass instead.
 */
export type PersonaEvent =
  | PersonaMessageStartEvent
  | PersonaTextEvent
  | PersonaToolCallEvent
  | PersonaToolResultEvent
  | PersonaRetractEvent
  | PersonaDoneEvent

export interface PersonaTurnOptions {
  /** Cancels the request. A turn the server already started may still be counted. */
  signal?: AbortSignal
}
