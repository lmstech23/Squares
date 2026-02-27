// ============================================================
// Player "Save my info" — localStorage only
// Saves: name, email, phone
// Does NOT save: payout preference (varies per board)
// Reference: payout-coordination-memo.docx §2D
// ============================================================

const STORAGE_KEY = "squares_player_info";

interface SavedPlayerInfo {
  name: string;
  email: string;
  phone: string;
}

export function loadPlayerInfo(): SavedPlayerInfo | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (parsed.name && (parsed.email || parsed.phone)) {
      return {
        name: parsed.name || "",
        email: parsed.email || "",
        phone: parsed.phone || "",
      };
    }
    return null;
  } catch {
    return null;
  }
}

export function savePlayerInfo(info: SavedPlayerInfo): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(info));
  } catch {
    // localStorage not available — silently ignore
  }
}

export function clearPlayerInfo(): void {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    // ignore
  }
}
