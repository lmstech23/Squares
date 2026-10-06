export type FieldError = { field: string; message: string }

export type EventDraftInput = {
  title: string
  startsAt: Date
  endsAt?: Date | null
  timezone: string
  description?: string | null
  venueName?: string | null
  venueAddress?: string | null
  capacity?: number | null
}

function isValidTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz })
    return true
  } catch {
    return false
  }
}

export function validateEventDraft(input: Partial<EventDraftInput>): FieldError[] {
  const errors: FieldError[] = []

  if (input.title !== undefined) {
    const t = input.title.trim()
    if (t.length < 3) errors.push({ field: 'title', message: 'Give the event a name of at least 3 characters.' })
    if (t.length > 140) errors.push({ field: 'title', message: 'Title is too long.' })
  }

  if (input.timezone !== undefined && !isValidTimezone(input.timezone)) {
    errors.push({ field: 'timezone', message: 'Not a recognized time zone.' })
  }

  if (input.startsAt !== undefined && Number.isNaN(input.startsAt.getTime())) {
    errors.push({ field: 'startsAt', message: 'Start time is not a valid date.' })
  }

  if (input.startsAt && input.endsAt && input.endsAt <= input.startsAt) {
    errors.push({ field: 'endsAt', message: 'End time must be after the start time.' })
  }

  if (input.capacity !== undefined && input.capacity !== null) {
    if (!Number.isInteger(input.capacity) || input.capacity < 1) {
      errors.push({ field: 'capacity', message: 'Capacity must be a whole number of at least 1.' })
    }
  }

  return errors
}

/** Publishing demands more than drafting. A draft may be half-finished; a live page may not. */
export function validateForPublish(e: {
  title: string; startsAt: Date; timezone: string
}): FieldError[] {
  const errors = validateEventDraft(e)
  if (!e.title?.trim()) errors.push({ field: 'title', message: 'An event needs a name before it goes live.' })
  return errors
}
