// POST /api/host/merch/upload — item photo to the public-read `merch-images`
// bucket. Server-side upload only (same pattern as the hbcu-logos upload).

import { NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { createClient as createAdmin } from "@supabase/supabase-js";
import { merchOwnerId } from "@/domain/merch/host-auth";
import { merchSalesOpen } from "@/domain/merch/runtime";
import { notFound } from "@/domain/merch/http";

export const runtime = "nodejs";

const TYPES: Record<string, string> = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" };
const MAX_BYTES = 5 * 1024 * 1024;

export async function POST(req: Request) {
  if (!merchSalesOpen()) return notFound();
  const owner = await merchOwnerId();
  if (!owner) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const form = await req.formData().catch(() => null);
  const file = form?.get("file");
  if (!(file instanceof File)) return NextResponse.json({ error: "Choose a photo." }, { status: 400 });
  const ext = TYPES[file.type];
  if (!ext) return NextResponse.json({ error: "Use a JPG, PNG or WebP photo." }, { status: 400 });
  if (file.size > MAX_BYTES) return NextResponse.json({ error: "Photos must be 5 MB or smaller." }, { status: 400 });

  const admin = createAdmin(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
  const path = `${owner}/${randomUUID()}.${ext}`;
  const { error } = await admin.storage.from("merch-images").upload(path, Buffer.from(await file.arrayBuffer()), {
    contentType: file.type,
    upsert: false,
  });
  if (error) {
    console.error("merch image upload:", error.message);
    return NextResponse.json({ error: "Upload failed. Try again." }, { status: 502 });
  }
  const { data } = admin.storage.from("merch-images").getPublicUrl(path);
  return NextResponse.json({ url: data.publicUrl });
}
