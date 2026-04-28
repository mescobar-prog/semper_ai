export * from "./branches";
export * from "./mos";
export * from "./units";
export * from "./doctrine";

import type { Branch } from "./branches";

/**
 * Build the canonical `auto_source` identifier stored on documents. Format:
 *   mos:<branchCode>:<mosCode>     e.g. "mos:army:11B"
 *   unit:<branchCode>:<unitId>     e.g. "unit:marines:MALS-12"
 * The strings are stable and case-sensitive — they are used for de-dup.
 */
export function buildMosAutoSource(
  branchCode: Branch["code"],
  mosCode: string,
): string {
  return `mos:${branchCode}:${mosCode}`;
}

export function buildUnitAutoSource(
  branchCode: Branch["code"],
  unit: string,
): string {
  return `unit:${branchCode}:${unit}`;
}

export interface ParsedAutoSource {
  kind: "mos" | "unit";
  branchCode: Branch["code"];
  identifier: string;
}

export function parseAutoSource(value: string): ParsedAutoSource | null {
  const parts = value.split(":");
  if (parts.length < 3) return null;
  const kind = parts[0];
  if (kind !== "mos" && kind !== "unit") return null;
  const branchCode = parts[1] as Branch["code"];
  const identifier = parts.slice(2).join(":");
  if (!branchCode || !identifier) return null;
  return { kind, branchCode, identifier };
}
