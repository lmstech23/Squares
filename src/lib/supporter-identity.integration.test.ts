import { test, describe, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "crypto";
import { PrismaClient } from "@prisma/client";
import { resolveSupporter } from "./admission.ts";

// Supporter identity against a REAL database.
//
// The stored half of the rule. contributor-rows.integration.test.ts covers the
// derived half; both consume the same module, and these assert that they agree
// about who one person is.
//
// THE RACE IS THE HARD PART. resolveSupporter was an unguarded
// read-then-create: two concurrent claims for the same new contact both miss
// and both insert. Catching the unique violation is not enough on its own —
// in Postgres a failed statement ABORTS the surrounding transaction, so the
// retry query fails with "current transaction is aborted". Verified before the
// fix was written; the savepoint is what makes the retry possible at all.
//
//   npm run test:db:up && npm run test:integration:identity

const url = process.env.TEST_DATABASE_URL;
const prisma = url ? new PrismaClient({ datasources: { db: { url } } }) : null;

describe(
  "supporter identity (integration)",
  { skip: !url && "TEST_DATABASE_URL not set" },
  () => {
    const db = prisma!;
    let hostId: string;
    let boardId = "";
    let eventId = "";

    const resolve = (contact: { name: string; email: string; phone: string }) =>
      db.$transaction((tx) => resolveSupporter(tx, eventId, contact));

    before(async () => {
      const h = await db.host.create({
        data: { email: "id-" + randomUUID() + "@example.com" },
      });
      hostId = h.id;
    });

    beforeEach(async () => {
      if (boardId) {
        await db.eventSupporter.deleteMany({ where: { eventId } });
        await db.event.deleteMany({ where: { boardId } });
        await db.board.deleteMany({ where: { boardId } });
      }
      const b = await db.board.create({
        data: {
          hostId,
          gameName: "Identity",
          slug: "id-" + randomUUID().slice(0, 8),
          boardType: "fundraiser",
          squarePrice: 5000,
          totalSquares: 1,
          timezone: "America/New_York",
          campaignEndsAt: new Date(Date.now() + 7 * 864e5),
        },
      });
      boardId = b.boardId;
      const ev = await db.event.create({
        data: { boardId, startsAt: new Date(Date.now() + 864e5), timezone: "America/New_York" },
      });
      eventId = ev.id;
    });

    after(async () => {
      if (boardId) {
        await db.eventSupporter.deleteMany({ where: { eventId } });
        await db.event.deleteMany({ where: { boardId } });
        await db.board.deleteMany({ where: { boardId } });
      }
      if (hostId) await db.host.deleteMany({ where: { id: hostId } });
      await db.$disconnect();
    });

    const count = () => db.eventSupporter.count({ where: { eventId } });

    test("both keys are stored, normalized", async () => {
      const s = await resolve({ name: "A", email: " A@Example.COM ", phone: "(678) 555-1234" });
      assert.equal(s.emailKey, "a@example.com");
      assert.equal(s.phoneKey, "+16785551234");
      // WHAT THEY TYPED, not the normalized value. emailKey carries the
      // normalization now, so this no longer has to.
      assert.equal(s.email, "A@Example.COM");
    });

    test("the same email is the same supporter", async () => {
      const a = await resolve({ name: "A", email: "a@x.com", phone: "6785551234" });
      const b = await resolve({ name: "A", email: "A@X.com", phone: "6785551234" });
      assert.equal(a.id, b.id);
      assert.equal(await count(), 1);
    });

    // THE ONLY PATH PHONE IDENTITY TAKES now that both fields are mandatory.
    test("a NEW EMAIL on a KNOWN PHONE binds to the existing supporter", async () => {
      const first = await resolve({ name: "Chris", email: "chris@work.com", phone: "6785551234" });
      const second = await resolve({ name: "Chris R", email: "chris@home.com", phone: "1-678-555-1234" });

      assert.equal(second.id, first.id, "one supporter, not two");
      assert.equal(await count(), 1);
      // emailKey is NOT overwritten: it is uniquely indexed and rewriting it
      // could collide with a third supporter. The new address lives on the
      // Contribution, which is where the ledger keeps what was typed.
      assert.equal(second.emailKey, "chris@work.com");
    });

    test("a different email AND a different phone is a new supporter", async () => {
      await resolve({ name: "A", email: "a@x.com", phone: "6785551111" });
      await resolve({ name: "B", email: "b@x.com", phone: "6785552222" });
      assert.equal(await count(), 2);
    });

    // EMAIL FIRST, NEVER OR. The phone here belongs to a DIFFERENT supporter;
    // an OR would chain the two together.
    test("email wins when email and phone point at different supporters", async () => {
      const a = await resolve({ name: "A", email: "a@x.com", phone: "6785551111" });
      await resolve({ name: "B", email: "b@x.com", phone: "6785552222" });

      const again = await resolve({ name: "A", email: "a@x.com", phone: "6785552222" });
      assert.equal(again.id, a.id, "bound on email, not phone");
      assert.equal(await count(), 2, "and merged nothing");
    });

    test("a returning supporter keeps status and passes", async () => {
      const first = await resolve({ name: "A", email: "a@x.com", phone: "6785551234" });
      await db.eventSupporter.update({
        where: { id: first.id },
        data: { status: "active", activatedAt: new Date(), passSequenceCursor: 7 },
      });
      const again = await resolve({ name: "A", email: "a@x.com", phone: "6785551234" });
      assert.equal(again.status, "active", "never downgraded to pending");
      assert.equal(again.passSequenceCursor, 7);
    });

    // ---- THE RACE ----------------------------------------------------------

    test("two concurrent resolves of the same new contact make ONE supporter", async () => {
      const contact = { name: "Race", email: "race@x.com", phone: "6785559999" };
      const [a, b] = await Promise.all([resolve(contact), resolve(contact)]);
      assert.equal(a.id, b.id, "both bound to the same row");
      assert.equal(await count(), 1);
    });

    // The loser must find the winner on the SAME ordered lookup, including
    // when the collision is on the phone key rather than the email key.
    test("a concurrent phone collision resolves to the winner", async () => {
      const [a, b] = await Promise.all([
        resolve({ name: "A", email: "one@x.com", phone: "6785558888" }),
        resolve({ name: "B", email: "two@x.com", phone: "6785558888" }),
      ]);
      // One of them created it; the other lost the unique violation, rolled
      // back to the savepoint, and re-looked-up by phone.
      assert.equal(a.id, b.id);
      assert.equal(await count(), 1);
    });

    // ---- mandatory both ----------------------------------------------------

    test("a missing phone is refused, not given a partial identity", async () => {
      await assert.rejects(
        () => resolve({ name: "A", email: "a@x.com", phone: "   " }),
        /phone is required/
      );
      assert.equal(await count(), 0);
    });

    test("an unusable phone is refused rather than guessed", async () => {
      await assert.rejects(
        () => resolve({ name: "A", email: "a@x.com", phone: "555-1234" }),
        /phone is required/
      );
      assert.equal(await count(), 0);
    });

    test("a missing email is refused", async () => {
      await assert.rejects(
        () => resolve({ name: "A", email: "  ", phone: "6785551234" }),
        /email is required/
      );
      assert.equal(await count(), 0);
    });
  }
);
