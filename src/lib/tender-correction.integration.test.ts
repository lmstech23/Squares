import { test, describe, before, after, mock } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "crypto";
import { PrismaClient } from "@prisma/client";

// Inline correction of tender and reference, THROUGH THE ROUTE, against a real
// database — payment-method addendum v1.2.7 §6.
//
// THE AUTHORIZATION RULING IS PINNED HERE. Any organizer who may manage the
// board's money may correct any offline row on it, whoever recorded it. The
// recorder does not own the row: `recordedByHostId` answers who recorded the
// money, this log answers who later changed how it is described, and a row
// nobody but the original recorder could fix would be uncorrectable exactly
// when it matters.
//
// FORBIDDEN FIELDS ARE REFUSED, NOT IGNORED. A request naming `amount` or
// `status` comes back 400 saying so, and nothing is written.
//
// CORRECTING A HISTORICAL NULL TENDER IS THE PRIMARY PATH: 14 rows on the live
// board are in that state.
//
//   npm run test:db:up && npm run test:integration:correction

const url = process.env.TEST_DATABASE_URL;
const prisma = url ? new PrismaClient({ datasources: { db: { url } } }) : null;

let currentHost: { id: string } | null = null;

if (url) {
  mock.module("@/lib/auth", {
    namedExports: {
      getHost: async () => currentHost,
      getHostOrNull: async () => currentHost,
    },
  });
}

const route = url
  ? await import("../app/api/host/boards/[id]/contribution-tender/route.ts")
  : ({} as never);

describe(
  "tender correction (integration)",
  { skip: !url && "TEST_DATABASE_URL not set" },
  () => {
    const db = prisma!;
    let organizerId = "";
    let otherOrganizerId = "";
    let outsiderId = "";
    let boardId = "";

    async function correct(body: unknown, asHost = organizerId) {
      currentHost = { id: asHost };
      const req = new Request(
        `http://localhost/api/host/boards/${boardId}/contribution-tender`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        }
      );
      const res = await route.PATCH(req, { params: Promise.resolve({ id: boardId }) });
      assert.ok(res, "the route returned no response");
      return { status: res.status, json: await res.json() };
    }

    /** An offline row, optionally with a tender, recorded by SOMEONE ELSE. */
    async function offlineRow(
      opts: { tender?: string | null; reference?: string | null } = {}
    ) {
      const row = await db.contribution.create({
        data: {
          boardId,
          status: "confirmed",
          settlement: "OFFLINE",
          tender: (opts.tender ?? null) as never,
          tenderReference: opts.reference ?? null,
          squareAmountCents: 0,
          donationAmountCents: 4000,
          totalPaidCents: 4000,
          contributorName: "Fixture Contributor",
          contributorEmail: "fix@example.invalid",
          confirmedAt: new Date(),
          // RECORDED BY THE OTHER ORGANIZER. Every correction below is made by
          // someone who did not record it.
          recordedByHostId: otherOrganizerId,
          confirmedByHostId: otherOrganizerId,
          recordedAt: new Date(),
        },
        select: { id: true },
      });
      return row.id;
    }

    const logs = (contributionId: string) =>
      db.tenderCorrectionLog.findMany({
        where: { contributionId },
        orderBy: { field: "asc" },
      });

    /** Everything a correction must never touch. */
    const untouchable = {
      settlement: true,
      status: true,
      squareAmountCents: true,
      donationAmountCents: true,
      entryAmountCents: true,
      totalPaidCents: true,
      contributorName: true,
      contributorEmail: true,
      contributorPhone: true,
      confirmedAt: true,
      releasedAt: true,
      voidedAt: true,
      createdAt: true,
      recordedByHostId: true,
      confirmedByHostId: true,
      recordedAt: true,
      paymentRail: true,
      isHostEntry: true,
      postCloseAt: true,
    } as const;

    before(async () => {
      const a = await db.host.create({
        data: { email: "corr-a-" + randomUUID() + "@example.invalid", name: "Organizer A" },
      });
      const b = await db.host.create({
        data: { email: "corr-b-" + randomUUID() + "@example.invalid", name: "Organizer B" },
      });
      const c = await db.host.create({
        data: { email: "corr-c-" + randomUUID() + "@example.invalid", name: "Outsider" },
      });
      organizerId = a.id;
      otherOrganizerId = b.id;
      outsiderId = c.id;

      const board = await db.board.create({
        data: {
          hostId: organizerId,
          gameName: "Correction Fixture",
          slug: "cor-" + randomUUID().slice(0, 8),
          boardType: "fundraiser",
          acceptedPaymentMethods: ["card", "zelle"],
          hostZelle: "host@example.invalid",
          squarePrice: 5000,
          totalSquares: 4,
          timezone: "America/New_York",
          campaignEndsAt: new Date(Date.now() + 30 * 864e5),
        },
      });
      boardId = board.boardId;
      // Both organizers may manage this board. The outsider holds nothing.
      await db.boardCollaborator.createMany({
        data: [
          { boardId, hostId: organizerId, role: "OWNER", status: "active", acceptedAt: new Date() },
          { boardId, hostId: otherOrganizerId, role: "MANAGER", status: "active", acceptedAt: new Date() },
        ],
      });
    });

    after(async () => {
      if (boardId) {
        await db.tenderCorrectionLog.deleteMany({ where: { contribution: { boardId } } });
        await db.contribution.deleteMany({ where: { boardId } });
        await db.boardCollaborator.deleteMany({ where: { boardId } });
        await db.board.deleteMany({ where: { boardId } });
      }
      await db.host.deleteMany({
        where: { id: { in: [organizerId, otherOrganizerId, outsiderId].filter(Boolean) } },
      });
      await db.$disconnect();
    });

    // ---- the primary path: a historical row with no tender ----------------

    test("null -> a known tender, logged with a null old value", async () => {
      const id = await offlineRow({ tender: null });
      const out = await correct({ contributionId: id, tender: "ZELLE" });
      assert.equal(out.status, 200);
      assert.equal(out.json.changed, 1);

      const row = await db.contribution.findUniqueOrThrow({ where: { id } });
      assert.equal(row.tender, "ZELLE");

      const [entry] = await logs(id);
      assert.equal(entry.field, "TENDER");
      assert.equal(entry.oldValue, null, "it had no tender, and the log says so");
      assert.equal(entry.newValue, "ZELLE");
      assert.equal(entry.hostId, organizerId);
      assert.ok(entry.createdAt);
    });

    test("a known tender -> a different one", async () => {
      const id = await offlineRow({ tender: "CASH" });
      const out = await correct({ contributionId: id, tender: "CHECK" });
      assert.equal(out.status, 200);
      const row = await db.contribution.findUniqueOrThrow({ where: { id } });
      assert.equal(row.tender, "CHECK");
      const [entry] = await logs(id);
      assert.deepEqual([entry.field, entry.oldValue, entry.newValue], ["TENDER", "CASH", "CHECK"]);
    });

    // ---- the reference: add, change, clear ---------------------------------

    test("a reference is added, changed, then cleared - three corrections, three rows", async () => {
      const id = await offlineRow({ tender: "ZELLE" });

      assert.equal((await correct({ contributionId: id, tenderReference: "memo 1" })).status, 200);
      assert.equal(
        (await db.contribution.findUniqueOrThrow({ where: { id } })).tenderReference,
        "memo 1"
      );

      assert.equal((await correct({ contributionId: id, tenderReference: "memo 2" })).status, 200);
      assert.equal(
        (await db.contribution.findUniqueOrThrow({ where: { id } })).tenderReference,
        "memo 2"
      );

      // CLEARING IS A CORRECTION. A note that turned out to be wrong must be
      // removable, and null is the honest value.
      const cleared = await correct({ contributionId: id, tenderReference: null });
      assert.equal(cleared.status, 200);
      assert.equal(
        (await db.contribution.findUniqueOrThrow({ where: { id } })).tenderReference,
        null
      );

      const rows = await db.tenderCorrectionLog.findMany({
        where: { contributionId: id },
        orderBy: { createdAt: "asc" },
      });
      assert.equal(rows.length, 3);
      assert.deepEqual(
        rows.map((r) => [r.field, r.oldValue, r.newValue]),
        [
          ["REFERENCE", null, "memo 1"],
          ["REFERENCE", "memo 1", "memo 2"],
          ["REFERENCE", "memo 2", null],
        ]
      );
    });

    test("both fields in one request writes TWO log rows", async () => {
      const id = await offlineRow({ tender: "CASH", reference: "old note" });
      const out = await correct({
        contributionId: id,
        tender: "VENMO",
        tenderReference: "new note",
      });
      assert.equal(out.status, 200);
      assert.equal(out.json.changed, 2);

      const rows = await logs(id);
      assert.equal(rows.length, 2);
      // Compared by field rather than by row order: Postgres orders an enum
      // by DECLARATION order, and which row landed first is not the point.
      const byField = Object.fromEntries(
        rows.map((r) => [r.field, [r.oldValue, r.newValue]])
      );
      assert.deepEqual(byField, {
        TENDER: ["CASH", "VENMO"],
        REFERENCE: ["old note", "new note"],
      });
    });

    test("a request that changes nothing writes no log row", async () => {
      const id = await offlineRow({ tender: "CASH", reference: "same" });
      const out = await correct({ contributionId: id, tender: "CASH", tenderReference: "same" });
      assert.equal(out.status, 200);
      assert.equal(out.json.changed, 0);
      assert.equal((await logs(id)).length, 0, "an audit trail of non-events is noise");
    });

    // ---- authorization -----------------------------------------------------

    // THE RULING. Organizer A never recorded any of these rows; B did.
    test("an organizer who did not record the row may still correct it", async () => {
      const id = await offlineRow({ tender: "CASH" });
      const row = await db.contribution.findUniqueOrThrow({ where: { id } });
      assert.equal(row.recordedByHostId, otherOrganizerId, "recorded by the other organizer");

      const out = await correct({ contributionId: id, tender: "CHECK" }, organizerId);
      assert.equal(out.status, 200);
      const [entry] = await logs(id);
      assert.equal(entry.hostId, organizerId, "the log names who changed it, not who recorded it");
      assert.equal(
        (await db.contribution.findUniqueOrThrow({ where: { id } })).recordedByHostId,
        otherOrganizerId,
        "and the recorder is left alone"
      );
    });

    test("a host with no grant on this board is refused, and nothing changes", async () => {
      const id = await offlineRow({ tender: "CASH" });
      const out = await correct({ contributionId: id, tender: "CHECK" }, outsiderId);
      assert.ok(out.status === 403 || out.status === 404 || out.status === 401, `got ${out.status}`);
      assert.equal((await db.contribution.findUniqueOrThrow({ where: { id } })).tender, "CASH");
      assert.equal((await logs(id)).length, 0);
    });

    // ---- what may not be corrected ----------------------------------------

    test("a forbidden field is REFUSED BY NAME, not ignored", async () => {
      const id = await offlineRow({ tender: "CASH" });
      const before = await db.contribution.findUniqueOrThrow({ where: { id } });

      for (const forbidden of [
        { settlement: "STRIPE" },
        { totalPaidCents: 999999 },
        { status: "released" },
        { contributorName: "Someone Else" },
        { confirmedAt: new Date().toISOString() },
        { recordedAt: new Date().toISOString() },
      ]) {
        const key = Object.keys(forbidden)[0];
        const out = await correct({ contributionId: id, tender: "CHECK", ...forbidden });
        assert.equal(out.status, 400, key);
        assert.match(out.json.error, new RegExp(key), `the refusal names ${key}`);
        assert.deepEqual(out.json.refusedFields, [key]);
      }

      const after = await db.contribution.findUniqueOrThrow({ where: { id } });
      assert.deepEqual(after, before, "not one field moved, including the tender sent alongside");
      assert.equal((await logs(id)).length, 0);
    });

    test("CARD is refused", async () => {
      const id = await offlineRow({ tender: "CASH" });
      const out = await correct({ contributionId: id, tender: "CARD" });
      assert.equal(out.status, 400);
      assert.match(out.json.error, /Card is not a host-recorded method/);
      assert.equal((await db.contribution.findUniqueOrThrow({ where: { id } })).tender, "CASH");
      assert.equal((await logs(id)).length, 0);
    });

    test("a witnessed row is not correctable at all", async () => {
      const stripe = await db.contribution.create({
        data: {
          boardId,
          status: "confirmed",
          settlement: "STRIPE",
          tender: "CARD",
          squareAmountCents: 0,
          donationAmountCents: 2500,
          totalPaidCents: 2500,
          contributorName: "Card Contributor",
          contributorEmail: "card@example.invalid",
          confirmedAt: new Date(),
        },
        select: { id: true },
      });
      const out = await correct({ contributionId: stripe.id, tender: "CASH" });
      assert.equal(out.status, 409);
      assert.equal(
        (await db.contribution.findUniqueOrThrow({ where: { id: stripe.id } })).tender,
        "CARD"
      );
    });

    // ---- the load-bearing property ----------------------------------------

    // INVARIANT 122 AT THE ROUTE. Drop tender and reference from the comparison
    // and every other column must be byte-identical across a correction.
    test("a correction moves no money, no state, and no date", async () => {
      const id = await offlineRow({ tender: "CASH", reference: "before" });
      const before = await db.contribution.findUniqueOrThrow({
        where: { id },
        select: untouchable,
      });

      const out = await correct({
        contributionId: id,
        tender: "PAYPAL",
        tenderReference: "after",
      });
      assert.equal(out.status, 200);

      const after = await db.contribution.findUniqueOrThrow({
        where: { id },
        select: untouchable,
      });
      assert.deepEqual(after, before);
    });
  }
);
