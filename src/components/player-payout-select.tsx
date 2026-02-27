"use client";

interface PlayerPayoutSelectProps {
  hostVenmo: string | null;
  hostZelle: string | null;
  hostCashapp: string | null;
  required: boolean;
  selectedMethod: string;
  handle: string;
  onMethodChange: (method: string) => void;
  onHandleChange: (handle: string) => void;
}

export default function PlayerPayoutSelect({
  hostVenmo,
  hostZelle,
  hostCashapp,
  required,
  selectedMethod,
  handle,
  onMethodChange,
  onHandleChange,
}: PlayerPayoutSelectProps) {
  // Build options filtered to host's available methods + cash
  const options: { value: string; label: string; needsHandle: boolean }[] = [];
  if (hostVenmo) options.push({ value: "venmo", label: "Venmo", needsHandle: true });
  if (hostZelle) options.push({ value: "zelle", label: "Zelle", needsHandle: true });
  if (hostCashapp) options.push({ value: "cashapp", label: "CashApp", needsHandle: true });
  options.push({ value: "cash", label: "Cash (in person)", needsHandle: false });

  if (options.length === 1 && options[0].value === "cash") {
    // Only cash available and no host handles — don't show selector
    return null;
  }

  const selected = options.find((o) => o.value === selectedMethod);

  return (
    <div>
      <label className="block text-xs text-gray-400 mb-1">
        How should the host pay you?
        {!required && (
          <span className="text-gray-600 ml-1">(optional)</span>
        )}
      </label>
      <select
        value={selectedMethod}
        onChange={(e) => {
          onMethodChange(e.target.value);
          onHandleChange("");
        }}
        required={required}
        className="w-full rounded-lg border border-gray-700 bg-gray-800 px-3 py-2.5 text-sm text-white focus:outline-none focus:border-indigo-600 focus:ring-1 focus:ring-indigo-600"
      >
        <option value="">Select…</option>
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
      {!required && !selectedMethod && (
        <p className="text-[10px] text-gray-600 mt-1">
          Helps the host pay you faster if you win
        </p>
      )}

      {/* Handle input — only for non-cash methods */}
      {selected?.needsHandle && (
        <div className="mt-2">
          <input
            type="text"
            value={handle}
            onChange={(e) => onHandleChange(e.target.value)}
            required={required}
            placeholder={
              selectedMethod === "venmo"
                ? "@your-venmo"
                : selectedMethod === "zelle"
                  ? "email or phone"
                  : "$your-cashapp"
            }
            className="w-full rounded-lg border border-gray-700 bg-gray-800 px-3 py-2.5 text-sm text-white placeholder:text-gray-600 focus:outline-none focus:border-indigo-600 focus:ring-1 focus:ring-indigo-600"
          />
        </div>
      )}
    </div>
  );
}
