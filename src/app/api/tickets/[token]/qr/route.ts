import QRCode from "qrcode";
import { prisma } from "@/lib/prisma";

// Ticket QR image — fundraiser-admission-addendum.md §6B.
//
// GET /api/tickets/[token]/qr  ->  image/png
//
// THE PAYLOAD IS THE OPAQUE TOKEN, NEVER A URL. A link payload means anyone
// pointing a phone camera at a ticket reaches a check-in endpoint; check-in
// must originate from the authenticated volunteer surface and nowhere else. An
// opaque token scanned by a stray camera app does nothing at all.
//
// The token appears in this route's own URL, which is unavoidable for an image
// an email client can load — data: URIs are blocked by Gmail and inline CID is
// unreliable across clients. That leaks nothing: the token is already in the
// email, and this endpoint only draws it. It performs no check-in, returns no
// supporter identity, and reveals nothing about the board.
//
// A voided pass stops rendering. `void` is terminal, so a screenshot shared
// last week must not keep producing a scannable image.

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ token: string }> }
) {
  const { token } = await params;

  if (!token || token.length < 16 || token.length > 128) {
    return new Response("Not found", { status: 404 });
  }

  const pass = await prisma.admissionPass.findUnique({
    where: { token },
    select: { status: true },
  });

  // Unknown or voided — no image. Same response for both, so this cannot be
  // used to probe which tokens exist.
  if (!pass || pass.status === "void") {
    return new Response("Not found", { status: 404 });
  }

  const png = await QRCode.toBuffer(token, {
    type: "png",
    width: 320,
    margin: 1,
    errorCorrectionLevel: "M",
    color: { dark: "#000000", light: "#ffffff" },
  });

  return new Response(new Uint8Array(png), {
    headers: {
      "Content-Type": "image/png",
      // Immutable for a token that never changes meaning, but private: an
      // email proxy may cache it, a shared CDN should not.
      "Cache-Control": "private, max-age=86400",
      "Content-Disposition": "inline",
    },
  });
}
