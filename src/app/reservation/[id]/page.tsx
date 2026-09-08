import { prisma } from "@/lib/prisma";
import { notFound } from "next/navigation";
import type { Metadata } from "next";
import CopyField from "./copy-field";

export const dynamic = "force-dynamic";

// Contributor pending-payment screen — v2 §20.2, invariants 113 and 114.
//
// What they reserved, what to send, where to send it, and the reference code
// that lets the host match a bank memo to this row.
//
// A STABLE URL, AND NOW GENUINELY EMAILED. They leave to open a banking app and
// come back to this, possibly days later, possibly on a different device. The
// reservation id is the key — a server-generated UUID, unguessable. The same
// model the passes screen uses.
//
// THIS COMMENT WAS WRONG UNTIL 2026-09-08 and is worth the correction rather
// than a quiet rewrite: it asserted "emailed to them" when no reservation email
// existed anywhere in the codebase. The reserve route sent nothing, and a
// contributor who closed this tab lost the reference code entirely. The claim
// was read as fact and repeated. `sendReservationEmail` in confirmation-email.ts
// now makes it true, on creation.
//
// THIS PAGE IS STILL THE AUTHORITY. It recomputes from the board on every load,
// so it can say the host cleared a handle where the email — frozen at send —
// would go on naming an account that may no longer be theirs. The email says as
// much and links here.
//
// THE LINK IS NOT A CREDENTIAL FOR ANYTHING BUT READING. Nothing on this page
// changes state. The reference code shown here authorises nothing either; it is
// reconciliation metadata, and the host confirming payment is a host action
// taken against their own board.
//
// NO COUNTDOWN AND NO EXPIRY DATE. There is neither. An entry ticket blocks
// nobody, so nothing is held and nothing runs out; a timer here would invent a
// deadline that does not exist. What ends an unpaid reservation is the host
// releasing it, or the campaign closing.

interface Props {
  params: Promise<{ id: string }>;
}

export const metadata: Metadata = {
  title: "Your reservation — Daali",
  // Carries a person's name, email and payment intent. Keep it out of search.
  robots: { index: false, follow: false },
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const RAIL_LABEL: Record<string, string> = {
  zelle: "Zelle",
  cashapp: "Cash App",
  venmo: "Venmo",
  paypal: "PayPal",
};

const HANDLE_FOR = {
  zelle: "hostZelle",
  cashapp: "hostCashapp",
  venmo: "hostVenmo",
  paypal: "hostPaypal",
} as const;

const TIER_LABEL: Record<string, string> = { ADULT: "Adult", CHILD: "Child" };

function money(cents: number): string {
  return `$${(cents / 100).toLocaleString("en-US", {
    minimumFractionDigits: cents % 100 === 0 ? 0 : 2,
    maximumFractionDigits: 2,
  })}`;
}

export default async function ReservationPage({ params }: Props) {
  const { id } = await params;

  // `id` is @db.Uuid, and Prisma raises rather than matching nothing when a
  // value will not cast — so a junk URL must 404 rather than 500.
  if (!UUID.test(id)) notFound();

  const reservation = await prisma.entryReservation.findUnique({
    where: { id },
    select: {
      referenceCode: true,
      contributorName: true,
      contributorEmail: true,
      donationAmountCents: true,
      paymentRail: true,
      status: true,
      createdAt: true,
      lines: {
        select: { tier: true, priceBasis: true, unitPriceCents: true, quantity: true },
        orderBy: { tier: "asc" },
      },
      board: {
        select: {
          gameName: true,
          timezone: true,
          hostZelle: true,
          hostCashapp: true,
          hostVenmo: true,
          hostPaypal: true,
        },
      },
    },
  });

  if (!reservation) notFound();

  const { board } = reservation;
  const rail = reservation.paymentRail as keyof typeof HANDLE_FOR;
  const handle = board[HANDLE_FOR[rail]];
  const railLabel = RAIL_LABEL[rail] ?? rail;

  // Read from the STORED unit price, never re-quoted. A reservation taken
  // before the early-bird cutoff still shows and still owes the early price.
  const ticketCents = reservation.lines.reduce(
    (sum, l) => sum + l.unitPriceCents * l.quantity,
    0
  );
  // THREE NUMBERS, NOT ONE. Someone checking this against what they chose
  // needs to see the donation as its own line; a single total they cannot
  // reconcile is a total they will query.
  const donationCents = reservation.donationAmountCents;
  const totalCents = ticketCents + donationCents;
  const totalTickets = reservation.lines.reduce((n, l) => n + l.quantity, 0);

  const reservedOn = new Intl.DateTimeFormat("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
    timeZone: board.timezone ?? "America/New_York",
  }).format(reservation.createdAt);

  const pending = reservation.status === "pending";

  return (
    <div className="min-h-screen bg-gray-950 text-white">
      <div className="max-w-lg mx-auto px-4 py-6">
        <p className="text-sm text-gray-400">{board.gameName}</p>

        {/* WHAT HAPPENED, AND WHAT IS STILL REQUIRED, ABOVE EVERYTHING ELSE.
            The page used to open on a small-caps "Your reservation" label and a
            list of line items, which tells a contributor what they chose and
            nothing about whether they are done. Someone returning days later
            could not answer the only question they came back with.

            All three states get a header at the same weight, so they are
            distinguishable at a glance rather than by reading the body copy.
            PENDING AND CONFIRMED MUST NOT BE CONFUSABLE: `confirmed` here means
            the host received the money and the passes exist, so a returning
            contributor reading the wrong one either pays twice or never pays. */}
        {pending ? (
          <>
            <h1 className="mt-1 text-2xl font-bold leading-tight">Reservation saved</h1>
            <p className="mt-1.5 text-sm text-gray-300 leading-relaxed">
              Send {money(totalCents)} by {railLabel} to finish. Your passes are
              emailed once the host marks the payment received.
            </p>
          </>
        ) : reservation.status === "released" ? (
          <>
            <h1 className="mt-1 text-2xl font-bold leading-tight">
              Reservation released
            </h1>
            <p className="mt-1.5 text-sm text-gray-300 leading-relaxed">
              Nothing is owed and nothing was charged.{" "}
              <span className="text-gray-400">
                Reserved {reservedOn}. If you did send payment, contact the host
                — do not send it again.
              </span>
            </p>
          </>
        ) : (
          <>
            <h1 className="mt-1 text-2xl font-bold leading-tight text-green-300">
              You&apos;re all set
            </h1>
            <p className="mt-1.5 text-sm text-gray-300 leading-relaxed">
              Passes emailed to {reservation.contributorEmail}.
            </p>
          </>
        )}

        {/* What they reserved. Per-line prices, because a total alone cannot be
            checked against what they chose. */}
        <div className="mt-5 rounded-lg border border-gray-800 bg-gray-900 p-4">
          <p className="text-[11px] uppercase tracking-wider text-gray-500">
            Your reservation
          </p>
          <ul className="mt-2 space-y-1.5">
            {reservation.lines.map((l) => (
              <li
                key={`${l.tier}:${l.priceBasis}`}
                className="flex items-baseline justify-between gap-3 text-sm"
              >
                <span className="text-gray-300">
                  {l.quantity} × {TIER_LABEL[l.tier] ?? l.tier}
                  {l.priceBasis === "EARLY" && (
                    <span className="text-gray-600"> · early bird</span>
                  )}
                  <span className="text-gray-600"> @ {money(l.unitPriceCents)}</span>
                </span>
                <span className="tabular-nums text-gray-200">
                  {money(l.unitPriceCents * l.quantity)}
                </span>
              </li>
            ))}
          </ul>
          {donationCents > 0 && (
            <div className="mt-2 flex items-baseline justify-between gap-3 border-t border-gray-800 pt-2 text-sm">
              <span className="text-gray-300">Donation</span>
              <span className="tabular-nums text-gray-200">{money(donationCents)}</span>
            </div>
          )}
          <div className="mt-3 flex items-baseline justify-between border-t border-gray-800 pt-2.5">
            <span className="text-sm font-medium">Total</span>
            <span className="text-lg font-bold tabular-nums">{money(totalCents)}</span>
          </div>
        </div>

        {pending && (
          <>
            <h2 className="mt-6 text-sm font-medium">How to pay</h2>

            <div className="mt-2 space-y-2">
              <CopyField label="Amount" value={money(totalCents)} size="large" />

              {handle ? (
                <CopyField
                  label={`Send by ${railLabel} to`}
                  value={handle}
                  hint={`Open ${railLabel} and send this amount to this ${
                    handle.includes("@") ? "address" : "handle"
                  }.`}
                />
              ) : (
                // The host cleared the handle after this was reserved. Say so
                // plainly rather than rendering a blank field to copy.
                <div className="rounded-lg border border-amber-900/60 bg-amber-950/20 px-3.5 py-3">
                  <p className="text-sm text-amber-200">
                    This host&apos;s {railLabel} details are no longer set up.
                  </p>
                  <p className="mt-1 text-xs text-gray-400">
                    Contact them before sending anything.
                  </p>
                </div>
              )}

              <CopyField
                label="Reference code"
                value={reservation.referenceCode}
                size="large"
                hint={`Put ${reservation.referenceCode} in the payment memo. This is how the host matches your payment to your reservation.`}
              />
            </div>

            {/* NOT A DISCLAIMER, A FACT THEY NEED. Every other purchase on this
                platform goes through a card form; this one does not, and
                someone who assumes it did will sit waiting for a charge that
                never comes. */}
            <p className="mt-4 text-xs text-gray-500 leading-relaxed">
              Nothing is charged through Daali. You send the money directly to
              the host with the app above, and they mark it received — usually
              within a day or two. Your passes are emailed to you then.
            </p>
          </>
        )}

        <p className="mt-6 text-[11px] text-gray-600 leading-relaxed">
          Reserved by {reservation.contributorName}. Keep this link — it is the
          way back to your reservation.
        </p>
      </div>
    </div>
  );
}
