const fs = require("fs");
const file = "src/app/host/boards/new/form.tsx";
let s = fs.readFileSync(file, "utf8");

const old = `const data = await res.json();

      if (!res.ok) {
        // If there's already a pending board, redirect to dashboard
        if (res.status === 409 && data.pendingBoardId) {
          router.push("/host/boards");
          return;
        }
        setError(data.error || "Something went wrong");
        setLoading(false);
        return;
      }`;

const replacement = `const data = await res.json();

      // Pending board created — redirect to dashboard to complete payment
      if (res.status === 402 && data.boardId) {
        router.push("/host/boards");
        return;
      }

      // Already have a pending board — redirect to dashboard
      if (res.status === 409 && data.pendingBoardId) {
        router.push("/host/boards");
        return;
      }

      if (!res.ok) {
        setError(data.error || "Something went wrong");
        setLoading(false);
        return;
      }`;

if (s.indexOf(old) === -1) {
  console.error("Could not find the block to replace in", file);
  process.exit(1);
}

s = s.replace(old, replacement);
fs.writeFileSync(file, s, "utf8");
console.log("✓ Fixed 402 handling —", file);
