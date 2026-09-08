import { test, describe, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "crypto";
import { PrismaClient } from "@prisma/client";
import { contributorRows } from "./contributor-rows.ts";
import { normalizePhone } from "./roster-identity.ts";

// The host board page contributor list, over REAL rows.
//
// THE DEFECT. The list was built from Square rows alone, so a donation - which
// takes no square - appeared nowhere. A host who had just taken a donation saw
// "Nobody has claimed a ticket yet" on a card titled Contributors, and read it
// as nothing having happened.
//
// The queries live in the page; this asserts them AND the fold together, by
// running the same `where` clauses against real rows and folding the results.
// The filters matter as much as the merge: a voided contribution still reads
// `confirmed`, so a status-only filter would show someone as a contributor
// after their money was reversed.
//
//   npm run test:db:up && npm run test:integration:contributors

const url = process.env.TEST_DATABASE_URL;
const prisma = url ? new PrismaClient({ datasources: { db: { url } } }) : null;

describe(
  "contributor rows (integration)",
  { skip: !url && "TEST_DATABASE_URL not set" },
  () => {
    const db = prisma!;
    let hostId: string;
    let boardId = "";
    let eventId = "";
    const PRICE = 5000;

    /** The two queries the page runs, verbatim. */
    async function rows() {
      const claimed = await db.square.findMany({
        where: {
          boardId,
          paymentStatus: { in: ["paid", "reserved_cash"] },
          playerEmail: { not: null },
        },
        select: {
          playerName: true,
          playerEmail: true,
          playerPhone: true,
          paymentStatus: true,
          claimedAt: true,
          pricePaidCents: true,
        },
      });
      // MIRRORS THE PAGE QUERY, including the widened filter. A harness that
      // still asked only for donations would pass while the page it stands in
      // for showed nothing.
      const contributions = await db.contribution.findMany({
        where: {
          boardId,
          status: { in: ["confirmed", "pending"] },
          voidedAt: null,
          OR: [
            { donationAmountCents: { gt: 0 } },
            { entryAmountCents: { gt: 0 } },
          ],
          contributorEmail: { not: null },
        },
        orderBy: { createdAt: "asc" },
        select: {
          contributorName: true,
          contributorEmail: true,
          contributorPhone: true,
          status: true,
          createdAt: true,
          entryAmountCents: true,
          donationAmountCents: true,
        },
      });
      const passes = await db.admissionPass.findMany({
        where: {
          supporter: { event: { boardId } },
          squareId: null,
          status: { in: ["active", "used"] },
        },
        select: { supporter: { select: { email: true, phone: true } } },
      });
      return contributorRows(
        claimed,
        contributions,
        passes.map((x) => ({
          supporterEmail: x.supporter.email,
          supporterPhone: x.supporter.phone,
        }))
      );
    }

    // A DISTINCT PHONE PER EMAIL BY DEFAULT. Sharing one across fixtures would
    // merge every person in the file under phone identity and quietly hide
    // what these tests are checking. Tests that WANT a shared phone pass one.
    let phoneSeq = 1000;
    const phoneFor = new Map<string, string>();
    function defaultPhone(email: string): string {
      const k = email.toLowerCase();
      if (!phoneFor.has(k)) phoneFor.set(k, `678-555-${phoneSeq++}`);
      return phoneFor.get(k)!;
    }

    async function ticket(email: string, name: string, paid: boolean, phone?: string) {
      const sq = await db.square.findFirstOrThrow({
        where: { boardId, paymentStatus: "open" },
        orderBy: { position: "asc" },
      });
      await db.square.update({
        where: { squareId: sq.squareId },
        data: {
          paymentStatus: paid ? "paid" : "reserved_cash",
          paymentMethod: "cash",
          playerName: name,
          playerEmail: email,
          playerPhone: phone ?? defaultPhone(email),
          pricePaidCents: PRICE,
          batchId: randomUUID(),
          claimedAt: new Date(),
        },
      });
    }

    async function donation(
      email: string,
      name: string,
      opts: { status?: string; voided?: boolean; squareCents?: number; phone?: string } = {}
    ) {
      const sqc = opts.squareCents ?? 0;
      await db.contribution.create({
        data: {
          boardId,
          status: (opts.status ?? "confirmed") as never,
          paymentMethod: "cash",
          squareAmountCents: sqc,
          donationAmountCents: 2500,
          totalPaidCents: 2500 + sqc,
          contributorName: name,
          contributorEmail: email,
          contributorPhone: opts.phone ?? defaultPhone(email),
          confirmedAt: new Date(),
          voidedAt: opts.voided ? new Date() : null,
          // A VOID NEEDS ITS AUTHOR. `contributions_void_fields_together`
          // requires voided_at and voided_by_host_id to arrive together, so a
          // row carrying only voided_at is one production cannot hold. The
          // fixture used to write exactly that, and passed only because the
          // test database was built by `db push`, which creates no CHECKs.
          voidedByHostId: opts.voided ? hostId : null,
        },
      });
    }

    before(async () => {
      const h = await db.host.create({
        data: { email: "cr-" + randomUUID() + "@example.com" },
      });
      hostId = h.id;
    });

    beforeEach(async () => {
      if (boardId) {
        await db.admissionPass.deleteMany({ where: { supporter: { eventId } } });
        await db.admissionGrant.deleteMany({ where: { eventId } });
        await db.eventSupporter.deleteMany({ where: { eventId } });
        await db.square.deleteMany({ where: { boardId } });
        await db.contribution.deleteMany({ where: { boardId } });
        await db.event.deleteMany({ where: { boardId } });
        await db.board.deleteMany({ where: { boardId } });
      }
      const b = await db.board.create({
        data: {
          hostId,
          gameName: "Contributors",
          slug: "cr-" + randomUUID().slice(0, 8),
          boardType: "fundraiser",
          // Every fundraiser must say what it accepts -
          // boards_fundraiser_accepts_something refuses an empty list.
          acceptedPaymentMethods: ["card"],
          squarePrice: PRICE,
          totalSquares: 6,
          timezone: "America/New_York",
          campaignEndsAt: new Date(Date.now() + 7 * 864e5),
        },
      });
      boardId = b.boardId;
      // AN EVENT, so entry tickets have somewhere to mint passes. Squares and
      // donations never needed one - which is why this fixture had none, and
      // why the entry-ticket gap went unnoticed here as well as in the page.
      const ev = await db.event.create({
        data: {
          boardId,
          startsAt: new Date(Date.now() + 30 * 864e5),
          timezone: "America/New_York",
        },
      });
      eventId = ev.id;
      await db.square.createMany({
        data: Array.from({ length: 6 }, (_, i) => ({
          boardId,
          position: i,
          paymentStatus: "open" as const,
        })),
      });
    });

    after(async () => {
      if (boardId) {
        // IN FK ORDER. Passes and grants hold Restrict references to the
        // supporter and the contribution, and the event holds one to the
        // board - so a board delete fails last rather than first, and the
        // failure lands in the suite teardown where it is hardest to read.
        await db.admissionPass.deleteMany({ where: { supporter: { eventId } } });
        await db.admissionGrant.deleteMany({ where: { eventId } });
        await db.eventSupporter.deleteMany({ where: { eventId } });
        await db.square.deleteMany({ where: { boardId } });
        await db.contribution.deleteMany({ where: { boardId } });
        await db.event.deleteMany({ where: { boardId } });
        await db.board.deleteMany({ where: { boardId } });
      }
      if (hostId) await db.host.deleteMany({ where: { id: hostId } });
      await db.$disconnect();
    });

    /**
     * A standalone Entry Ticket purchase, exactly as the routes leave one.
     *
     * `passPrices` are the STORED per-pass amounts. They are what the row's
     * ticket COUNT comes from; the money comes from `entryAmountCents` on the
     * contribution, which is why the two are passed independently here - a
     * fixture that derived one from the other could not catch them disagreeing.
     *
     * A PENDING purchase mints nothing: no supporter, no grant, no passes. That
     * is the card-checkout-not-completed shape, and it is why a row can carry
     * ticket money with no count.
     */
    async function entryPurchase(
      email: string,
      name: string,
      entryAmountCents: number,
      passPrices: number[],
      opts: { status?: string; donationCents?: number; phone?: string } = {}
    ) {
      const status = opts.status ?? "confirmed";
      const donationCents = opts.donationCents ?? 0;
      const phone = opts.phone ?? defaultPhone(email);
      const c = await db.contribution.create({
        data: {
          boardId,
          status: status as never,
          paymentMethod: "cash",
          squareAmountCents: 0,
          donationAmountCents: donationCents,
          entryAmountCents,
          totalPaidCents: entryAmountCents + donationCents,
          contributorName: name,
          contributorEmail: email,
          contributorPhone: phone,
          confirmedAt: status === "confirmed" ? new Date() : null,
        },
      });
      if (status !== "confirmed" || passPrices.length === 0) return c;

      const sup = await db.eventSupporter.upsert({
        where: { eventId_emailKey: { eventId, emailKey: email.toLowerCase() } },
        update: {},
        create: {
          eventId,
          emailKey: email.toLowerCase(),
          phoneKey: normalizePhone(phone)!,
          name,
          email,
          phone,
          status: "active",
          activatedAt: new Date(),
          passSequenceCursor: 0,
        },
      });
      await db.admissionGrant.create({
        data: {
          eventId,
          eventSupporterId: sup.id,
          contributionId: c.id,
          source: "STANDALONE",
          donateAdmissions: false,
        },
      });
      for (const price of passPrices) {
        const next = await db.eventSupporter.update({
          where: { id: sup.id },
          data: { passSequenceCursor: { increment: 1 } },
          select: { passSequenceCursor: true },
        });
        await db.admissionPass.create({
          data: {
            eventSupporterId: sup.id,
            sequenceNumber: next.passSequenceCursor,
            tier: "ADULT",
            priceBasis: "EARLY",
            pricePaidCents: price,
            token: randomUUID().replace(/-/g, ""),
            status: "active",
          },
        });
      }
      return c;
    }

    // ====================================================================
    // ENTRY TICKETS. The regression: an entry purchase creates no Square and
    // carries its money in `entryAmountCents`, so the roster query - which
    // asked only for squares and `donationAmountCents > 0` - returned nothing
    // for a board whose only sales were tickets.
    //
    // MONEY IS THE RECORDED AMOUNT, NEVER count x today's price. Ticket money
    // is `Square.pricePaidCents` and `Contribution.entryAmountCents`; the count
    // is minted passes, because no ledger column holds a quantity.
    // ====================================================================

    const find = (rs: Awaited<ReturnType<typeof rows>>, email: string) =>
      rs.find((r) => r.email === email);

    // THE REPORTED REGRESSION, as the host would state it.
    test("a ticket-only entry purchaser appears, with count and money", async () => {
      await entryPurchase("entry1@example.com", "Entry One", 8000, [4000, 4000]);
      const r = find(await rows(), "entry1@example.com");
      assert.ok(r, "the purchaser is on the roster at all");
      assert.equal(r.tickets, 2);
      assert.equal(r.ticketCents, 8000);
      assert.equal(r.donationCents, 0);
      assert.equal(r.donated, false);
      assert.equal(r.status, "CONFIRMED");
    });

    test("a donation-only contributor carries money and no tickets", async () => {
      await donation("entrydonor@example.com", "Just Giving");
      const r = find(await rows(), "entrydonor@example.com");
      assert.ok(r);
      assert.equal(r.tickets, 0);
      assert.equal(r.ticketCents, 0);
      assert.equal(r.donationCents, 2500);
      assert.equal(r.donated, true);
    });

    // TICKET AND DONATION DOLLARS STAY DISTINCT. One purchase, two amounts, and
    // the row must never collapse them into $65.
    test("a ticket + donation purchaser keeps the two amounts apart", async () => {
      await entryPurchase("both@example.com", "Both", 4000, [4000], {
        donationCents: 2500,
      });
      const r = find(await rows(), "both@example.com");
      assert.ok(r);
      assert.equal(r.tickets, 1);
      assert.equal(r.ticketCents, 4000);
      assert.equal(r.donationCents, 2500);
      assert.notEqual(r.ticketCents + r.donationCents, r.ticketCents, "not collapsed");
    });

    // AWAITING. A pending purchase mints no passes, so there is money and no
    // count - deliberately rendered as the amount alone rather than "0 tickets".
    test("an awaiting direct-payment purchaser shows money and no count", async () => {
      await entryPurchase("awaiting@example.com", "Awaiting", 8000, [], {
        status: "pending",
      });
      const r = find(await rows(), "awaiting@example.com");
      assert.ok(r);
      assert.equal(r.status, "AWAITING");
      assert.equal(r.ticketCents, 8000, "the money is known");
      assert.equal(r.tickets, 0, "the count is not, until passes are minted");
    });

    test("multiple entry purchases by one person accumulate into one row", async () => {
      await entryPurchase("repeat@example.com", "Repeat", 4000, [4000]);
      await entryPurchase("repeat@example.com", "Repeat", 5000, [5000]);
      const all = await rows();
      assert.equal(all.filter((r) => r.email === "repeat@example.com").length, 1);
      const r = find(all, "repeat@example.com")!;
      assert.equal(r.tickets, 2);
      assert.equal(r.ticketCents, 9000);
    });

    // THE IDENTITY REQUIREMENT, stated as the host's sentence: an entry ticket
    // and a separate donation under the same email is ONE person. Both fold
    // through roster-identity.ts, the same module admission.ts stores from.
    test("an entry ticket and a separate donation under one email is one row", async () => {
      const email = "onerow@example.com";
      await entryPurchase(email, "One Row", 4000, [4000]);
      await donation(email, "One Row");
      const all = await rows();
      assert.equal(all.filter((r) => r.email === email).length, 1, "one row, not two");
      const r = find(all, email)!;
      assert.equal(r.tickets, 1);
      assert.equal(r.ticketCents, 4000);
      assert.equal(r.donationCents, 2500);
      assert.equal(r.donated, true);
    });

    // Same person, two addresses, one phone. Folds on phone, and the amounts
    // from both come with them.
    test("an entry purchase merges by phone onto an existing row", async () => {
      const phone = "678-555-9911";
      await donation("phoneA@example.com", "Phone Person", { phone });
      await entryPurchase("phoneB@example.com", "Phone Person", 4000, [4000], { phone });
      const all = await rows();
      const merged = all.filter(
        (r) => r.email === "phonea@example.com" || r.email === "phoneb@example.com"
      );
      assert.equal(merged.length, 1, "one person, not two");
      assert.equal(merged[0].ticketCents, 4000);
      assert.equal(merged[0].donationCents, 2500);
    });

    // HISTORICAL PRICE. The board moves to $50 AFTER the purchase; the row must
    // still read $40. This is the assertion that fails the moment anyone
    // computes ticket value as count x the board's current price.
    test("an early-bird ticket still reads its purchase price after the board moves", async () => {
      await entryPurchase("early@example.com", "Early Bird", 4000, [4000]);
      await db.board.update({
        where: { boardId },
        // squarePrice alone. Setting an early entry price without its
        // regular counterpart trips boards_entry_pricing_coherent, and the
        // point here is only that the board price MOVED after the purchase.
        data: { squarePrice: 5000 },
      });
      const r = find(await rows(), "early@example.com");
      assert.ok(r);
      assert.equal(r.ticketCents, 4000, "what was paid, not what it costs now");
      assert.equal(r.tickets, 1);
    });

    // A square's money is on the square. Counting the contribution's
    // `squareAmountCents` as well would double it, and a mixed purchase is the
    // case where that would show.
    test("a square purchase with a donation on top is not double-counted", async () => {
      await ticket("mixed@example.com", "Mixed", true);
      await donation("mixed@example.com", "Mixed", { squareCents: PRICE });
      const r = find(await rows(), "mixed@example.com");
      assert.ok(r);
      assert.equal(r.tickets, 1);
      assert.equal(r.ticketCents, PRICE, "the square's price once, not twice");
      assert.equal(r.donationCents, 2500);
    });

    // Square-minted passes are excluded by the caller. Without that filter a
    // square would be counted as a square AND as its pass.
    test("a square and its pass are one ticket, not two", async () => {
      await ticket("sqpass@example.com", "Square Pass", true);
      const sq = await db.square.findFirstOrThrow({
        where: { boardId, playerEmail: "sqpass@example.com" },
      });
      const sup = await db.eventSupporter.create({
        data: {
          eventId,
          emailKey: "sqpass@example.com",
          phoneKey: normalizePhone(defaultPhone("sqpass@example.com"))!,
          name: "Square Pass",
          email: "sqpass@example.com",
          phone: defaultPhone("sqpass@example.com"),
          status: "active",
          activatedAt: new Date(),
          passSequenceCursor: 1,
        },
      });
      await db.admissionPass.create({
        data: {
          eventSupporterId: sup.id,
          squareId: sq.squareId,
          sequenceNumber: 1,
          token: randomUUID().replace(/-/g, ""),
          status: "active",
        },
      });
      const r = find(await rows(), "sqpass@example.com");
      assert.ok(r);
      assert.equal(r.tickets, 1, "the square, once");
    });

    // THE REPORTED BUG.
    test("a donation with no tickets appears as a contributor", async () => {
      await donation("donor@example.com", "Donor");
      const r = await rows();
      assert.equal(r.length, 1, "the list is not empty");
      assert.equal(r[0].tickets, 0, "no inventory taken");
      assert.equal(r[0].donated, true);
      assert.equal(r[0].status, "CONFIRMED");
    });

    test("a pending donation shows AWAITING", async () => {
      await donation("donor@example.com", "Donor", { status: "pending" });
      assert.equal((await rows())[0].status, "AWAITING");
    });

    // Same aggregation the square-only version used.
    test("tickets and a donation from one person are ONE row", async () => {
      await ticket("both@example.com", "Both", true);
      await ticket("both@example.com", "Both", true);
      await donation("both@example.com", "Both");

      const r = await rows();
      assert.equal(r.length, 1);
      assert.equal(r[0].tickets, 2);
      assert.equal(r[0].donated, true);
      assert.equal(r[0].status, "CONFIRMED");
    });

    test("case differences in the email still collapse to one row", async () => {
      await ticket("Mixed@Example.com", "Person", true);
      await donation("mixed@example.COM", "Person");
      const r = await rows();
      assert.equal(r.length, 1);
      assert.equal(r[0].tickets, 1);
      assert.equal(r[0].donated, true);
    });

    // A host chasing money must not see a green row with something unpaid
    // behind it - the same rule the squares already followed.
    test("a confirmed ticket plus a pending donation is MIXED", async () => {
      await ticket("m@example.com", "M", true);
      await donation("m@example.com", "M", { status: "pending" });
      assert.equal((await rows())[0].status, "MIXED");
    });

    test("a reserved ticket plus a confirmed donation is MIXED", async () => {
      await ticket("m2@example.com", "M2", false);
      await donation("m2@example.com", "M2");
      assert.equal((await rows())[0].status, "MIXED");
    });

    // A VOID LEAVES status READING confirmed. Filtering on status alone would
    // list someone as a contributor after their money was reversed.
    test("a voided donation is not a contributor, despite status = confirmed", async () => {
      await donation("void@example.com", "Voided", { voided: true });
      assert.deepEqual(await rows(), []);
    });

    test("a released donation is not a contributor", async () => {
      await donation("rel@example.com", "Released", { status: "released" });
      assert.deepEqual(await rows(), []);
    });

    // Donate-on-top: one purchase, tickets and a gift. The square already puts
    // them in the list; the marker is what says they also gave.
    test("a mixed contribution marks the row as donated", async () => {
      await ticket("top@example.com", "OnTop", true);
      await donation("top@example.com", "OnTop", { squareCents: PRICE });
      const r = await rows();
      assert.equal(r.length, 1);
      assert.equal(r[0].tickets, 1);
      assert.equal(r[0].donated, true);
    });

    test("a ticket buyer who never donated is not marked", async () => {
      await ticket("plain@example.com", "Plain", true);
      const r = await rows();
      assert.equal(r[0].donated, false);
      assert.equal(r[0].tickets, 1);
    });

    // ---- the shared identity rule, applied to presentation -----------------
    //
    // Same precedence admission.ts applies to supporters, derived per render.

    test("a new email on a KNOWN PHONE is the same person", async () => {
      await ticket("first@example.com", "Chris", true, "(678) 555-9999");
      await donation("second@example.com", "Chris R", { phone: "1-678-555-9999" });

      const r = await rows();
      assert.equal(r.length, 1, "one person, two addresses, one phone");
      assert.equal(r[0].tickets, 1);
      assert.equal(r[0].donated, true);
    });

    test("phone formatting differences still merge", async () => {
      await ticket("a@example.com", "A", true, "6785551111");
      await donation("b@example.com", "A", { phone: "+1 (678) 555-1111" });
      assert.equal((await rows()).length, 1);
    });

    // EMAIL WINS. Two people on a shared household phone with their own
    // addresses stay two contributors - accepted for MVP, and the reason the
    // lookup is ordered rather than an OR.
    test("different emails on a shared phone are still merged - documented", async () => {
      await ticket("mum@example.com", "Mum", true, "6785552222");
      await ticket("dad@example.com", "Dad", true, "6785552222");
      const r = await rows();
      assert.equal(r.length, 1, "shared household phone merges - accepted for MVP");
    });

    // A row predating the mandatory-both rule is SHOWN, never dropped and
    // never guessed into someone else.
    test("a contribution with no phone still appears, and merges only on email", async () => {
      await donation("legacy@example.com", "Legacy", { phone: "" });
      const r = await rows();
      assert.equal(r.length, 1, "shown, not silently dropped");
      assert.equal(r[0].email, "legacy@example.com");
    });

    test("no contributions at all yields an empty list", async () => {
      assert.deepEqual(await rows(), []);
    });
  }
);
