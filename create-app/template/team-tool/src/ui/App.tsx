import { useCallback, useEffect, useState } from 'react'
import { api, ApiError, errorMessage } from './api'

interface Me {
  email: string
  preview: boolean
  canManage: boolean
}

interface Reservation {
  id: string
  requestedDate: string
  requestedTime: string
  duration: number | null
  status: string | number
  notes: string | null
  customerName: string | null
  customerPhone: string | null
  productName: string | null
}

type NextStatus = 'approved' | 'rejected' | 'cancelled' | 'completed'

/** Which buttons a reservation in each status offers. */
const ACTIONS: Record<string, Array<{ status: NextStatus; label: string }>> = {
  pending: [
    { status: 'approved', label: 'Approve' },
    { status: 'rejected', label: 'Reject' },
  ],
  approved: [
    { status: 'completed', label: 'Complete' },
    { status: 'cancelled', label: 'Cancel' },
  ],
}

/** The member's local day, as YYYY-MM-DD. */
function today(): string {
  const now = new Date()
  const month = String(now.getMonth() + 1).padStart(2, '0')
  const day = String(now.getDate()).padStart(2, '0')
  return `${now.getFullYear()}-${month}-${day}`
}

export function App() {
  const [me, setMe] = useState<Me | null>(null)
  const [denied, setDenied] = useState<string | null>(null)
  const [date, setDate] = useState(today)
  const [reservations, setReservations] = useState<Reservation[] | null>(null)
  const [truncated, setTruncated] = useState(false)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)

  const load = useCallback((day: string) => {
    setReservations(null)
    api<{ reservations: Reservation[]; truncated: boolean }>(
      `/api/reservations?date=${encodeURIComponent(day)}`,
    )
      .then((body) => {
        setReservations(body.reservations)
        setTruncated(body.truncated)
      })
      .catch((err: unknown) => setError(errorMessage(err)))
  }, [])

  useEffect(() => {
    api<Me>('/api/me')
      .then(setMe)
      .catch((err: unknown) => {
        if (err instanceof ApiError && (err.status === 401 || err.status === 403)) {
          setDenied(err.message)
        } else {
          setError(errorMessage(err))
        }
      })
  }, [])

  useEffect(() => {
    if (me) load(date)
  }, [me, date, load])

  async function setStatus(reservation: Reservation, status: NextStatus) {
    let rejectionReason: string | undefined
    if (status === 'rejected') {
      const answer = window.prompt('Reason for rejecting (optional)')
      if (answer === null) return
      rejectionReason = answer
    }
    setBusyId(reservation.id)
    setError(null)
    setMessage(null)
    try {
      const body = await api<{ simulated: boolean }>(
        `/api/reservations/${encodeURIComponent(reservation.id)}/status`,
        { body: { status, rejectionReason } },
      )
      setMessage(
        body.simulated ? 'Change simulated (test mode or preview). Nothing was saved.' : null,
      )
      load(date)
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setBusyId(null)
    }
  }

  if (denied) {
    return (
      <main>
        <h1>Reservations</h1>
        <p>{denied}</p>
      </main>
    )
  }

  if (!me) {
    return (
      <main>
        <h1>Reservations</h1>
        {error ? <p className="error">{error}</p> : <p>Loading…</p>}
      </main>
    )
  }

  return (
    <main>
      <h1>Reservations</h1>
      <p className="muted">Signed in as {me.email}</p>
      {me.preview ? (
        <p className="notice">Preview: status changes are simulated and nothing is saved.</p>
      ) : null}
      {error ? <p className="error">{error}</p> : null}
      {message ? <p>{message}</p> : null}

      <label>
        Day
        <input type="date" value={date} onChange={(e) => setDate(e.target.value || today())} />
      </label>

      {reservations === null ? <p>Loading…</p> : null}
      {reservations?.length === 0 ? <p>No reservations on this day.</p> : null}
      {truncated ? (
        <p className="muted">Only the most recent reservations were searched for this day.</p>
      ) : null}
      <ul className="rows">
        {reservations?.map((reservation) => {
          const actions = me.canManage ? (ACTIONS[String(reservation.status)] ?? []) : []
          return (
            <li key={reservation.id}>
              <span>
                <strong>{reservation.requestedTime}</strong>{' '}
                {reservation.customerName ?? 'Unknown customer'}
                {reservation.productName ? `, ${reservation.productName}` : ''}
                {reservation.duration ? `, ${reservation.duration} min` : ''}{' '}
                <span className="muted">({String(reservation.status)})</span>
                {reservation.notes ? <span className="muted"> {reservation.notes}</span> : null}
              </span>
              {actions.length > 0 ? (
                <span className="actions">
                  {actions.map((action) => (
                    <button
                      key={action.status}
                      type="button"
                      disabled={busyId === reservation.id}
                      onClick={() => void setStatus(reservation, action.status)}
                    >
                      {action.label}
                    </button>
                  ))}
                </span>
              ) : null}
            </li>
          )
        })}
      </ul>
    </main>
  )
}
