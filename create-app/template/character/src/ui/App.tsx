import { useEffect, useRef, useState } from 'react'
import { api, errorMessage } from './api'

interface Character {
  slug: string
  name: string
  description: string
  avatarUrl: string | null
  greeting: string
  starterQuestions: string[]
  available: boolean
}

/** A signed entry of the conversation. Kept as it came back and sent back unchanged. */
interface HistoryEntry {
  role: 'user' | 'assistant'
  text: string
  messageId: string
  signature: string
}

interface Line {
  role: 'user' | 'assistant'
  text: string
  /** The answer's id, for reporting it. */
  messageId?: string
}

interface Saved {
  conversationId: string | null
  history: HistoryEntry[]
  lines: Line[]
}

/** One conversation per browser tab: it ends when the tab is closed. */
const STORAGE_KEY = 'character-chat'

function load(): Saved {
  try {
    const parsed = JSON.parse(sessionStorage.getItem(STORAGE_KEY) ?? 'null') as Saved | null
    if (parsed && Array.isArray(parsed.history) && Array.isArray(parsed.lines)) return parsed
  } catch {
    // A broken entry starts a new conversation.
  }
  return { conversationId: null, history: [], lines: [] }
}

/** What the server answers when it cannot take the message. */
class ChatError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly turnstileSiteKey?: string,
  ) {
    super(message)
  }
}

/** Shown instead of the raw error when the character cannot answer for now. */
function friendly(err: unknown): string {
  if (err instanceof ChatError) {
    if (err.code === 'persona_unavailable' || err.code === 'feature_paused') {
      return 'The character is resting right now. Try again later.'
    }
    if (err.code.endsWith('_cap') || err.code.endsWith('_reached')) {
      return 'The character has talked enough for today. Come back tomorrow.'
    }
    if (err.code === 'rate_limited') return 'Too many messages at once. Wait a moment.'
  }
  return errorMessage(err)
}

declare global {
  interface Window {
    turnstile?: {
      render: (
        element: HTMLElement,
        options: { sitekey: string; callback: (token: string) => void },
      ) => string
      remove: (id: string) => void
    }
  }
}

/** Shows the Turnstile widget and resolves with its token. */
async function turnstileToken(siteKey: string, element: HTMLElement): Promise<string> {
  if (!window.turnstile) {
    await new Promise<void>((resolve, reject) => {
      const script = document.createElement('script')
      script.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit'
      script.onload = () => resolve()
      script.onerror = () => reject(new Error('The visitor check could not load'))
      document.head.appendChild(script)
    })
  }
  return new Promise((resolve) => {
    const id = window.turnstile!.render(element, {
      sitekey: siteKey,
      callback: (token) => {
        window.turnstile!.remove(id)
        resolve(token)
      },
    })
  })
}

export function App() {
  const [character, setCharacter] = useState<Character | null>(null)
  const [saved, setSaved] = useState<Saved>(load)
  const [draft, setDraft] = useState('')
  // The answer being written, shown below the finished lines.
  const [partial, setPartial] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [checking, setChecking] = useState(false)
  const widget = useRef<HTMLDivElement>(null)

  useEffect(() => {
    api<Character>('/api/character')
      .then(setCharacter)
      .catch((err: unknown) => setError(errorMessage(err)))
  }, [])

  useEffect(() => {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(saved))
  }, [saved])

  const base = character ? `/api/chat/${encodeURIComponent(character.slug)}` : ''

  async function conversationId(): Promise<string> {
    if (saved.conversationId) return saved.conversationId
    const started = await api<{ conversationId: string }>(`${base}/conversations`, {
      body: { locale: navigator.language.slice(0, 2) },
    })
    setSaved((previous) => ({ ...previous, conversationId: started.conversationId }))
    return started.conversationId
  }

  /** Sends one message and reads the streamed answer. */
  async function stream(id: string, text: string, token?: string): Promise<void> {
    const response = await fetch(`${base}/conversations/${id}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
      body: JSON.stringify({ text, history: saved.history, turnstileToken: token }),
    })
    if (!response.ok || !response.body) {
      const body = (await response.json().catch(() => ({}))) as {
        code?: string
        error?: string
        turnstileSiteKey?: string
      }
      throw new ChatError(
        body.code ?? 'server_error',
        body.error ?? `Request failed with status ${response.status}`,
        body.turnstileSiteKey,
      )
    }

    const reader = response.body.pipeThrough(new TextDecoderStream()).getReader()
    let buffer = ''
    let answer = ''
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += value
      const frames = buffer.split('\n\n')
      buffer = frames.pop() ?? ''
      for (const frame of frames) {
        if (!frame.startsWith('data: ')) continue
        const event = JSON.parse(frame.slice('data: '.length)) as Record<string, unknown>
        if (event.type === 'message_start') {
          answer = ''
          setPartial('')
        } else if (event.type === 'text') {
          answer += String(event.content)
          setPartial(answer)
        } else if (event.type === 'retract') {
          // The safety check withdrew what was shown; a replacement follows.
          answer = ''
          setPartial('')
        } else if (event.type === 'error') {
          throw new ChatError(String(event.code), String(event.error))
        } else if (event.type === 'done') {
          const finished = answer
          setSaved((previous) => ({
            ...previous,
            history: event.history as HistoryEntry[],
            lines: [
              ...previous.lines,
              { role: 'assistant', text: finished, messageId: String(event.messageId) },
            ],
          }))
        }
      }
    }
  }

  async function send(text: string) {
    const trimmed = text.trim()
    if (!trimmed || !character || busy) return
    setBusy(true)
    setError(null)
    setDraft('')
    setSaved((previous) => ({
      ...previous,
      lines: [...previous.lines, { role: 'user', text: trimmed }],
    }))
    try {
      const id = await conversationId()
      try {
        await stream(id, trimmed)
      } catch (err) {
        // A visitor check is due: show the widget, then send once more with its token.
        if (!(err instanceof ChatError && err.code === 'verification_required')) throw err
        if (!err.turnstileSiteKey || !widget.current) throw err
        setChecking(true)
        const token = await turnstileToken(err.turnstileSiteKey, widget.current).finally(() =>
          setChecking(false),
        )
        await stream(id, trimmed, token)
      }
    } catch (err) {
      setError(friendly(err))
    } finally {
      setPartial(null)
      setBusy(false)
    }
  }

  async function report(messageId: string) {
    if (!saved.conversationId) return
    try {
      await api(`${base}/conversations/${saved.conversationId}/reports`, {
        body: { messageId, reason: 'unsafe' },
      })
      setError('Thank you. The message was reported to the business.')
    } catch (err) {
      setError(errorMessage(err))
    }
  }

  function restart() {
    setSaved({ conversationId: null, history: [], lines: [] })
    setError(null)
  }

  if (!character) {
    return <main>{error ? <p className="error">{error}</p> : <p>Loading…</p>}</main>
  }

  return (
    <main>
      <h1>{character.name}</h1>
      {character.description ? <p className="muted">{character.description}</p> : null}
      {!character.available ? (
        <p className="notice">The character is resting right now. Try again later.</p>
      ) : null}

      <ul className="rows">
        {character.greeting ? (
          <li>
            <span>{character.greeting}</span>
          </li>
        ) : null}
        {saved.lines.map((line, i) => (
          <li key={`${i}-${line.role}`}>
            <span className={line.role === 'user' ? 'muted' : undefined}>
              {line.role === 'user' ? 'You: ' : ''}
              {line.text}
            </span>
            {line.messageId ? (
              <button type="button" onClick={() => void report(line.messageId!)}>
                Report
              </button>
            ) : null}
          </li>
        ))}
        {partial !== null ? (
          <li>
            <span>{partial || '…'}</span>
          </li>
        ) : null}
      </ul>

      {saved.lines.length === 0 && character.starterQuestions.length > 0 ? (
        <p className="actions">
          {character.starterQuestions.map((question) => (
            <button
              key={question}
              type="button"
              disabled={busy}
              onClick={() => void send(question)}
            >
              {question}
            </button>
          ))}
        </p>
      ) : null}

      <div ref={widget} />
      {checking ? <p className="muted">One moment: a quick check that you are not a bot.</p> : null}
      {error ? <p className="error">{error}</p> : null}

      <form
        onSubmit={(event) => {
          event.preventDefault()
          void send(draft)
        }}
      >
        <label>
          Message
          <textarea
            value={draft}
            maxLength={2000}
            rows={3}
            onChange={(event) => setDraft(event.target.value)}
          />
        </label>
        <p className="actions">
          <button type="submit" disabled={busy || !character.available || !draft.trim()}>
            {busy ? 'Writing…' : 'Send'}
          </button>
          <button type="button" disabled={busy} onClick={restart}>
            New conversation
          </button>
        </p>
      </form>
    </main>
  )
}
