const fs = require("fs");

// === Fix 1: Add "Back to Boards" link on host board detail page ===
const detailFile = "src/app/host/boards/[id]/page.tsx";
let detail = fs.readFileSync(detailFile, "utf8");

// Add Link import
if (!detail.includes('import Link from "next/link"')) {
  detail = detail.replace(
    'import { getHost } from "@/lib/auth";',
    'import { getHost } from "@/lib/auth";\nimport Link from "next/link";'
  );
}

// Add the back link right before the board title (first h1)
const titleMarker = '<h1 className="text-xl font-bold">';
if (detail.includes(titleMarker)) {
  detail = detail.replace(
    titleMarker,
    `<Link
        href="/host/boards"
        className="text-sm text-gray-400 hover:text-white mb-4 inline-block"
      >
        ← Back to Boards
      </Link>
      <h1 className="text-xl font-bold">`
  );
  console.log("✓", detailFile, "(added Back to Boards link)");
} else {
  console.error("Could not find h1 title marker in", detailFile);
  process.exit(1);
}

fs.writeFileSync(detailFile, detail, "utf8");

// === Fix 2: Show square numbers 1-100 in host grid ===
const gridFile = "src/app/host/boards/[id]/grid.tsx";
let grid = fs.readFileSync(gridFile, "utf8");

// Replace the cell content rendering to show position number
const oldContent = `{isWinner && isPaid
                      ? "★"
                      : isPaid && sq.playerName
                        ? getInitials(sq.playerName)
                        : isPending
                          ? "…"
                          : ""}`;

const newContent = `{isWinner && isPaid
                      ? "★"
                      : isPaid && sq.playerName
                        ? getInitials(sq.playerName)
                        : isPending
                          ? "…"
                          : <span className="text-gray-700">{position + 1}</span>}`;

if (grid.includes(oldContent)) {
  grid = grid.replace(oldContent, newContent);
  console.log("✓", gridFile, "(show square numbers 1-100)");
} else {
  console.error("Could not find cell content block in", gridFile);
  process.exit(1);
}

fs.writeFileSync(gridFile, grid, "utf8");

// === Fix 3: Show square numbers 1-100 in player grid too ===
const playerFile = "src/app/board/[slug]/player-board.tsx";
let player = fs.readFileSync(playerFile, "utf8");

// The player grid has a similar pattern but with different available state
// Find the empty string for available/open squares
const oldPlayerOpen = `? "bg-gray-900 border border-gray-800 text-gray-600 hover:border-indigo-700 hover:bg-indigo-950/30 active:scale-95 cursor-pointer"`;

if (player.includes(oldPlayerOpen)) {
  // Now find the cell content — look for the open square empty render
  // Player board likely shows empty string for open squares too
  const oldPlayerContent = `: ""`;
  
  // We need to be more targeted — find the last empty string in the cell content block
  // Let's look for the pattern after the pending "…"
  const pendingPattern = '? "…"\n                          : ""';
  const pendingReplacement = '? "…"\n                          : <span className="text-gray-700">{position + 1}</span>';
  
  if (player.includes(pendingPattern)) {
    player = player.replace(pendingPattern, pendingReplacement);
    console.log("✓", playerFile, "(show square numbers 1-100)");
    fs.writeFileSync(playerFile, player, "utf8");
  } else {
    // Try alternate spacing
    const alt = /\? "…"\s*\n\s*: ""/;
    if (alt.test(player)) {
      player = player.replace(alt, '? "…"\n                          : <span className="text-gray-700">{position + 1}</span>');
      console.log("✓", playerFile, "(show square numbers 1-100)");
      fs.writeFileSync(playerFile, player, "utf8");
    } else {
      console.log("⚠ Could not patch player-board.tsx — check manually");
    }
  }
} else {
  console.log("⚠ Could not find open square class in player-board.tsx — check manually");
}

console.log("");
console.log("Done.");
console.log("git add -A && git commit -m 'fix: add back link + show square numbers 1-100' && git push origin main");
