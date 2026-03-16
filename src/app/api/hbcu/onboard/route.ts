// src/app/api/hbcu/onboard/route.ts
// ============================================================
// Handles HBCU org onboarding form submissions.
// - Uploads logo to Supabase Storage (if provided)
// - Inserts org record into hbcu_orgs table
// - Sends notification email to info@daali.app via Resend
// ============================================================

import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { Resend } from "resend";

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

const resend = new Resend(process.env.RESEND_API_KEY);

export async function POST(req: NextRequest) {
  try {
    const formData = await req.formData();

    const orgName      = formData.get("orgName") as string;
    const school       = formData.get("school") as string;
    const city         = formData.get("city") as string;
    const fundPurpose  = formData.get("fundPurpose") as string | null;
    const contactName  = formData.get("contactName") as string;
    const contactEmail = formData.get("contactEmail") as string;
    const logoFile     = formData.get("logo") as File | null;

    // Validate required fields
    if (!orgName || !school || !city || !contactName || !contactEmail) {
      return NextResponse.json(
        { error: "Missing required fields" },
        { status: 400 }
      );
    }

    // Upload logo if provided
    let logoUrl: string | null = null;
    if (logoFile && logoFile.size > 0) {
      const ext = logoFile.name.split(".").pop();
      const fileName = `${Date.now()}-${orgName.replace(/\s+/g, "-").toLowerCase()}.${ext}`;
      const arrayBuffer = await logoFile.arrayBuffer();
      const buffer = Buffer.from(arrayBuffer);

      const { error: uploadError } = await supabase.storage
        .from("hbcu-logos")
        .upload(fileName, buffer, {
          contentType: logoFile.type,
          upsert: false,
        });

      if (uploadError) {
        console.error("Logo upload error:", uploadError.message);
        // Non-fatal — continue without logo
      } else {
        const { data: urlData } = supabase.storage
          .from("hbcu-logos")
          .getPublicUrl(fileName);
        logoUrl = urlData.publicUrl;
      }
    }

    // Insert into hbcu_orgs table
    const { error: insertError } = await supabase
      .from("hbcu_orgs")
      .insert({
        org_name:      orgName,
        school,
        city,
        fund_purpose:  fundPurpose || null,
        contact_name:  contactName,
        contact_email: contactEmail,
        logo_url:      logoUrl,
        status:        "pending",
      });

    if (insertError) {
      console.error("Insert error:", insertError.message);
      return NextResponse.json(
        { error: "Failed to save organization" },
        { status: 500 }
      );
    }

    // Send notification email to info@daali.app
    try {
      await resend.emails.send({
        from: "Daali <notifications@daali.app>",
        to: "info@daali.app",
        subject: `New HBCU Org Signup: ${orgName}`,
        html: `
          <div style="font-family:sans-serif;max-width:600px;margin:0 auto;padding:32px;background:#0a0a0f;color:#e8e8ef;border-radius:8px;">
            <h2 style="color:#4ade80;font-size:20px;margin-bottom:24px;">New Organization Submitted</h2>
            <table style="width:100%;border-collapse:collapse;">
              <tr>
                <td style="padding:10px 0;color:#6b6b80;font-size:13px;width:40%;">Organization</td>
                <td style="padding:10px 0;font-size:14px;">${orgName}</td>
              </tr>
              <tr>
                <td style="padding:10px 0;color:#6b6b80;font-size:13px;">School</td>
                <td style="padding:10px 0;font-size:14px;">${school}</td>
              </tr>
              <tr>
                <td style="padding:10px 0;color:#6b6b80;font-size:13px;">City</td>
                <td style="padding:10px 0;font-size:14px;">${city}</td>
              </tr>
              <tr>
                <td style="padding:10px 0;color:#6b6b80;font-size:13px;">Contact</td>
                <td style="padding:10px 0;font-size:14px;">${contactName}</td>
              </tr>
              <tr>
                <td style="padding:10px 0;color:#6b6b80;font-size:13px;">Email</td>
                <td style="padding:10px 0;font-size:14px;"><a href="mailto:${contactEmail}" style="color:#4ade80;">${contactEmail}</a></td>
              </tr>
              ${fundPurpose ? `
              <tr>
                <td style="padding:10px 0;color:#6b6b80;font-size:13px;">Fund Purpose</td>
                <td style="padding:10px 0;font-size:14px;">${fundPurpose}</td>
              </tr>` : ""}
              ${logoUrl ? `
              <tr>
                <td style="padding:10px 0;color:#6b6b80;font-size:13px;">Logo</td>
                <td style="padding:10px 0;font-size:14px;"><a href="${logoUrl}" style="color:#4ade80;">View uploaded logo</a></td>
              </tr>` : ""}
            </table>
            <div style="margin-top:32px;padding-top:24px;border-top:1px solid #1e1e2a;font-size:12px;color:#6b6b80;">
              Reply directly to <a href="mailto:${contactEmail}" style="color:#4ade80;">${contactEmail}</a> to follow up.
            </div>
          </div>
        `,
      });
    } catch (emailError) {
      // Non-fatal — org is saved even if email fails
      console.error("Notification email failed:", emailError);
    }

    return NextResponse.json({ success: true }, { status: 200 });

  } catch (err) {
    console.error("HBCU onboard error:", err);
    return NextResponse.json(
      { error: "Something went wrong" },
      { status: 500 }
    );
  }
}
