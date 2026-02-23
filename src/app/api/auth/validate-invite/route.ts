// ============================================================
// src/app/api/auth/validate-invite/route.ts
//
// Called during signup. Validates the invite code, checks host
// cap, and claims the code. Does NOT create the host — that
// happens in your existing auth/signup flow after this passes.
// ============================================================

import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { MAX_HOSTS, SIGNUP_CREDITS } from "@/lib/constants";

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const { code, email } = body;

    if (!code || !email) {
      return NextResponse.json(
        { error: "Invite code and email are required." },
        { status: 400 }
      );
    }

    const trimmedCode = code.trim().toUpperCase();

    // 1. Host cap check (belt)
    const hostCount = await prisma.host.count();
    if (hostCount >= MAX_HOSTS) {
      return NextResponse.json(
        {
          error: "All March Madness host spots have been claimed.",
          waitlist: true,
        },
        { status: 403 }
      );
    }

    // 2. Invite code validation (suspenders)
    const invite = await prisma.inviteCode.findUnique({
      where: { code: trimmedCode },
    });

    if (!invite) {
      return NextResponse.json(
        { error: "Invalid invite code." },
        { status: 403 }
      );
    }

    if (invite.claimedBy) {
      return NextResponse.json(
        { error: "This invite code has already been used." },
        { status: 403 }
      );
    }

    if (invite.expiresAt < new Date()) {
      return NextResponse.json(
        { error: "This invite code has expired." },
        { status: 403 }
      );
    }

    // 3. Check if email already has an account
    const existingHost = await prisma.host.findUnique({
      where: { email: email.toLowerCase().trim() },
    });

    if (existingHost) {
      return NextResponse.json(
        { error: "An account with this email already exists." },
        { status: 409 }
      );
    }

    // 4. Create host + claim code + log signup grant in one transaction
    const host = await prisma.$transaction(async (tx) => {
      // Create the host with default credits
      const newHost = await tx.host.create({
        data: {
          email: email.toLowerCase().trim(),
          boardCredits: SIGNUP_CREDITS,
        },
      });

      // Claim the invite code
      await tx.inviteCode.update({
        where: { code: trimmedCode },
        data: {
          claimedBy: newHost.id,
          claimedAt: new Date(),
          email: email.toLowerCase().trim(),
        },
      });

      // Log the signup grant
      await tx.creditTransaction.create({
        data: {
          hostId: newHost.id,
          type: "signup_grant",
          amount: SIGNUP_CREDITS,
          balanceAfter: SIGNUP_CREDITS,
          note: "March Madness launch grant",
        },
      });

      return newHost;
    });

    return NextResponse.json({
      hostId: host.id,
      email: host.email,
      boardCredits: host.boardCredits,
    });
  } catch (error) {
    console.error("Invite validation error:", error);
    return NextResponse.json(
      { error: "Something went wrong. Try again." },
      { status: 500 }
    );
  }
}
