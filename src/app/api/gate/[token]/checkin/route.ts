import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { resolveGateSession } from "@/lib/check-in-staff";
import { ADMISSION } from "@/lib/board-vocabulary";

// Gate check-in — fundraiser-board-v2.md §6B.
//
// POST /api/gate/[token]/checkin
// Body: { passToken?: string, passId?: string, action: "check_in" | "undo" }
//
// Check-in staff CONSUME entitlement and never create it — the
// consume-never-create rule in the admission addendum. No check-in action
// increases the number of passes on an event.
// Nothing here mints, voids, or touches money. The only state it writes is a
// pass moving between `active` and `used`, plus the log row that makes undo
// auditable.
//
// Undo exists because misscans are the most common gate error, and without it
// the counter drifts until the host stops trusting the number. Undo consumes
// nothing and creates nothing.

interface Body {
  passToken?: string;
  passId?: string;
  action: "check_in" | "undo";
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ token: string }> }
) {
  try {
    const { token } = await params;
    const session = await resolveGateSession(token);

    // Unknown, malformed and revoked all land here. A revoked link stops
    // working immediately — that is the whole point of revoking it.
    if (!session) {
      return NextResponse.json(
        { error: "This gate link is no longer valid." },
        { status: 401 }
      );
    }

    const body = (await request.json()) as Body;
    if (body.action !== "check_in" && body.action !== "undo") {
      return NextResponse.json({ error: "Unknown action." }, { status: 400 });
    }
    if (!body.passToken && !body.passId) {
      return NextResponse.json({ error: `No ${ADMISSION.one} given.` }, { status: 400 });
    }

    // Scoped to this staff member's event. A token from another event scans as
    // "not for this event" rather than admitting someone.
    const pass = await prisma.admissionPass.findFirst({
      where: {
        ...(body.passToken ? { token: body.passToken } : { id: body.passId }),
        supporter: { eventId: session.eventId },
      },
      select: {
        id: true,
        status: true,
        checkedInAt: true,
        checkedInBy: { select: { label: true } },
        supporter: { select: { id: true, name: true, email: true } },
      },
    });

    if (!pass) {
      return NextResponse.json(
        { error: `Not a ${ADMISSION.one} for this event.` },
        { status: 404 }
      );
    }

    if (pass.status === "void") {
      return NextResponse.json(
        { error: `This ${ADMISSION.one} was cancelled and is no longer valid.` },
        { status: 409 }
      );
    }

    if (body.action === "check_in") {
      // Duplicate scan. Say WHEN and BY WHOM — someone holding up a line
      // needs to know whether this is the same family coming back or the same
      // screenshot on two phones, and "already used" answers neither.
      if (pass.status === "used") {
        const when = pass.checkedInAt
          ? new Intl.DateTimeFormat("en-US", {
              hour: "numeric",
              minute: "2-digit",
            }).format(pass.checkedInAt)
          : "earlier";
        return NextResponse.json(
          {
            error: `Already scanned at ${when}${
              pass.checkedInBy?.label ? ` by ${pass.checkedInBy.label}` : ""
            }.`,
            duplicate: true,
            supporter: pass.supporter,
          },
          { status: 409 }
        );
      }

      // Conditional update: two staff scanning the same code at once,
      // one wins and the other gets the duplicate message on retry.
      const { count } = await prisma.admissionPass.updateMany({
        where: { id: pass.id, status: "active" },
        data: {
          status: "used",
          checkedInAt: new Date(),
          checkedInByCheckinStaffId: session.checkinStaffId,
        },
      });

      if (count === 0) {
        return NextResponse.json(
          { error: "Already scanned a moment ago.", duplicate: true },
          { status: 409 }
        );
      }

      await prisma.checkInLog.create({
        data: {
          passId: pass.id,
          eventId: session.eventId,
          action: "check_in",
          byCheckinStaffId: session.checkinStaffId,
        },
      });

      return NextResponse.json({ ok: true, supporter: pass.supporter });
    }

    // Undo. Restores to active and logs it. Never deletes the check-in record —
    // the host needs to see that it happened and was reversed.
    if (pass.status !== "used") {
      return NextResponse.json(
        { error: `That ${ADMISSION.one} has not been scanned.` },
        { status: 409 }
      );
    }

    await prisma.admissionPass.updateMany({
      where: { id: pass.id, status: "used" },
      data: {
        status: "active",
        checkedInAt: null,
        checkedInByCheckinStaffId: null,
      },
    });

    await prisma.checkInLog.create({
      data: {
        passId: pass.id,
        eventId: session.eventId,
        action: "undo",
        byCheckinStaffId: session.checkinStaffId,
      },
    });

    return NextResponse.json({ ok: true, undone: true, supporter: pass.supporter });
  } catch (error) {
    console.error("Gate check-in error:", error);
    return NextResponse.json(
      { error: "Something went wrong. Try again." },
      { status: 500 }
    );
  }
}
