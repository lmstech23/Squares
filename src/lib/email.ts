// src/lib/email.ts
// ============================================================
// Email utility — fire-and-forget wrapper around Resend.
//
// All callers wrap this in try/catch. A send failure must never
// crash a payment flow or return 500 to the client.
// ============================================================
import { Resend } from "resend";

export async function sendEmail(
  to: string,
  subject: string,
  html: string
): Promise<void> {
  if (!process.env.RESEND_API_KEY) {
    throw new Error("RESEND_API_KEY is not configured");
  }
  const resend = new Resend(process.env.RESEND_API_KEY);
  const { error } = await resend.emails.send({
    from: "Daali Boards <notifications@daali.app>",
    to,
    subject,
    html,
  });
  if (error) {
    throw new Error(`Resend error: ${error.message}`);
  }
}