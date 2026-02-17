const fs = require("fs");

const file = "src/app/api/auth/verify-otp/route.ts";
let s = fs.readFileSync(file, "utf8");

// Replace the redirect block with a JSON response
const redirectRegex =
  /return\s+NextResponse\.redirect\(\s*new\s+URL\(["']\/host\/boards["']\s*,\s*request\.url\)\s*,\s*\{\s*status:\s*303\s*,?\s*\}\s*\)\s*;\s*/m;

if (!redirectRegex.test(s)) {
  console.error("Did not find the NextResponse.redirect(...) block to replace in:", file);
  process.exit(1);
}

s = s.replace(
  redirectRegex,
  'return NextResponse.json({ ok: true, redirectTo: "/host/boards" });\n'
);

fs.writeFileSync(file, s, "utf8");
console.log("Patched:", file);
