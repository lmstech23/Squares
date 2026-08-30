import {
  createCheckinStaffLink,
  revokeCheckinStaffLink,
} from "@/lib/check-in-staff-handlers";

// HOST: Create and revoke check-in staff links — v2 §6B, sign-up addendum §2.
//
// POST   { label }          -> creates, returns the raw link ONCE
// DELETE { checkinStaffId } -> revokes
//
// The raw token is never stored. A host who loses it revokes and makes
// another, which is the correct outcome for a credential.

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
