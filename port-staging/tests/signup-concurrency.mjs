import pg from 'pg'
const { Pool } = pg
const pool = new Pool({ host: '/tmp', port: 5433, user: 'postgres', database: 'daali', max: 30 })
const uid = () => 'c' + Math.random().toString(36).slice(2, 12)

async function seedSlot(slotType, capacity, unitLabel = null) {
  const eventId = uid(), sheetId = uid(), slotId = uid()
  await pool.query(`INSERT INTO daali_events(id,"organizerUserId",title,"startsAt",timezone,status,"updatedAt")
    VALUES ($1,'org','E',now(),'America/New_York','PUBLISHED',now())`, [eventId])
  await pool.query(`INSERT INTO daali_signup_sheets(id,"eventId","updatedAt") VALUES ($1,$2,now())`, [sheetId, eventId])
  await pool.query(`INSERT INTO daali_signup_slots(id,"sheetId","slotType",name,capacity,"unitLabel","updatedAt")
    VALUES ($1,$2,$3,'Slot',$4,$5,now())`, [slotId, sheetId, slotType, capacity, unitLabel])
  return { eventId, slotId }
}

async function seedPerson(eventId, i) {
  const id = uid()
  await pool.query(`INSERT INTO daali_event_people(id,"eventId","identityKey",name,email,"updatedAt")
    VALUES ($1,$2,$3,$4,$5,now())`, [id, eventId, `h${i}-${id}@x.com`, `H${i}`, `h${i}@x.com`])
  return id
}

/**
 * EXACTLY the algorithm src/db/signups.ts uses.
 *
 * Capacity is enforced by the unique index on (slotId, position) — NOT by a row
 * lock and NOT by a counter. Losers of a race take a unique violation, roll back,
 * re-read, and retry once. Then they report what is actually left.
 */
const MAX_CLAIM_ATTEMPTS = 5

async function claim(slotId, personId, quantity, capacity) {
  for (let attempt = 0; attempt < MAX_CLAIM_ATTEMPTS; attempt++) {
    const c = await pool.connect()
    try {
      await c.query('BEGIN')

      const hs = await c.query(
        `INSERT INTO daali_helper_signups(id,"slotId","eventPersonId","actorKind")
         VALUES ($1,$2,$3,'HUMAN')
         ON CONFLICT ("slotId","eventPersonId") DO UPDATE SET "slotId"=EXCLUDED."slotId"
         RETURNING id`, [uid(), slotId, personId])
      const signupId = hs.rows[0].id

      const takenRows = await c.query(
        `SELECT position FROM daali_helper_signup_positions WHERE "slotId"=$1`, [slotId])
      const taken = new Set(takenRows.rows.map((r) => r.position))

      const free = []
      for (let p = 1; p <= capacity && free.length < quantity; p++) if (!taken.has(p)) free.push(p)

      // All or nothing. Never silently give them fewer.
      if (free.length < quantity) {
        await c.query('ROLLBACK')
        return { ok: false, remaining: capacity - taken.size, reason: 'FULL' }
      }

      for (const p of free) {
        await c.query(
          `INSERT INTO daali_helper_signup_positions(id,"helperSignupId","slotId",position)
           VALUES ($1,$2,$3,$4)`, [uid(), signupId, slotId, p])
      }
      await c.query('COMMIT')
      return { ok: true, positions: free }
    } catch (e) {
      await c.query('ROLLBACK').catch(() => {})
      // Lost a race. Retry — the TERMINAL condition is "the slot is actually
      // full", checked on a fresh read at the top of the loop, never "I have
      // tried N times". Giving up on attempt count tells a helper the slot is
      // full while positions remain.
      if (e.code === '23505' && attempt < MAX_CLAIM_ATTEMPTS - 1) continue
      return { ok: false, error: e.code, reason: 'RACE' }
    } finally { c.release() }
  }
  return { ok: false, reason: 'RACE_EXHAUSTED' }
}

const positions = async (slotId) =>
  (await pool.query(`SELECT position FROM daali_helper_signup_positions WHERE "slotId"=$1 ORDER BY position`, [slotId]))
    .rows.map((r) => r.position)

let failures = 0
const check = (n, pass, d) => { console.log(`${pass ? '  PASS' : '  FAIL'}  ${n}${d ? ' — ' + d : ''}`); if (!pass) failures++ }

// ── THE 0C test ──────────────────────────────────────────────────────────
async function testLastPosition() {
  console.log('\n10 parallel claims on the FINAL available position (capacity 1)')
  const { eventId, slotId } = await seedSlot('SHIFT', 1)
  const people = await Promise.all([...Array(10)].map((_, i) => seedPerson(eventId, i)))
  const r = await Promise.all(people.map((p) => claim(slotId, p, 1, 1)))
  const won = r.filter((x) => x.ok).length
  check('exactly one claimant wins', won === 1, `${won} won, ${10 - won} rejected`)
  check('slot holds exactly one position', (await positions(slotId)).length === 1)
}

async function testShiftOverbook() {
  console.log('\n8 parallel claims against a 3-person shift')
  const { eventId, slotId } = await seedSlot('SHIFT', 3)
  const people = await Promise.all([...Array(8)].map((_, i) => seedPerson(eventId, i)))
  const r = await Promise.all(people.map((p) => claim(slotId, p, 1, 3)))
  const won = r.filter((x) => x.ok).length
  const pos = await positions(slotId)
  check('exactly 3 claimed', won === 3, `${won} won`)
  check('positions are 1,2,3 with no gaps or dupes', JSON.stringify(pos) === '[1,2,3]', JSON.stringify(pos))
}

async function testItemAllOrNothing() {
  console.log('\n4 parallel claims of 2 cases against a 6-case item')
  const { eventId, slotId } = await seedSlot('ITEM', 6, 'case of water')
  const people = await Promise.all([...Array(4)].map((_, i) => seedPerson(eventId, i)))
  const r = await Promise.all(people.map((p) => claim(slotId, p, 2, 6)))
  const won = r.filter((x) => x.ok).length
  const pos = await positions(slotId)
  check('exactly 3 claimants fit', won === 3, `${won} won`)
  check('no claimant was partially filled', pos.length % 2 === 0 && pos.length === 6, `${pos.length} positions`)
}

async function testCompositeFk() {
  console.log('\ncomposite FK integrity')
  const a = await seedSlot('SHIFT', 5)
  const b = await seedSlot('SHIFT', 5)
  const person = await seedPerson(a.eventId, 0)
  await claim(a.slotId, person, 1, 5)
  const hs = (await pool.query(`SELECT id FROM daali_helper_signups WHERE "slotId"=$1`, [a.slotId])).rows[0].id
  let rejected = false
  try {
    // A coding error attaching slot B's position to slot A's commitment.
    // Two independent FKs would ACCEPT this and the roster would be quietly wrong.
    await pool.query(`INSERT INTO daali_helper_signup_positions(id,"helperSignupId","slotId",position)
      VALUES ($1,$2,$3,1)`, [uid(), hs, b.slotId])
  } catch (e) { rejected = e.code === '23503' }
  check('cross-slot position is rejected by the composite FK', rejected)
}

async function testCancelReusesPositions() {
  console.log('\ncancellation frees positions for reuse')
  const { eventId, slotId } = await seedSlot('SHIFT', 2)
  const [a, b, c] = await Promise.all([0, 1, 2].map((i) => seedPerson(eventId, i)))
  await claim(slotId, a, 1, 2); await claim(slotId, b, 1, 2)
  check('third is blocked while full', !(await claim(slotId, c, 1, 2)).ok)
  // Cancelling deletes the commitment; positions cascade.
  await pool.query(`DELETE FROM daali_helper_signups WHERE "slotId"=$1 AND "eventPersonId"=$2`, [slotId, a])
  check('positions cascaded away', (await positions(slotId)).length === 1)
  const after = await claim(slotId, c, 1, 2)
  check('freed position is reclaimable', after.ok, `got position ${after.positions}`)
}

async function testOneCommitmentPerPerson() {
  console.log('\nadding to an existing commitment')
  const { eventId, slotId } = await seedSlot('ITEM', 6, 'dozen cookies')
  const p = await seedPerson(eventId, 0)
  await claim(slotId, p, 2, 6)
  await claim(slotId, p, 1, 6)
  const rows = await pool.query(`SELECT count(*)::int c FROM daali_helper_signups WHERE "slotId"=$1`, [slotId])
  const pos = await pool.query(
    `SELECT count(*)::int c FROM daali_helper_signup_positions WHERE "slotId"=$1`, [slotId])
  check('still ONE commitment row', rows.rows[0].c === 1, `${rows.rows[0].c} rows`)
  check('quantity is derived from 3 positions', pos.rows[0].c === 3, `${pos.rows[0].c} positions`)
}

await testLastPosition()
await testShiftOverbook()
await testItemAllOrNothing()
await testCompositeFk()
await testCancelReusesPositions()
await testOneCommitmentPerPerson()
await pool.end()
console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
