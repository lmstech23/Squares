import pg from 'pg'
const { Pool } = pg
const pool = new Pool({ host: '/tmp', port: 5433, user: 'postgres', database: 'daali', max: 10 })
const uid = () => 'c' + Math.random().toString(36).slice(2, 12)

let failures = 0
const check = (n, pass, d) => { console.log(`${pass ? '  PASS' : '  FAIL'}  ${n}${d ? ' — ' + d : ''}`); if (!pass) failures++ }

async function seed() {
  const eventId = uid(), personId = uid()
  await pool.query(`INSERT INTO daali_events(id,"organizerUserId",title,"startsAt",timezone,status,"updatedAt")
    VALUES ($1,'org','E',now(),'America/New_York','PUBLISHED',now())`, [eventId])
  await pool.query(`INSERT INTO daali_event_people(id,"eventId","identityKey",name,email,"updatedAt")
    VALUES ($1,$2,$3,'P',$3,now())`, [personId, eventId, `${personId}@x.com`])
  return { eventId, personId }
}

/** registerForEvent: RSVP + enqueue in ONE transaction. The send is not here. */
async function rsvpWithEnqueue(eventId, personId, { enqueueThrows = false } = {}) {
  const c = await pool.connect()
  const regId = uid()
  try {
    await c.query('BEGIN')
    await c.query(`SELECT capacity FROM daali_events WHERE id=$1 FOR UPDATE`, [eventId])
    await c.query(`INSERT INTO daali_registrations(id,"eventId","eventPersonId","partySize",status,"actorKind")
      VALUES ($1,$2,$3,2,'CONFIRMED','HUMAN')`, [regId, eventId, personId])

    if (enqueueThrows) throw new Error('simulated enqueue failure')

    const r = await c.query(`INSERT INTO daali_notification_deliveries
      (id,"notificationType","dedupeKey","eventPersonId","registrationId",status,"updatedAt")
      VALUES ($1,'RSVP_CONFIRMED',$2,$3,$4,'pending',now())
      ON CONFLICT ("notificationType","dedupeKey") DO NOTHING RETURNING id`,
      [uid(), `registration:${regId}`, personId, regId])
    await c.query('COMMIT')
    return { regId, deliveryId: r.rows[0]?.id ?? null }
  } catch (e) {
    await c.query('ROLLBACK')
    return { regId: null, error: e.message }
  } finally { c.release() }
}

/** deliverNotification: AFTER commit. Only ever writes NotificationDelivery. */
async function deliver(deliveryId, providerResult) {
  await pool.query(`UPDATE daali_notification_deliveries SET attempts=attempts+1, "updatedAt"=now() WHERE id=$1`, [deliveryId])
  if (providerResult.ok) {
    await pool.query(`UPDATE daali_notification_deliveries
      SET status='sent', "sentAt"=now(), "providerMessageId"=$2, "lastError"=NULL, "updatedAt"=now()
      WHERE id=$1`, [deliveryId, providerResult.id])
  } else {
    await pool.query(`UPDATE daali_notification_deliveries
      SET status='failed', "lastError"=$2, "updatedAt"=now() WHERE id=$1`, [deliveryId, providerResult.error])
  }
}

const reg = async (id) => (await pool.query(`SELECT status,"partySize" FROM daali_registrations WHERE id=$1`, [id])).rows[0]
const del = async (id) => (await pool.query(`SELECT status,attempts,"lastError","sentAt" FROM daali_notification_deliveries WHERE id=$1`, [id])).rows[0]

// ── THE invariant ────────────────────────────────────────────────────────
async function testFailedEmailNeverHarmsRsvp() {
  console.log('\nA failed email must never roll back or invalidate the RSVP')
  const { eventId, personId } = await seed()
  const { regId, deliveryId } = await rsvpWithEnqueue(eventId, personId)

  await deliver(deliveryId, { ok: false, error: 'provider 500' })

  const r = await reg(regId), d = await del(deliveryId)
  check('RSVP is still CONFIRMED after a failed send', r?.status === 'CONFIRMED', `status=${r?.status}`)
  check('party size untouched', r?.partySize === 2)
  check('delivery is visibly failed with the error', d.status === 'failed' && d.lastError === 'provider 500')
  check('the failure is countable', d.attempts === 1, `attempts=${d.attempts}`)
}

async function testTotalProviderOutage() {
  console.log('\nTotal provider outage across many RSVPs')
  const { eventId } = await seed()
  const ids = []
  for (let i = 0; i < 10; i++) {
    const p = uid()
    await pool.query(`INSERT INTO daali_event_people(id,"eventId","identityKey",name,email,"updatedAt")
      VALUES ($1,$2,$3,'P',$3,now())`, [p, eventId, `${p}@x.com`])
    const { regId, deliveryId } = await rsvpWithEnqueue(eventId, p)
    await deliver(deliveryId, { ok: false, error: 'ECONNREFUSED' })
    ids.push(regId)
  }
  const confirmed = (await pool.query(
    `SELECT count(*)::int c FROM daali_registrations WHERE id = ANY($1) AND status='CONFIRMED'`, [ids])).rows[0].c
  check('all 10 RSVPs survive a dead mail provider', confirmed === 10, `${confirmed}/10`)
}

async function testManualResend() {
  console.log('\nManual resend after a failure')
  const { eventId, personId } = await seed()
  const { deliveryId } = await rsvpWithEnqueue(eventId, personId)
  await deliver(deliveryId, { ok: false, error: 'timeout' })
  await deliver(deliveryId, { ok: true, id: 'msg_123' })
  const d = await del(deliveryId)
  check('delivery reaches sent', d.status === 'sent', `status=${d.status}`)
  check('error is cleared on success', d.lastError === null)
  check('both attempts counted', d.attempts === 2, `attempts=${d.attempts}`)
}

async function testDedupeIsPerRegistration() {
  console.log('\nThe dedupe key names the thing being communicated')
  const { eventId, personId } = await seed()
  const a = await rsvpWithEnqueue(eventId, personId)
  await deliver(a.deliveryId, { ok: true, id: 'm1' })

  // Same person cancels and RSVPs again — a NEW registration deserves a NEW receipt.
  await pool.query(`UPDATE daali_registrations SET status='CANCELLED' WHERE id=$1`, [a.regId])
  const b = await rsvpWithEnqueue(eventId, personId)
  check('a second registration gets its own delivery', b.deliveryId !== null && b.deliveryId !== a.deliveryId)

  // Re-enqueueing the SAME registration must not duplicate.
  const dup = await pool.query(`INSERT INTO daali_notification_deliveries
    (id,"notificationType","dedupeKey","eventPersonId","registrationId",status,"updatedAt")
    VALUES ($1,'RSVP_CONFIRMED',$2,$3,$4,'pending',now())
    ON CONFLICT ("notificationType","dedupeKey") DO NOTHING RETURNING id`,
    [uid(), `registration:${a.regId}`, personId, a.regId])
  check('re-enqueue of the same registration is a no-op', dup.rows.length === 0)
}

async function testEnqueueIsInTheTransaction() {
  console.log('\nEnqueue is a local insert inside the RSVP transaction')
  const { eventId, personId } = await seed()
  const res = await rsvpWithEnqueue(eventId, personId, { enqueueThrows: true })
  const orphan = await pool.query(
    `SELECT count(*)::int c FROM daali_registrations WHERE "eventPersonId"=$1`, [personId])
  check('a failed enqueue rolls back with the RSVP — no unconfirmable registration',
    res.regId === null && orphan.rows[0].c === 0, `registrations=${orphan.rows[0].c}`)
}

await testFailedEmailNeverHarmsRsvp()
await testTotalProviderOutage()
await testManualResend()
await testDedupeIsPerRegistration()
await testEnqueueIsInTheTransaction()
await pool.end()
console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
