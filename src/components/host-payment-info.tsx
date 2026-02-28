"use client";

interface HostPaymentInfoProps {
  venmo: string | null;
  zelle: string | null;
  cashapp: string | null;
  visibility: "public" | "pin_gated";
  pinVerified: boolean;
}

export default function HostPaymentInfo({
  venmo,
  zelle,
  cashapp,
  visibility,
  pinVerified,
}: HostPaymentInfoProps) {
  const hasAny = venmo || zelle || cashapp;
  if (!hasAny) return null;

  if (visibility === "pin_gated" && !pinVerified) {
    return (
      <div className="rounded-lg border border-gray-800 bg-gray-900/50 p-3 mt-4 mb-4">
        <p className="text-xs text-gray-500">
          Host payment info available after PIN entry
        </p>
      </div>
    );
  }

  const methods: string[] = [];
  if (venmo) methods.push("Venmo: " + venmo);
  if (zelle) methods.push("Zelle: " + zelle);
  if (cashapp) methods.push("CashApp: " + cashapp);

  return (
    <div className="rounded-lg border border-gray-800 bg-gray-900/50 p-3 mt-4 mb-4">
      <p className="text-xs text-gray-400">
        <span className="font-bold text-gray-200">Payment:</span>{" "}
        {methods.join(" - ")}
      </p>
    </div>
  );
}