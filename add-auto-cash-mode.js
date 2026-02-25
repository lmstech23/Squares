const fs = require("fs");
const file = "src/app/api/boards/route.ts";
let code = fs.readFileSync(file, "utf8");
const before = code;

// 1. Add crypto import if not present
if (!code.includes("require('crypto')") && !code.includes('require("crypto")') && !code.includes("from 'crypto'") && !code.includes('from "crypto"')) {
  const firstImport = code.indexOf("import ");
  if (firstImport !== -1) {
    code = code.slice(0, firstImport) + 'import { randomInt } from "crypto";\n' + code.slice(firstImport);
    console.log("  + Added crypto import");
  } else {
    code = 'import { randomInt } from "crypto";\n' + code;
    console.log("  + Added crypto import at top");
  }
}

// 2. Ensure paymentPreference is available on the host object
if (!code.includes("paymentPreference")) {
  // Strategy: find any select block in the host query and add the field
  const selectMatch = code.match(/select:\s*\{[^}]*boardCredits:\s*true[^}]*\}/);
  if (selectMatch) {
    const original = selectMatch[0];
    const updated = original.replace(
      "boardCredits: true",
      "boardCredits: true,\n        paymentPreference: true"
    );
    code = code.replace(original, updated);
    console.log("  + Added paymentPreference to host select block");
  } else {
    const anySelectMatch = code.match(/select:\s*\{[^}]*stripeAccountId:\s*true[^}]*\}/);
    if (anySelectMatch) {
      const original = anySelectMatch[0];
      const updated = original.replace(
        "stripeAccountId: true",
        "stripeAccountId: true,\n        paymentPreference: true"
      );
      code = code.replace(original, updated);
      console.log("  + Added paymentPreference to host select block (via stripeAccountId)");
    } else {
      console.log("  ~ No select block found — host object likely returns all fields (OK)");
    }
  }
}

// 3. Add the auto cash mode logic right before tx.board.create
const cashModeBlock = `
      // --- Auto-enable cash mode for cash-only hosts ---
      const isCashHost = host.paymentPreference === "cash";
      const cashPin = isCashHost
        ? String(randomInt(1000, 10000))
        : null;
`;

if (code.includes("const newBoard = await tx.board.create")) {
  code = code.replace(
    "const newBoard = await tx.board.create",
    cashModeBlock + "\n      const newBoard = await tx.board.create"
  );
  console.log("  + Added cash mode PIN generation block (before newBoard)");
} else if (code.includes("const board = await tx.board.create")) {
  code = code.replace(
    "const board = await tx.board.create",
    cashModeBlock + "\n      const board = await tx.board.create"
  );
  console.log("  + Added cash mode PIN generation block (before board)");
} else {
  console.error("ERROR: Could not find tx.board.create call");
  process.exit(1);
}

// 4. Add cash fields to board.create data
if (code.includes("hostPayoutResponsible: true,")) {
  code = code.replace(
    "hostPayoutResponsible: true,",
    `hostPayoutResponsible: true,
          ...(isCashHost && {
            cashModeEnabled: true,
            cashPin: cashPin,
            cashLiabilityAccepted: true,
          }),`
  );
  console.log("  + Added cash mode fields to board.create data");
} else {
  console.error("ERROR: Could not find hostPayoutResponsible in board.create data");
  process.exit(1);
}

if (before === code) {
  console.error("ERROR: No changes made");
  process.exit(1);
}

fs.writeFileSync(file, code);
console.log("\nDone!");
console.log("- Cash hosts: boards created with cashModeEnabled + crypto PIN (1000-9999)");
console.log("- Card hosts: unchanged");
console.log("- Hosts can still toggle cash mode on/off from dashboard anytime");
