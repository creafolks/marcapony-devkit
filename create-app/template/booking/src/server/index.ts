import { Hono } from 'hono'
import type { Identity } from 'marcapony-sdk'
import {
  errorResponse,
  identityOf,
  marcaponyFromEnv,
  type Marcapony,
  type MarcaponyBindings,
} from './marcapony'

/**
 * A booking page inside the customer portal. Only `/api/*` reaches this worker;
 * everything else is served from `dist/client` (see `run_worker_first` in
 * marcapony.json).
 *
 * Every call about the visitor goes through `mp.forRequest(c.req.raw).me`, so
 * the platform limits it to the signed-in customer. Never use the plain client
 * for a visitor's own records, and never keep a scoped client or its answers in
 * module scope: one worker serves many visitors.
 */
const app = new Hono<{ Bindings: MarcaponyBindings }>()

const DATE = /^\d{4}-\d{2}-\d{2}$/
const TIME = /^\d{2}:\d{2}$/
const REQUEST_ID = /^[A-Za-z0-9-]{8,64}$/

/** The signed-in customer, or a 401/403 answer to send instead. */
async function customerOf(
  mp: Marcapony,
  env: MarcaponyBindings,
  request: Request,
): Promise<Identity | Response> {
  const who = await identityOf(mp, env, request)
  if (!who) return Response.json({ error: 'Please sign in to the portal.' }, { status: 401 })
  if (who.kind !== 'customer') {
    return Response.json({ error: 'This page is for customers.' }, { status: 403 })
  }
  return who
}

app.get('/api/health', (c) => c.json({ ok: true }))

app.get('/api/me', async (c) => {
  const mp = marcaponyFromEnv(c.env)
  const who = await customerOf(mp, c.env, c.req.raw)
  if (who instanceof Response) return who
  return c.json({
    email: who.email,
    preview: who.preview,
    canView: who.can('view-bookings'),
    canBook: who.can('book'),
  })
})

app.get('/api/reservations', async (c) => {
  const mp = marcaponyFromEnv(c.env)
  const who = await customerOf(mp, c.env, c.req.raw)
  if (who instanceof Response) return who
  const page = await mp.forRequest(c.req.raw).me.reservations.list({ perPage: 50 })
  return c.json({ reservations: page.data })
})

interface CreateBody {
  requestId?: unknown
  date?: unknown
  time?: unknown
  notes?: unknown
}

app.post('/api/reservations', async (c) => {
  const mp = marcaponyFromEnv(c.env)
  const who = await customerOf(mp, c.env, c.req.raw)
  if (who instanceof Response) return who

  const body = (await c.req.json().catch(() => ({}))) as CreateBody
  const { requestId, date, time, notes } = body
  if (typeof requestId !== 'string' || !REQUEST_ID.test(requestId)) {
    return c.json({ error: 'requestId is missing or malformed.' }, 400)
  }
  if (typeof date !== 'string' || !DATE.test(date)) {
    return c.json({ error: 'Pick a date.' }, 400)
  }
  if (typeof time !== 'string' || !TIME.test(time)) {
    return c.json({ error: 'Pick a time.' }, 400)
  }

  // The browser sends one request id per booking attempt and reuses it when it
  // retries, so a double click or a retried request books once. The customer
  // id is part of the key so two visitors can never collide.
  const reservation = await mp.forRequest(c.req.raw).me.reservations.create(
    {
      requestedDate: date,
      requestedTime: time,
      ...(typeof notes === 'string' && notes.trim() ? { notes: notes.trim().slice(0, 500) } : {}),
    },
    { idempotencyKey: `booking-${who.sub}-${requestId}` },
  )
  return c.json({ reservation, simulated: who.preview }, 201)
})

app.post('/api/reservations/:id/cancel', async (c) => {
  const mp = marcaponyFromEnv(c.env)
  const who = await customerOf(mp, c.env, c.req.raw)
  if (who instanceof Response) return who
  const result = await mp.forRequest(c.req.raw).me.reservations.cancel(c.req.param('id'))
  return c.json({ reservation: result, simulated: who.preview })
})

app.onError((err) => errorResponse(err))

export default app
