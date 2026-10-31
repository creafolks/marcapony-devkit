import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { api, ApiError, errorMessage, newRequestId } from './api'

interface Me {
  email: string
  preview: boolean
  canView: boolean
  canBook: boolean
}

interface Reservation {
  id: string
  requestedDate: string
  requestedTime: string
  duration: number | null
  status: string | number
  notes: string | null
  productName: string | null
}

const CANCELLABLE = new Set(['pending', 'approved'])

export function App() {
  const [me, setMe] = useState<Me | null>(null)
  const [signedOut, setSignedOut] = useState(false)
  const [reservations, setReservations] = useState<Reservation[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  const loadReservations = useCallback(() => {
    api<{ reservations: Reservation[] }>('/api/reservations')
      .then((body) => setReservations(body.reservations))
      .catch((err: unknown) => setError(errorMessage(err)))
  }, [])

  useEffect(() => {
    api<Me>('/api/me')
      .then((body) => {
        setMe(body)
        if (body.canView) loadReservations()
      })
      .catch((err: unknown) => {
        if (err instanceof ApiError && err.status === 401) setSignedOut(true)
        else setError(errorMessage(err))
      })
  }, [loadReservations])

  if (signedOut) {
    return (
      <main>
        <h1>Appointments</h1>
        <p>Sign in to the portal to see and book your appointments.</p>
      </main>
    )
  }

  if (!me) {
    return (
      <main>
        <h1>Appointments</h1>
        {error ? <p className="error">{error}</p> : <p>Loading…</p>}
      </main>
    )
  }

  async function cancel(id: string) {
    setError(null)
    try {
      const body = await api<{ simulated: boolean }>(
        `/api/reservations/${encodeURIComponent(id)}/cancel`,
        { method: 'POST' },
      )
      setNotice(
        body.simulated ? 'Cancellation simulated (test mode or preview). Nothing was saved.' : null,
      )
      loadReservations()
    } catch (err) {
      setError(errorMessage(err))
    }
  }

  return (
    <main>
      <h1>Appointments</h1>
      <p className="muted">Signed in as {me.email}</p>
      {me.preview ? (
        <p className="notice">
          Preview: you are viewing this page as a customer. Bookings and cancellations are simulated
          and nothing is saved.
        </p>
      ) : null}
      {error ? <p className="error">{error}</p> : null}
      {notice ? <p>{notice}</p> : null}

      <h2>My appointments</h2>
      {!me.canView ? <p>You do not have access to your appointment list.</p> : null}
      {me.canView && reservations === null ? <p>Loading…</p> : null}
      {reservations?.length === 0 ? <p>You have no appointments yet.</p> : null}
      <ul className="rows">
        {reservations?.map((reservation) => (
          <li key={reservation.id}>
            <span>
              {reservation.requestedDate} at {reservation.requestedTime}
              {reservation.productName ? `, ${reservation.productName}` : ''}{' '}
              <span className="muted">({String(reservation.status)})</span>
            </span>
            {me.canBook && CANCELLABLE.has(String(reservation.status)) ? (
              <button type="button" onClick={() => void cancel(reservation.id)}>
                Cancel
              </button>
            ) : null}
          </li>
        ))}
      </ul>

      {me.canBook ? <BookingForm onBooked={loadReservations} /> : null}
    </main>
  )
}

function BookingForm({ onBooked }: { onBooked: () => void }) {
  const [date, setDate] = useState('')
  const [time, setTime] = useState('')
  const [notes, setNotes] = useState('')
  // One id per booking attempt: a retry of the same booking (double click,
  // network error) reuses it, and changing what is being booked starts a new one.
  const [requestId, setRequestId] = useState(newRequestId)
  const edit = (set: (value: string) => void) => (value: string) => {
    set(value)
    setRequestId(newRequestId())
  }
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  async function submit(event: FormEvent) {
    event.preventDefault()
    setBusy(true)
    setError(null)
    setMessage(null)
    try {
      const body = await api<{ simulated: boolean }>('/api/reservations', {
        body: { requestId, date, time, notes },
      })
      setMessage(
        body.simulated
          ? 'Booking simulated (test mode or preview). Nothing was saved.'
          : 'Booked. We will confirm it.',
      )
      setRequestId(newRequestId())
      setNotes('')
      onBooked()
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <form onSubmit={(event) => void submit(event)}>
      <h2>Book an appointment</h2>
      <label>
        Date
        <input type="date" required value={date} onChange={(e) => edit(setDate)(e.target.value)} />
      </label>
      <label>
        Time
        <input
          type="time"
          required
          step={900}
          value={time}
          onChange={(e) => edit(setTime)(e.target.value)}
        />
      </label>
      <label>
        Notes (optional)
        <textarea
          rows={3}
          maxLength={500}
          value={notes}
          onChange={(e) => edit(setNotes)(e.target.value)}
        />
      </label>
      <button type="submit" disabled={busy}>
        {busy ? 'Booking…' : 'Book'}
      </button>
      {message ? <p>{message}</p> : null}
      {error ? <p className="error">{error}</p> : null}
    </form>
  )
}
