import EventForm from '../EventForm'
import s from '../events.module.css'

export default function NewEventPage() {
  return (
    <main className={s.page}>
      <h1 className={s.h1}>Create an event</h1>
      <p className={s.sub}>It stays a draft until you publish it.</p>
      <EventForm mode="create" />
    </main>
  )
}
