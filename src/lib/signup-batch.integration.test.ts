import { test, describe, before, after, beforeEach, mock } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "crypto";
import { PrismaClient } from "@prisma/client";
import { applyBatchResults, type BatchResult } from "./signup-batch.ts";

// The batched save, through the REAL route, against a real database.
//
// What the pure tests cannot show: that per-slot isolation actually holds. Each
// setTargetQuantity call opens its own transaction and takes SELECT … FOR
// UPDATE on its slot, so one slot filling up must roll back that slot and
// nothing else. A transaction around the loop would roll back the successes,
// and no unit test would notice.
//
//   npm run test:db:up && npm run test:integration:signup-batch

const url = process.env.TEST_DATABASE_URL;
const prisma = url ? new PrismaClient({ datasources: { db: { url } } }) : null;

if (url) {
  mock.module("@/lib/email", { namedExports: { sendEmail: async () => {} } });
}

const claim = url
  ? await import("../app/api/signup/[token]/claim/route.ts")
  : { POST: null as never };
const signups = url ? await import("./signups.ts") : (null as never);

describe(
  "batched signup save (integration)",
  { skip: !url && "TEST_DATABASE_URL not set" },
  () => {
    const db = prisma!;
    let hostId: string;
    let boardId = "";
    let eventId = "";
    let sheetId = "";
    let token = "";
    let meId = "";
    let otherId = "";
    /** ITEM capacity 3, ITEM capacity 5, SHIFT capacity 1. */
    let itemA = "";
    let itemB = "";
    let shift = "";

    async function post(body: unknown) {
      const req = new Request("http://localhost/api/signup/" + token + "/claim", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const res = await claim.POST(req, { params: Promise.resolve({ token }) });
      return { status: res.status, body: await res.json() };
    }

    const held = (slotId: string, supporterId: string) =>
      db.helperSignupPosition.count({
        where: { slotId, signup: { eventSupporterId: supporterId } },
      });

    async function supporter(email: string) {
      const s = await db.eventSupporter.create({
        data: {
          eventId,
          emailKey: email,
          phoneKey: "+1678555" + String(Math.floor(Math.random() * 9000) + 1000),
          name: email,
          email,
          phone: "6785551234",
          status: "active",
          activatedAt: new Date(),
        },
      });
      return s.id;
    }

    before(async () => {
      const h = await db.host.create({
        data: { email: "sb-" + randomUUID() + "@example.com" },
      });
      hostId = h.id;
    });

    beforeEach(async () => {
      if (boardId) {
        await db.signupLog.deleteMany({ where: { slot: { sheet: { eventId } } } });
        await db.helperSignupPosition.deleteMany({ where: { slot: { sheet: { eventId } } } });
        await db.helperSignup.deleteMany({ where: { slot: { sheet: { eventId } } } });
        await db.signupSlot.deleteMany({ where: { sheet: { eventId } } });
        await db.signupSheet.deleteMany({ where: { eventId } });
        await db.supporterAccessToken.deleteMany({ where: { supporter: { eventId } } });
        await db.eventSupporter.deleteMany({ where: { eventId } });
        await db.event.deleteMany({ where: { boardId } });
        await db.board.deleteMany({ where: { boardId } });
      }
      const b = await db.board.create({
        data: {
          hostId,
          gameName: "Batch",
          slug: "sb-" + randomUUID().slice(0, 8),
          boardType: "fundraiser",
          squarePrice: 5000,
          totalSquares: 1,
          timezone: "America/New_York",
          campaignEndsAt: new Date(Date.now() + 7 * 864e5),
        },
      });
      boardId = b.boardId;
      const ev = await db.event.create({
        data: { boardId, startsAt: new Date(Date.now() + 14 * 864e5), timezone: "America/New_York" },
      });
      eventId = ev.id;
      const sheet = await db.signupSheet.create({ data: { eventId, isOpen: true } });
      sheetId = sheet.id;
      itemA = (await db.signupSlot.create({
        data: { sheetId, name: "Water", slotType: "ITEM", capacity: 3, unitLabel: "case", sortOrder: 1 },
      })).id;
      itemB = (await db.signupSlot.create({
        data: { sheetId, name: "Chips", slotType: "ITEM", capacity: 5, unitLabel: "bag", sortOrder: 2 },
      })).id;
      shift = (await db.signupSlot.create({
        data: { sheetId, name: "Kitchen", slotType: "SHIFT", capacity: 1, sortOrder: 3 },
      })).id;

      meId = await supporter("me@example.com");
      otherId = await supporter("other@example.com");
      token = (await signups.issueSupporterAccessLink(meId)).token;
    });

    after(async () => {
      if (boardId) {
        await db.signupLog.deleteMany({ where: { slot: { sheet: { eventId } } } });
        await db.helperSignupPosition.deleteMany({ where: { slot: { sheet: { eventId } } } });
        await db.helperSignup.deleteMany({ where: { slot: { sheet: { eventId } } } });
        await db.signupSlot.deleteMany({ where: { sheet: { eventId } } });
        await db.signupSheet.deleteMany({ where: { eventId } });
        await db.supporterAccessToken.deleteMany({ where: { supporter: { eventId } } });
        await db.eventSupporter.deleteMany({ where: { eventId } });
        await db.event.deleteMany({ where: { boardId } });
        await db.board.deleteMany({ where: { boardId } });
      }
      if (hostId) await db.host.deleteMany({ where: { id: hostId } });
      await db.$disconnect();
    });

    // ---- the whole point ----------------------------------------------------

    test("one save commits claims, a reduction and a cancellation together", async () => {
      await post({ changes: [{ slotId: itemA, target: 2 }, { slotId: itemB, target: 3 }] });

      const { status, body } = await post({
        changes: [
          { slotId: itemA, target: 0 }, // cancel
          { slotId: itemB, target: 1 }, // reduce
          { slotId: shift, target: 1 }, // new
        ],
      });
      assert.equal(status, 200);
      assert.equal(body.ok, true);
      assert.equal(await held(itemA, meId), 0);
      assert.equal(await held(itemB, meId), 1);
      assert.equal(await held(shift, meId), 1);
    });

    // ONE SLOT FAILING MUST NOT ROLL BACK THE OTHERS. This is what a
    // transaction around the loop would break.
    test("a full slot fails alone; the rest of the batch commits", async () => {
      // Someone else takes the only kitchen shift.
      await signups.setTargetQuantity({
        slotId: shift, supporterId: otherId, target: 1, actorType: "SUPPORTER",
      });

      const { status, body } = await post({
        changes: [
          { slotId: itemA, target: 2 },
          { slotId: shift, target: 1 },
          { slotId: itemB, target: 4 },
        ],
      });

      assert.equal(status, 200, "partial failure is still a processed batch");
      assert.equal(body.ok, false);

      const byId = new Map((body.results as BatchResult[]).map((r) => [r.slotId, r]));
      assert.equal(byId.get(itemA)!.ok, true);
      assert.equal(byId.get(itemB)!.ok, true);
      assert.equal(byId.get(shift)!.ok, false);

      assert.equal(await held(itemA, meId), 2, "committed despite the neighbour failing");
      assert.equal(await held(itemB, meId), 4);
      assert.equal(await held(shift, meId), 0);
    });

    // The all-or-nothing rule WITHIN a slot survives batching.
    test("asking for more than remains grants nothing in that slot", async () => {
      await signups.setTargetQuantity({
        slotId: itemA, supporterId: otherId, target: 2, actorType: "SUPPORTER",
      });
      const { body } = await post({ changes: [{ slotId: itemA, target: 3 }] });
      const r = (body.results as BatchResult[])[0];
      assert.equal(r.ok, false);
      assert.equal(await held(itemA, meId), 0, "not silently given the 1 that was left");
      assert.ok(!r.ok && r.maxTarget === 1);
    });

    // ---- THE REFRESH / DRAFT CLAMP -----------------------------------------
    //
    // Availability moves between attempts. The retained draft must clamp
    // against the ceiling in the response just received, never a remembered
    // one, or she re-submits into the same conflict forever.
    test("a retained draft clamps to the NEWLY returned ceiling", async () => {
      // Capacity 3. Someone else takes 1 -> 2 left.
      await signups.setTargetQuantity({
        slotId: itemA, supporterId: otherId, target: 1, actorType: "SUPPORTER",
      });

      let drafts: Record<string, number> = { [itemA]: 3 };
      const first = await post({ changes: [{ slotId: itemA, target: drafts[itemA] }] });
      let applied = applyBatchResults(drafts, first.body.results as BatchResult[]);
      assert.equal(applied.drafts[itemA], 2, "clamped to what was left then");
      drafts = applied.drafts;

      // Availability moves AGAIN before she retries: the other supporter takes
      // a second position, leaving 1.
      await signups.setTargetQuantity({
        slotId: itemA, supporterId: otherId, target: 2, actorType: "SUPPORTER",
      });

      const second = await post({ changes: [{ slotId: itemA, target: drafts[itemA] }] });
      applied = applyBatchResults(drafts, second.body.results as BatchResult[]);
      assert.equal(applied.drafts[itemA], 1, "clamped to the FRESH ceiling, not the stale 2");
      assert.equal(await held(itemA, meId), 0, "and still holds nothing");

      // And the clamped value now succeeds.
      const third = await post({ changes: [{ slotId: itemA, target: applied.drafts[itemA] }] });
      assert.equal(third.body.ok, true);
      assert.equal(await held(itemA, meId), 1);
    });

    // ---- log rows -----------------------------------------------------------

    test("one log row per slot that actually changed", async () => {
      await post({ changes: [{ slotId: itemA, target: 2 }, { slotId: itemB, target: 1 }] });
      assert.equal(
        await db.signupLog.count({ where: { eventSupporterId: meId } }),
        2,
        "one per slot, not one per batch"
      );
    });

    // Idempotent by shape: the same batch twice is all zero deltas.
    test("re-sending the same batch writes no further log rows", async () => {
      const batch = { changes: [{ slotId: itemA, target: 2 }] };
      await post(batch);
      await post(batch);
      assert.equal(await db.signupLog.count({ where: { eventSupporterId: meId } }), 1);
      assert.equal(await held(itemA, meId), 2);
    });

    // ---- shape and guards ---------------------------------------------------

    test("the old single-slot shape still works", async () => {
      const { status, body } = await post({ slotId: itemA, target: 2 });
      assert.equal(status, 200);
      assert.equal(body.ok, true);
      assert.equal(await held(itemA, meId), 2);
    });

    test("a SHIFT still refuses a target above one", async () => {
      const { body } = await post({ changes: [{ slotId: shift, target: 2 }] });
      const r = (body.results as BatchResult[])[0];
      assert.equal(r.ok, false);
      assert.ok(!r.ok && r.reason === "invalid_target");
    });

    test("a duplicated slot in one batch is refused outright", async () => {
      const { status } = await post({
        changes: [{ slotId: itemA, target: 1 }, { slotId: itemA, target: 2 }],
      });
      assert.equal(status, 400);
      assert.equal(await held(itemA, meId), 0);
    });

    test("a slot from another sheet fails the whole request", async () => {
      const other = await db.board.create({
        data: {
          hostId, gameName: "Other", slug: "ot-" + randomUUID().slice(0, 8),
          boardType: "fundraiser", squarePrice: 5000, totalSquares: 1,
          timezone: "America/New_York", campaignEndsAt: new Date(Date.now() + 864e5),
        },
      });
      const oev = await db.event.create({
        data: { boardId: other.boardId, startsAt: new Date(Date.now() + 864e5), timezone: "America/New_York" },
      });
      const osheet = await db.signupSheet.create({ data: { eventId: oev.id } });
      const oslot = await db.signupSlot.create({
        data: { sheetId: osheet.id, name: "Elsewhere", slotType: "ITEM", capacity: 2 },
      });

      const { status } = await post({
        changes: [{ slotId: itemA, target: 1 }, { slotId: oslot.id, target: 1 }],
      });
      assert.equal(status, 404);
      assert.equal(await held(itemA, meId), 0, "nothing committed from a rejected request");

      await db.signupSlot.deleteMany({ where: { sheetId: osheet.id } });
      await db.signupSheet.deleteMany({ where: { eventId: oev.id } });
      await db.event.deleteMany({ where: { boardId: other.boardId } });
      await db.board.deleteMany({ where: { boardId: other.boardId } });
    });

    test("an empty batch is refused", async () => {
      assert.equal((await post({ changes: [] })).status, 400);
    });
  }
);
