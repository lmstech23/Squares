const fs = require("fs");

const file = "src/app/login/page.tsx";
let s = fs.readFileSync(file, "utf8");

const start = s.indexOf("async function handleVerifyCode");
if (start === -1) {
  console.error("Could not find handleVerifyCode in", file);
  process.exit(1);
}

// Find the end of the function by counting braces
const braceStart = s.indexOf("{", start);
let i = braceStart;
let depth = 0;
for (; i < s.length; i++) {
  const ch = s[i];
  if (ch === "{") depth++;
  else if (ch === "}") {
    depth--;
    if (depth === 0) {
      i++; // include closing brace
      break;
    }
  }
}
const end = i;

const replacement =
`async function handleVerifyCode(e: React.FormEvent) {
  e.preventDefault();
  setError(null);
  setLoading(true);

  try {
    const body =
      method === "phone"
        ? { phone: formatPhone(phone), token, type: "sms" }
        : { email, token, type: "email" };

    const res = await fetch("/api/auth/verify-otp", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      redirect: "follow",
    });

    // If server redirected, follow it
    if (res.redirected) {
      window.location.href = res.url;
      return;
    }

    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      setError((data as any).error || "Verification failed");
      return;
    }

    // Fallback
    window.location.href = "/host/boards";
  } catch {
    setError("Verification failed. Try again.");
  } finally {
    setLoading(false);
  }
}`;

s = s.slice(0, start) + replacement + s.slice(end);
fs.writeFileSync(file, s, "utf8");
console.log("Patched:", file);
