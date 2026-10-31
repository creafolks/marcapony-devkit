import { Hono } from 'hono'
import type { Identity, Reservation, UpdateReservationStatusInput } from 'marcapony-sdk'
import {
  errorResponse,
  identityOf,
  marcaponyFromEnv,
  type Marcapony,
  type MarcaponyBindings,
} from './marcapony'

/**
 * A tool for the business's team: today's reservations with buttons to
 * approve, reject, complete or cancel them. Team members open it from the
 * Marcapony dashboard. Only `/api/*` reaches this worker; everything else is
 * served from `dist/client`.
 *
 * Every call goes through `mp.forRequest(c.req.raw)`, so the platform limits it
 * to the key's scopes, the permissions the owner granted this member and the
 * member's own role. Never keep a scoped client or its answers in module scope.
 */
const app = new Hono<{ Bindings: MarcaponyBindings }>()

const DATE = /^\d{4}-\d{2}-\d{2}$/
const STATUSES = new Set<UpdateReservationStatusInput['status']>([
  'approved',
  'rejected',
  'cancelled',
  'completed',
])
/** The list call has no date filter, so read at most this many pages looking for the day. */
const MAX_PAGES = 5
const PER_PAGE = 100

/** The signed-in team member, or a 401/403 answer to send instead. */
async function memberOf(
  mp: Marcapony,
  env: MarcaponyBindings,
  request: Request,
): Promise<Identity | Response> {
  const who = await identityOf(mp, env, request)
  if (!who) {
    return Response.json(
      { error: 'Open this tool from the Marcapony dashboard while signed in.' },
      { status: 401 },
    )
  }
  if (who.kind !== 'member') {
    return Response.json({ error: 'This tool is for team members only.' }, { status: 403 })
  }
  return who
}

app.get('/api/health', (c) => c.json({ ok: true }))

app.get('/api/me', async (c) => {
  const mp = marcaponyFromEnv(c.env)
  const who = await memberOf(mp, c.env, c.req.raw)
  if (who instanceof Response) return who
  return c.json({ email: who.email, preview: who.preview, canManage: who.can('manage') })
})

/** `?date=YYYY-MM-DD`, sent by the browser so "today" is the member's local day. */
app.get('/api/reservations', async (c) => {
  const mp = marcaponyFromEnv(c.env)
  const who = await memberOf(mp, c.env, c.req.raw)
  if (who instanceof Response) return who

  const date = c.req.query('date') ?? ''
  if (!DATE.test(date)) return c.json({ error: 'date must be YYYY-MM-DD.' }, 400)

  const team = mp.forRequest(c.req.raw)
  const found: Reservation[] = []
  let truncated = false
  for (let page = 1; page <= MAX_PAGES; page++) {
    const result = await team.reservations.list({ page, perPage: PER_PAGE })
    found.push(...result.data.filter((r) => r.requestedDate.startsWith(date)))
    if (page * PER_PAGE >= result.meta.total) break
    if (page === MAX_PAGES) truncated = true
  }
  found.sort((a, b) => a.requestedTime.localeCompare(b.requestedTime))
  return c.json({ reservations: found, truncated })
})

interface StatusBody {
  status?: unknown
  rejectionReason?: unknown
}

app.post('/api/reservations/:id/status', async (c) => {
  const mp = marcaponyFromEnv(c.env)
  const who = await memberOf(mp, c.env, c.req.raw)
  if (who instanceof Response) return who
  // The platform would refuse the write anyway; answering here gives a clear message.
  if (!who.can('manage')) {
    return c.json({ error: 'You are not allowed to change reservations.' }, 403)
  }

  const body = (await c.req.json().catch(() => ({}))) as StatusBody
  const status = body.status as UpdateReservationStatusInput['status']
  if (!STATUSES.has(status)) {
    return c.json({ error: 'status must be approved, rejected, cancelled or completed.' }, 400)
  }
  const input: UpdateReservationStatusInput = { status }
  if (
    status === 'rejected' &&
    typeof body.rejectionReason === 'string' &&
    body.rejectionReason.trim()
  ) {
    input.rejectionReason = body.rejectionReason.trim().slice(0, 500)
  }

  const result = await mp.forRequest(c.req.raw).reservations.updateStatus(c.req.param('id'), input)
  // Simulated in a preview, and in test mode for every member.
  return c.json({ ok: true, simulated: who.preview || result.simulated === true })
})

app.onError((err) => errorResponse(err))

export default app
