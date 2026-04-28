// Curated list of U.S. combatant commands and adjacent unified/specified
// commands that operators may select as their command alignment. Used by the
// Profile UI as a fixed dropdown so the value is always one of a known set.
//
// The list is the 11 unified combatant commands plus an explicit
// "Other / N/A" option for users whose command isn't represented (reservists,
// service-component HQ, civilian DoD, etc.).

export interface CombatantCommandEntry {
  /** Canonical short identifier stored on the profile. */
  code: string;
  /** Full name shown next to the code in dropdowns. */
  name: string;
}

export const COMBATANT_COMMANDS: CombatantCommandEntry[] = [
  { code: "USAFRICOM", name: "U.S. Africa Command" },
  { code: "USCENTCOM", name: "U.S. Central Command" },
  { code: "USCYBERCOM", name: "U.S. Cyber Command" },
  { code: "USEUCOM", name: "U.S. European Command" },
  { code: "USINDOPACOM", name: "U.S. Indo-Pacific Command" },
  { code: "USNORTHCOM", name: "U.S. Northern Command" },
  { code: "USSOCOM", name: "U.S. Special Operations Command" },
  { code: "USSOUTHCOM", name: "U.S. Southern Command" },
  { code: "USSPACECOM", name: "U.S. Space Command" },
  { code: "USSTRATCOM", name: "U.S. Strategic Command" },
  { code: "USTRANSCOM", name: "U.S. Transportation Command" },
  { code: "OTHER", name: "Other / N/A" },
];

const VALID_CODES = new Set(COMBATANT_COMMANDS.map((c) => c.code));

/** Returns true when `code` is a recognized combatant command identifier. */
export function isValidCommandCode(code: string | null | undefined): boolean {
  if (!code) return false;
  return VALID_CODES.has(code);
}

/** Look up the full command name for a code, or null if not recognized. */
export function findCommand(
  code: string | null | undefined,
): CombatantCommandEntry | null {
  if (!code) return null;
  return COMBATANT_COMMANDS.find((c) => c.code === code) ?? null;
}
