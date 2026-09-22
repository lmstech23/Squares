import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "crypto";
import { generateReferenceCode } from "./reference-code.ts";
import { PrismaClient } from "@prisma/client";

// The entry ticket limit, against a real database — v2 §19.13, invariant 126.
//
// THE PROPERTY THIS FILE EXISTS FOR IS THE RACE. A ticket limit has no row to
// contend on the way a square does, so two buyers can each read "1 remaining"
// and each buy one. The guard is `SELECT ... FOR UPDATE` on the board row, and
// the only way to know it works is to run two transactions at once against a
// real Postgres and watch one of them wait.
//
// AND: pending counts, released stops counting, and the arithmetic is the same
// one the display reads.
//
//   TEST_DATABASE_URL=... node --experimental-strip-types --test this-file

const url = process.env.TEST_DATABASE_URL;
const prisma = url ? new PrismaClient({ datasources: { db: { url } } }) : null;

const lib = url ? await import("./entry-availability.ts") : ({} as never);

describe(
  "entry ticket limit (integration)",
  { skip: !url && "TEST_DATABASE_URL not set" },
  () => {
    const db = prisma!;
    let hostId = "";
    let eventId = "";
    let boardId = "";

    async function setLimit(n: number | null) {
      await db.board.update({
        where: { boardId },
        data: { entryTicketLimit: n },
      });
    }

    /** A confirmed entry purchase of `n` tickets. */
    async function sold(n: number) {
      await db.contribution.create({
        data: {
          boardId,
          status: "confirmed",
          settlement: "OFFLINE",
          squareAmountCents: 0,
          donationAmountCents: 0,
          entryAmountCents: 4000 * n,
          entryTicketCount: n,
          totalPaidCents: 4000 * n,
          contributorName: "Sold Fixture",
          contributorEmail: "sold@example.invalid",
          confirmedAt: new Date(),
        } as never,
      });
    }

    /** A pending CARD purchase of `n` tickets — held, not sold. */
    async function heldByCard(n: number) {
      return db.contribution.create({
        data: {
          boardId,
          status: "pending",
          settlement: "STRIPE",
          // STRIPE pairs with CARD and only CARD — invariant 121.
          tender: "CARD",
          squareAmountCents: 0,
          donationAmountCents: 0,
          entryAmountCents: 4000 * n,
          entryTicketCount: n,
          totalPaidCents: 4000 * n,
          contributorName: "Held Fixture",
          contributorEmail: "held@example.invalid",
          holdExpiresAt: new Date(Date.now() + lib.ENTRY_HOLD_TTL_MS),
        } as never,
        select: { id: true },
      });
    }

    /** A pending reservation of `n` tickets — held, not sold. */
    async function heldByReservation(n: number) {
      const r = await db.entryReservation.create({
        data: {
          boardId,
          eventId,
          referenceCode: generateReferenceCode(),
          contributorName: "Reserved Fixture",
          contributorEmail: "res@example.invalid",
          contributorPhone: "+15550000000",
          paymentRail: "zelle",
          donationAmountCents: 0,
          status: "pending",
        } as never,
        select: { id: true },
      });
      await db.entryReservationLine.create({
        data: {
          reservationId: r.id,
          tier: "ADULT",
          priceBasis: "REGULAR",
          unitPriceCents: 4000,
          quantity: n,
        } as never,
      });
      return r;
    }

    async function read() {
      const b = await db.board.findUniqueOrThrow({
        where: { boardId },
        select: { entryTicketLimit: true },
      });
      return lib.entryAvailability(db, boardId, b.entryTicketLimit);
    }

    async function clearSales() {
      await db.entryReservationLine.deleteMany({
        where: { reservation: { boardId } },
      });
      await db.entryReservation.deleteMany({ where: { boardId } });
      await db.contribution.deleteMany({ where: { boardId } });
    }

    before(async () => {
      const host = await db.host.create({
        data: { email: "lim-" + randomUUID() + "@example.invalid" },
      });
      hostId = host.id;
      const board = await db.board.create({
        data: {
          hostId,
          gameName: "Limit Fixture",
          slug: "lim-" + randomUUID().slice(0, 8),
          boardType: "fundraiser",
          acceptedPaymentMethods: ["zelle"],
          hostZelle: "lim@example.invalid",
          squarePrice: 5000,
          totalSquares: 100,
          timezone: "America/New_York",
          campaignEndsAt: new Date(Date.now() + 30 * 864e5),
          entryAdultRegularPriceCents: 4000,
          entryTicketLimit: 10,
        },
        select: { boardId: true },
      });
      boardId = board.boardId;
      const ev = await db.event.create({
        data: {
          boardId,
          startsAt: new Date(Date.now() + 30 * 864e5),
          timezone: "America/New_York",
        },
        select: { id: true },
      });
      eventId = ev.id;
    });

    after(async () => {
      if (boardId) {
        await clearSales();
        await db.event.deleteMany({ where: { boardId } });
        await db.board.deleteMany({ where: { boardId } });
      }
      if (hostId) await db.host.deleteMany({ where: { id: hostId } });
      await db.$disconnect();
    });

    // ---- the arithmetic -----------------------------------------------------

    test("an untouched board has its whole limit remaining", async () => {
      await clearSales();
      const a = await read();
      assert.deepEqual([a.limit, a.sold, a.held, a.remaining], [10, 0, 0, 10]);
    });

    test("confirmed purchases are sold", async () => {
      await clearSales();
      await sold(3);
      const a = await read();
      assert.equal(a.sold, 3);
      assert.equal(a.held, 0);
      assert.equal(a.remaining, 7);
    });

    // PENDING COUNTS. Neither has been paid; both become tickets if nothing
    // intervenes, and a limit that ignored them would oversell every time two
    // people were mid-purchase.
    test("a pending card checkout is held, not sold", async () => {
      await clearSales();
      await heldByCard(2);
      const a = await read();
      assert.deepEqual([a.sold, a.held, a.remaining], [0, 2, 8]);
    });

    test("a pending reservation is held, not sold", async () => {
      await clearSales();
      await heldByReservation(4);
      const a = await read();
      assert.deepEqual([a.sold, a.held, a.remaining], [0, 4, 6]);
    });

    test("sold and held are both subtracted", async () => {
      await clearSales();
      await sold(3);
      await heldByCard(2);
      await heldByReservation(1);
      const a = await read();
      assert.deepEqual([a.sold, a.held, a.remaining], [3, 3, 4]);
    });

    // RELEASING GIVES THE TICKETS BACK, with nothing having to remember to.
    test("releasing a reservation returns its hold on the next read", async () => {
      await clearSales();
      const r = await heldByReservation(5);
      assert.equal((await read()).remaining, 5);

      await db.entryReservation.update({
        where: { id: r.id },
        data: { status: "released", releasedAt: new Date() },
      });
      assert.equal((await read()).remaining, 10, "the hold came back");
    });

    test("a voided confirmed purchase stops counting as sold", async () => {
      await clearSales();
      await sold(4);
      assert.equal((await read()).sold, 4);
      await db.contribution.updateMany({
        where: { boardId },
        data: {
          voidedAt: new Date(),
          voidedByHostId: hostId,
          voidReason: "fixture",
        },
      });
      assert.equal((await read()).sold, 0);
    });

    // NULL IS UNLIMITED, NOT ZERO.
    test("no limit means no remaining, whatever has sold", async () => {
      await clearSales();
      await sold(500);
      await setLimit(null);
      const a = await read();
      assert.equal(a.limit, null);
      assert.equal(a.sold, 500);
      assert.equal(a.remaining, null, "null, never 0 and never a number");
      await setLimit(10);
    });

    test("remaining never goes negative", async () => {
      await clearSales();
      await setLimit(2);
      await sold(9);
      assert.equal((await read()).remaining, 0);
      await setLimit(10);
    });

    // ---- the race -----------------------------------------------------------

    // TWO BUYERS, ONE TICKET. Without the row lock both transactions read
    // "1 remaining" before either writes, and both sell it. With it, the second
    // blocks until the first commits and then sees zero.
    test("the board row lock stops two buyers taking the last ticket", async () => {
      await clearSales();
      await setLimit(1);

      // Each "buyer" does exactly what a sale path does: lock, read, write.
      async function buy(tag: string): Promise<"sold" | "refused"> {
        return db.$transaction(async (tx) => {
          await lib.lockBoardForEntry(tx, boardId);
          const a = await lib.entryAvailability(tx, boardId, 1);
          if (a.remaining !== null && a.remaining < 1) return "refused";
          await tx.contribution.create({
            data: {
              boardId,
              status: "confirmed",
              settlement: "OFFLINE",
              squareAmountCents: 0,
              donationAmountCents: 0,
              entryAmountCents: 4000,
              entryTicketCount: 1,
              totalPaidCents: 4000,
              contributorName: "Racer " + tag,
              contributorEmail: "race@example.invalid",
              confirmedAt: new Date(),
            } as never,
          });
          return "sold";
        });
      }

      const [a, b] = await Promise.all([buy("A"), buy("B")]);
      const outcomes = [a, b].sort();
      assert.deepEqual(
        outcomes,
        ["refused", "sold"],
        "exactly one buyer got the last ticket"
      );

      const after = await read();
      assert.equal(after.sold, 1, "one ticket sold, not two");
      assert.equal(after.remaining, 0);
      await setLimit(10);
    });

    // The same proof for the direct path's unit: a reservation and a card
    // purchase racing each other, not two of the same kind.
    test("a reservation and a card checkout cannot both take the last ticket", async () => {
      await clearSales();
      await setLimit(1);

      async function attempt(kind: "card" | "reservation") {
        return db.$transaction(async (tx) => {
          await lib.lockBoardForEntry(tx, boardId);
          const a = await lib.entryAvailability(tx, boardId, 1);
          if (a.remaining !== null && a.remaining < 1) return "refused";
          if (kind === "card") {
            await tx.contribution.create({
              data: {
                boardId,
                status: "pending",
                settlement: "STRIPE",
                tender: "CARD",
                squareAmountCents: 0,
                donationAmountCents: 0,
                entryAmountCents: 4000,
                entryTicketCount: 1,
                totalPaidCents: 4000,
                contributorName: "Race Card",
                contributorEmail: "rc@example.invalid",
                holdExpiresAt: new Date(Date.now() + lib.ENTRY_HOLD_TTL_MS),
              } as never,
            });
          } else {
            const r = await tx.entryReservation.create({
              data: {
                boardId,
                eventId,
                referenceCode: generateReferenceCode(),
                contributorName: "Race Res",
                contributorEmail: "rr@example.invalid",
                contributorPhone: "+15550000000",
                paymentRail: "zelle",
                donationAmountCents: 0,
                status: "pending",
              } as never,
              select: { id: true },
            });
            await tx.entryReservationLine.create({
              data: {
                reservationId: r.id,
                tier: "ADULT",
                priceBasis: "REGULAR",
                unitPriceCents: 4000,
                quantity: 1,
              } as never,
            });
          }
          return "took";
        });
      }

      const results = await Promise.all([attempt("card"), attempt("reservation")]);
      assert.deepEqual(
        [...results].sort(),
        ["refused", "took"],
        "one path took it, the other was refused"
      );
      assert.equal((await read()).remaining, 0);
      await setLimit(10);
    });
  }
);
