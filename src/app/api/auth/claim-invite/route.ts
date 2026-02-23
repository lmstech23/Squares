import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { prisma } from "@/lib/prisma";
import { SIGNUP_CREDITS, MAX_HOSTS } from "@/lib/constants";

/**
 * POST /api/auth/claim-invite
 * Called after OTP verification. Claims the invite code and grants signup credits.
 * Requires authentication.
 */
export async function POST(request: Request) {
  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();

    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { code } = (await request.json()) as { code?: string };

    if (!code?.trim()) {
      return NextResponse.json(
        { error: "Invite code is required." },
        { status: 400 }
      );
    }

    const trimmed = code.trim().toUpperCase();

    // All-in-one transaction: validate code, create/find host, claim, grant credits
    const result = await prisma.$transaction(async (tx) => {
      // 1. Host cap check
      const hostCount = await tx.host.count();
      if (hostCount >= MAX_HOSTS) {
        throw new Error("HOST_CAP_REACHED");
      }

      // 2. Validate invite code
      const invite = await tx.inviteCode.findUnique({
        where: { code: trimmed },
      });

      if (!invite) throw new Error("INVALID_CODE");
      if (invite.claimedBy) throw new Error("ALREADY_CLAIMED");
      if (invite.expiresAt && invite.expiresAt < new Date()) throw new Error("EXPIRED");

      // 3. Find or create host
      const identifier = user.email ?? user.phone ?? user.id;
      let host = await tx.host.findUnique({
        where: { supabaseUserId: user.id },
      });

      if (!host) {
        host = await tx.host.create({
          data: {
            supabaseUserId: user.id,
            email: identifier,
            name: user.user_metadata?.full_name ?? null,
            boardCredits: SIGNUP_CREDITS,
          },
        });
      } else if (host.boardCredits === 0) {
        // Existing host that hasn't claimed an invite yet
        host = await tx.host.update({
          where: { id: host.id },
          data: { boardCredits: host.boardCredits + SIGNUP_CREDITS },
        });
      } else {
        // Host already has credits — code already claimed or duplicate attempt
        throw new Error("ALREADY_HAS_CREDITS");
      }

      // 4. Claim the invite code
      await tx.inviteCode.update({
        where: { code: trimmed },
        data: {
          claimedBy: host.id,
          claimedAt: new Date(),
        },
      });

      // 5. Log credit transaction
      await tx.creditTransaction.create({
        data: {
          hostId: host.id,
          type: "signup_grant",
          amount: SIGNUP_CREDITS,
          balanceAfter: host.boardCredits,
        },
      });

      return host;
    });

    return NextResponse.json({
      hostId: result.id,
      email: result.email,
      boardCredits: result.boardCredits,
    });
  } catch (error: any) {
    const msg = error?.message;

    if (msg === "HOST_CAP_REACHED") {
      return NextResponse.json(
        { error: "All March Madness host spots have been claimed." },
        { status: 403 }
      );
    }
    if (msg === "INVALID_CODE") {
      return NextResponse.json(
        { error: "Invalid invite code." },
        { status: 403 }
      );
    }
    if (msg === "ALREADY_CLAIMED") {
      return NextResponse.json(
        { error: "This invite code has already been used." },
        { status: 403 }
      );
    }
    if (msg === "EXPIRED") {
      return NextResponse.json(
        { error: "This invite code has expired." },
        { status: 403 }
      );
    }
    if (msg === "ALREADY_HAS_CREDITS") {
      return NextResponse.json(
        { error: "Account already has credits." },
        { status: 409 }
      );
    }

    console.error("Claim invite error:", error);
    return NextResponse.json(
      { error: "Something went wrong." },
      { status: 500 }
    );
  }
}
