import {
  createCheckinStaffLink,
  revokeCheckinStaffLink,
} from "@/lib/check-in-staff-handlers";

// ============================================================
// TEMPORARY ALIAS — delete after the release following 2026-08-30.
//
// See PHASE-2-BACKLOG.md, entry "Remove /volunteer-access alias route".
//
// This path was renamed to /api/host/boards/[id]/check-in-staff in S0. A host
// dashboard loaded BEFORE that deploy still holds the old URL in its bundle
// and will call it afterward, so deleting it immediately would break the
// create and revoke buttons for anyone with a tab already open.
//
// Both paths call one shared implementation. There is no second copy to drift.
// An alias without a removal ticket is permanent, which is why this one has a
// dated entry in the backlog rather than a vague "later".
// ============================================================

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  return createCheckinStaffLink(request, id);
}

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  return revokeCheckinStaffLink(request, id);
}
