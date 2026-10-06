import pg from 'pg'
const { Pool } = pg
const pool = new Pool({ host: '/tmp', port: 5433, user: 'postgres', database: 'daali', max: 30 })

const uid = () => 'c' + Math.random().toString(36).slice(2, 12)

async function seedEvent(capacity) {
  const id = uid()
  await pool.query(
    `INSERT INTO "Event"(id,"organizerUserId",title,"startsAt",timezone,status,capacity,"updatedAt")
     VALUES ($1,'org','Field Day', now(), 'America/New_York','PUBLISHED',$2, now())`, [id, capacity])
  return id
}

async function seedPerson(eventId, i) {
  const id = uid()
  await pool.query(
    `INSERT INTO "EventPerson"(id,"eventId","identityKey",name,email,"updatedAt")
     VALUES ($1,$2,$3,$4,$5, now())`,
    [id, eventId, `p${i}@x.com`, `P${i}`, `p${i}@x.com`])
  return id
}

/**
 * EXACTLY the strategy registerForEvent uses:
 *   lock the Event row, derive seats from CONFIRMED registrations, all-or-nothing.
 * No stored counter anywhere.
 */
async function rsvp(eventId, personId, partySize) {
  const c = await pool.connect()
  try {
    await c.query('BEGIN')
    const ev = await c.query(`SELECT capacity FROM "Event" WHERE id=$1 FOR UPDATE`, [eventId])
    const cap = ev.rows[0].capacity
    const taken = Number((await c.query(
      `SELECT COALESCE(SUM("partySize"),0)::int AS seats FROM "Registration"
        WHERE "eventId"=$1 AND status='CONFIRMED'`, [eventId])).rows[0].seats)

    if (cap !== null && taken + partySize > cap) {
      await c.query('ROLLBACK')
      return { ok: false, remaining: cap - taken }
    }
    await c.query(
      `INSERT INTO "Registration"(id,"eventId","eventPersonId","partySize",status,"actorKind")
       VALUES ($1,$2,$3,$4,'CONFIRMED','HUMAN')`, [uid(), eventId, personId, partySize])
    await c.query('COMMIT')
    return { ok: true }
  } catch (e) {
    await c.query('ROLLBACK')
    return { ok: false, error: e.code }
  } finally { c.release() }
}

async function seats(eventId) {
  return Number((await pool.query(
    `SELECT COALESCE(SUM("partySize"),0)::int AS s FROM "Registration"
      WHERE "eventId"=$1 AND status='CONFIRMED'`, [eventId])).rows[0].s)
}

let failures = 0
const check = (name, pass, detail) => {
  console.log(`${pass ? '  PASS' : '  FAIL'}  ${name}${detail ? ' — ' + detail : ''}`)
  if (!pass) failures++
}

// ── THE test: 20 concurrent RSVPs, 10 seats ──────────────────────────────
async function test20v10() {
  console.log('\n20 concurrent RSVPs against 10 seats')
  const eventId = await seedEvent(10)
  const people = await Promise.all([...Array(20)].map((_, i) => seedPerson(eventId, i)))
  const results = await Promise.all(people.map((p) => rsvp(eventId, p, 1)))
  const confirmed = results.filter((r) => r.ok).length
  const taken = await seats(eventId)
  check('exactly 10 confirmed', confirmed === 10, `${confirmed} confirmed, ${20 - confirmed} rejected`)
  check('seats never exceed capacity', taken === 10, `seatsTaken=${taken}`)
}

// ── party size: all-or-nothing, never a partial admit ────────────────────
async function testPartyAllOrNothing() {
  console.log('\n10 concurrent parties of 3 against 10 seats')
  const eventId = await seedEvent(10)
  const people = await Promise.all([...Array(10)].map((_, i) => seedPerson(eventId, i)))
  const results = await Promise.all(people.map((p) => rsvp(eventId, p, 3)))
  const confirmed = results.filter((r) => r.ok).length
  const taken = await seats(eventId)
  check('3 parties fit, 1 seat left unsold', confirmed === 3 && taken === 9, `confirmed=${confirmed} seats=${taken}`)
  check('no party was partially admitted', taken % 3 === 0, `seatsTaken=${taken}`)
}

// ── cancellation frees seats, because the count is derived ───────────────
async function testCancelFrees() {
  console.log('\ncancellation frees seats')
  const eventId = await seedEvent(2)
  const [a, b, c] = await Promise.all([0, 1, 2].map((i) => seedPerson(eventId, i)))
  await rsvp(eventId, a, 1); await rsvp(eventId, b, 1)
  const blocked = await rsvp(eventId, c, 1)
  check('third is rejected while full', !blocked.ok)
  await pool.query(
    `UPDATE "Registration" SET status='CANCELLED', "cancelledAt"=now()
      WHERE "eventPersonId"=$1`, [a])
  const after = await rsvp(eventId, c, 1)
  check('third gets in after a cancellation', after.ok, `seatsTaken=${await seats(eventId)}`)
}

// ── the partial unique index ─────────────────────────────────────────────
async function testLiveIndex() {
  console.log('\none live registration per person')
  const eventId = await seedEvent(null)
  const p = await seedPerson(eventId, 0)
  const first = await rsvp(eventId, p, 1)
  const dup = await rsvp(eventId, p, 1)
  check('first RSVP succeeds', first.ok)
  check('duplicate live RSVP is blocked by the index', !dup.ok && dup.error === '23505', `code=${dup.error}`)
  await pool.query(`UPDATE "Registration" SET status='CANCELLED' WHERE "eventPersonId"=$1`, [p])
  const again = await rsvp(eventId, p, 1)
  check('re-RSVP after cancelling is allowed', again.ok)
}

// ── uncapped events ──────────────────────────────────────────────────────
async function testUncapped() {
  console.log('\nuncapped event')
  const eventId = await seedEvent(null)
  const people = await Promise.all([...Array(15)].map((_, i) => seedPerson(eventId, i)))
  const r = await Promise.all(people.map((p) => rsvp(eventId, p, 2)))
  check('all 15 admitted', r.every((x) => x.ok), `seatsTaken=${await seats(eventId)}`)
}

await test20v10()
await testPartyAllOrNothing()
await testCancelFrees()
await testLiveIndex()
await testUncapped()
await pool.end()
console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
