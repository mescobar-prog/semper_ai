// Canonical branch identifiers used throughout the app. The string label is
// what we store in the profiles.branch column today, so that's the canonical
// key. The short code is what we embed in `auto_source` strings (e.g.
// "mos:army:11B") to keep them short and stable.

export interface Branch {
  /** Canonical label stored in profiles.branch. */
  label: string;
  /** Lowercase, slash-free short code used in auto_source identifiers. */
  code: "army" | "navy" | "marines" | "air_force" | "space_force" | "coast_guard";
}

export const BRANCHES: Branch[] = [
  { label: "Army", code: "army" },
  { label: "Navy", code: "navy" },
  { label: "Marine Corps", code: "marines" },
  { label: "Air Force", code: "air_force" },
  { label: "Space Force", code: "space_force" },
  { label: "Coast Guard", code: "coast_guard" },
];

const BY_LABEL = new Map(BRANCHES.map((b) => [b.label, b]));
const BY_CODE = new Map(BRANCHES.map((b) => [b.code, b]));

/** Resolve either the human label ("Army") or short code ("army") to a Branch. */
export function resolveBranch(value: string | null | undefined): Branch | null {
  if (!value) return null;
  return BY_LABEL.get(value) ?? BY_CODE.get(value as Branch["code"]) ?? null;
}

export function branchCode(value: string | null | undefined): Branch["code"] | null {
  return resolveBranch(value)?.code ?? null;
}
