#!/bin/bash
# Fix #4 — Single-name initials only show one letter
# Run from your project root

OLD='function getInitials(name: string): string {
  return name
    .split(" ")
    .map((w) => w\[0\])
    .join("")
    .toUpperCase()
    .slice(0, 2);
}'

NEW='function getInitials(name: string): string {
  const words = name.trim().split(/\\s+/);
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return words.map((w) => w[0]).join("").toUpperCase().slice(0, 2);
}'

FILES=(
  "src/app/host/boards/[id]/grid.tsx"
  "src/app/board/[slug]/player-board.tsx"
)

for FILE in "${FILES[@]}"; do
  if [ -f "$FILE" ]; then
    sed -i.bak -E '
      /function getInitials/,/^\}/ c\
function getInitials(name: string): string {\
  const words = name.trim().split(/\\s+/);\
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();\
  return words.map((w) => w[0]).join("").toUpperCase().slice(0, 2);\
}
    ' "$FILE"
    rm -f "${FILE}.bak"
    echo "✓ Fixed: $FILE"
  else
    echo "✗ Not found: $FILE"
  fi
done

echo ""
echo "Done. Verify with: grep -A4 'function getInitials' src/app/host/boards/\\[id\\]/grid.tsx src/app/board/\\[slug\\]/player-board.tsx"
