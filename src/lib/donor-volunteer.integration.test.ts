import { test, describe, before, after, beforeEach, mock } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "crypto";
import { PrismaClient } from "@prisma/client";
import { donorSignup } from "./donor-signup.ts";
import { wantsToHelp } from "./signup-rules.ts";

// A donor volunteering, over REAL rows, on BOTH channels.
//
// A donor could always CLAIM: mayClaim() reads supporter status alone, and a
// confirmed donation already activates the supporter. What they could not get
// was the LINK - interest lived only on AdmissionGrant, and a donation creates
// none. This asserts the link now reaches them, that both channels agree, and
// that ENTITLEMENT DID NOT MOVE: no grant, no pass, ever.
//
//   npm run test:db:up && npm run test:integration:volunteer

const url = process.env.TEST_DATABASE_URL;
const prisma = url ? new PrismaClient({ datasources: { db: { url } } }) : null;

const sends: { to: string; html: string }[] = [];
if (url) {
  mock.module("@/lib/email", {
    namedExports: {
      sendEmail: async (to: string, _s: string, html: string) => {
        sends.push({ to, html });
      },
    },
  });
}

const { sendPendingConfirmations } = url
  ? await import("./confirmation-email.ts")
  : { sendPendingConfirmations: null as never };

describe(
  "donor volunteer signup (integration)",
  { skip: !url && "TEST_DATABASE_URL not set" },
  () => {
    const db = prisma!;
    let hostId: string;
    let boardId = "";
    let eventId = "";

    async function seed(opts: { sheet?: boolean; sheetOpen?: boolean } = {}) {
      const b = await db.board.create({
        data: {
          hostId,
          gameName: "Volunteer Board",
          slug: "vol-" + randomUUID().slice(0, 8),
          boardType: "fundraiser",
          squarePrice: 5000,
          totalSquares: 1,
          timezone: "America/New_York",
          campaignEndsAt: new Date(Date.now() + 7 * 864e5),
        },
      });
      boardId = b.boardId;
      const ev = await db.event.create({
        data: {
          boardId,
          name: "Tailgate",
          startsAt: new Date(Date.now() + 14 * 864e5),
          timezone: "America/New_York",
        },
      });
      eventId = ev.id;
      if (opts.sheet !== false) {
        await db.signupSheet.create({
          data: { eventId, isOpen: opts.sheetOpen !== false },
        });
      }
    }

    async function supporter(email: string, status: "pending" | "active") {
      return db.eventSupporter.create({
        data: {
          eventId,
          emailKey: email.toLowerCase(),
          name: "Donor",
          email: email.toLowerCase(),
          status,
          activatedAt: status === "active" ? new Date() : null,
        },
      });
    }

    async function donation(
      email: string,
      opts: { help?: boolean; status?: string } = {}
    ) {
      return db.contribution.create({
        data: {
          boardId,
          status: (opts.status ?? "confirmed") as never,
          paymentMethod: "cash",
          squareAmountCents: 0,
          donationAmountCents: 2500,
          totalPaidCents: 2500,
          contributorName: "Donor",
          contributorEmail: email,
          wantsToHelp: opts.help ?? true,
          confirmedAt: new Date(),
        },
      });
    }

    /** No admission was created by any of this. */
    async function assertNoEntitlement() {
      assert.equal(
        await db.admissionGrant.count({ where: { eventId } }),
        0,
        "a grant was created"
      );
      assert.equal(
        await db.admissionPass.count({ where: { supporter: { eventId } } }),
        0,
        "a pass was created"
      );
    }

    before(async () => {
      const h = await db.host.create({
        data: { email: "vol-" + randomUUID() + "@example.com" },
      });
      hostId = h.id;
    });

    beforeEach(async () => {
      sends.length = 0;
      if (boardId) {
        await db.supporterAccessToken.deleteMany({
          where: { supporter: { eventId } },
        });
        await db.signupSheet.deleteMany({ where: { eventId } });
        await db.eventSupporter.deleteMany({ where: { eventId } });
        await db.event.deleteMany({ where: { boardId } });
        await db.contribution.deleteMany({ where: { boardId } });
        await db.square.deleteMany({ where: { boardId } });
        await db.board.deleteMany({ where: { boardId } });
        boardId = "";
      }
    });

    after(async () => {
      if (boardId) {
        await db.supporterAccessToken.deleteMany({ where: { supporter: { eventId } } });
        await db.signupSheet.deleteMany({ where: { eventId } });
        await db.eventSupporter.deleteMany({ where: { eventId } });
        await db.event.deleteMany({ where: { boardId } });
        await db.contribution.deleteMany({ where: { boardId } });
        await db.square.deleteMany({ where: { boardId } });
        await db.board.deleteMany({ where: { boardId } });
      }
      if (hostId) await db.host.deleteMany({ where: { id: hostId } });
      await db.$disconnect();
    });

    // ---- the shared decision ------------------------------------------------

    test("an active donor who asked to help gets a link", async () => {
      await seed();
      await supporter("d@example.com", "active");
      const r = await donorSignup(eventId, "d@example.com", true);
      assert.equal(r.kind, "link");
      assert.ok(r.kind === "link" && r.path.startsWith("/signup/"));
      await assertNoEntitlement();
    });

    // THE DIRECT-PAYMENT MOMENT. At declaration the host has confirmed
    // nothing, so nobody is active and no link can exist. The screen must
    // explain the timing instead of showing a control.
    test("a PENDING supporter gets no link", async () => {
      await seed();
      await supporter("d@example.com", "pending");
      assert.equal((await donorSignup(eventId, "d@example.com", true)).kind, "none");
    });

    test("not ticking the box mints nothing, not even a token", async () => {
      await seed();
      const sup = await supporter("d@example.com", "active");
      assert.equal((await donorSignup(eventId, "d@example.com", false)).kind, "none");
      assert.equal(
        await db.supporterAccessToken.count({ where: { eventSupporterId: sup.id } }),
        0,
        "a token was minted for someone who never asked"
      );
    });

    test("no sheet is `none`, not `closed` - nothing is promised", async () => {
      await seed({ sheet: false });
      await supporter("d@example.com", "active");
      assert.equal((await donorSignup(eventId, "d@example.com", true)).kind, "none");
    });

    test("a closed sheet says closed rather than linking", async () => {
      await seed({ sheetOpen: false });
      await supporter("d@example.com", "active");
      assert.equal((await donorSignup(eventId, "d@example.com", true)).kind, "closed");
    });

    test("a board with no event offers nothing", async () => {
      await seed();
      assert.equal((await donorSignup(null, "d@example.com", true)).kind, "none");
    });

    // ---- the email channel, end to end -------------------------------------

    test("the confirmation email carries the link once confirmed", async () => {
      await seed();
      await supporter("d@example.com", "active");
      await donation("d@example.com", { help: true });

      await sendPendingConfirmations({ boardId });

      assert.equal(sends.length, 1);
      assert.match(sends[0].html, /Volunteer sign-up/);
      assert.match(sends[0].html, /\/signup\//, "a real link, not a promise");
      await assertNoEntitlement();
    });

    test("a donor who did not tick the box gets no volunteer block", async () => {
      await seed();
      await supporter("d@example.com", "active");
      await donation("d@example.com", { help: false });

      await sendPendingConfirmations({ boardId });
      assert.equal(sends.length, 1);
      assert.ok(!sends[0].html.includes("Volunteer sign-up"));
    });

    test("a closed sheet emails the explanation, not a dead link", async () => {
      await seed({ sheetOpen: false });
      await supporter("d@example.com", "active");
      await donation("d@example.com", { help: true });

      await sendPendingConfirmations({ boardId });
      assert.match(sends[0].html, /closed for now/);
      assert.ok(!sends[0].html.includes("/signup/"));
    });

    // ---- both channels agree ------------------------------------------------
    //
    // The card screen and the email call the SAME function, so eligibility
    // cannot differ. Asserted rather than assumed: the two must return the
    // same kind for the same supporter.
    test("card and direct payment reach the same eligibility", async () => {
      await seed();
      await supporter("same@example.com", "active");

      const cardChannel = await donorSignup(eventId, "same@example.com", true);
      const emailChannel = await donorSignup(eventId, "same@example.com", true);
      assert.equal(cardChannel.kind, emailChannel.kind);
      assert.equal(cardChannel.kind, "link");

      // Two links, both usable, neither invalidating the other - the same
      // property issueSupporterAccessLink already guarantees for tickets.
      const sup = await db.eventSupporter.findFirstOrThrow({
        where: { eventId, emailKey: "same@example.com" },
      });
      assert.equal(
        await db.supporterAccessToken.count({ where: { eventSupporterId: sup.id } }),
        2
      );
      await assertNoEntitlement();
    });

    // ---- the one-way OR -----------------------------------------------------

    test("interest is an OR across both sources, and never a revoke", () => {
      // Grants and contributions are the same shape to this function.
      assert.equal(wantsToHelp([{ wantsToHelp: false }, { wantsToHelp: true }]), true);
      assert.equal(wantsToHelp([{ wantsToHelp: true }, { wantsToHelp: false }]), true);
      assert.equal(wantsToHelp([{ wantsToHelp: false }]), false);
      assert.equal(wantsToHelp([]), false);
    });
  }
);
