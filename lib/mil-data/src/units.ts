// Curated, best-effort per-branch lists of common units users are likely to
// type. The Profile UI uses this purely to suggest typeahead matches. The
// backend always accepts free-text unit values too — these lists are not
// authoritative or exhaustive.

import type { Branch } from "./branches";

export interface UnitEntry {
  /** Identifier as a user would type it. */
  identifier: string;
  /** Human-readable name (often the same as the identifier). */
  name: string;
  /** Optional parent organization (e.g. "101st Airborne Division"). */
  parent?: string;
}

const ARMY_UNITS: UnitEntry[] = [
  { identifier: "1st Cavalry Division", name: "1st Cavalry Division", parent: "III Corps" },
  { identifier: "1st Armored Division", name: "1st Armored Division", parent: "III Corps" },
  { identifier: "1st Infantry Division", name: "1st Infantry Division", parent: "III Corps" },
  { identifier: "3rd Infantry Division", name: "3rd Infantry Division", parent: "XVIII Airborne Corps" },
  { identifier: "4th Infantry Division", name: "4th Infantry Division", parent: "III Corps" },
  { identifier: "10th Mountain Division", name: "10th Mountain Division", parent: "XVIII Airborne Corps" },
  { identifier: "25th Infantry Division", name: "25th Infantry Division" },
  { identifier: "82nd Airborne Division", name: "82nd Airborne Division", parent: "XVIII Airborne Corps" },
  { identifier: "101st Airborne Division", name: "101st Airborne Division (Air Assault)", parent: "XVIII Airborne Corps" },
  { identifier: "1st BCT, 101st ABN", name: "1st Brigade Combat Team, 101st Airborne", parent: "101st Airborne Division" },
  { identifier: "2nd BCT, 101st ABN", name: "2nd Brigade Combat Team, 101st Airborne", parent: "101st Airborne Division" },
  { identifier: "3-187 IN", name: "3rd Battalion, 187th Infantry Regiment", parent: "3rd BCT, 101st Airborne" },
  { identifier: "1-327 IN", name: "1st Battalion, 327th Infantry Regiment", parent: "1st BCT, 101st Airborne" },
  { identifier: "2-502 IN", name: "2nd Battalion, 502nd Infantry Regiment", parent: "2nd BCT, 101st Airborne" },
  { identifier: "1st SFG (A)", name: "1st Special Forces Group (Airborne)" },
  { identifier: "5th SFG (A)", name: "5th Special Forces Group (Airborne)" },
  { identifier: "75th Ranger Regiment", name: "75th Ranger Regiment" },
  { identifier: "160th SOAR", name: "160th Special Operations Aviation Regiment" },
  { identifier: "USASOC", name: "U.S. Army Special Operations Command" },
  { identifier: "USACAPOC", name: "U.S. Army Civil Affairs and Psychological Operations Command" },
  { identifier: "INSCOM", name: "U.S. Army Intelligence and Security Command" },
  { identifier: "FORSCOM", name: "U.S. Army Forces Command" },
];

const NAVY_UNITS: UnitEntry[] = [
  { identifier: "USS Gerald R. Ford (CVN-78)", name: "USS Gerald R. Ford" },
  { identifier: "USS Nimitz (CVN-68)", name: "USS Nimitz" },
  { identifier: "USS George Washington (CVN-73)", name: "USS George Washington" },
  { identifier: "USS Ronald Reagan (CVN-76)", name: "USS Ronald Reagan" },
  { identifier: "USS Bataan (LHD-5)", name: "USS Bataan" },
  { identifier: "USS Wasp (LHD-1)", name: "USS Wasp" },
  { identifier: "USS Iwo Jima (LHD-7)", name: "USS Iwo Jima" },
  { identifier: "USS Zumwalt (DDG-1000)", name: "USS Zumwalt" },
  { identifier: "USS Arleigh Burke (DDG-51)", name: "USS Arleigh Burke" },
  { identifier: "USS Virginia (SSN-774)", name: "USS Virginia" },
  { identifier: "Naval Special Warfare Group 1", name: "Naval Special Warfare Group 1 (NSWG-1)" },
  { identifier: "Naval Special Warfare Group 2", name: "Naval Special Warfare Group 2 (NSWG-2)" },
  { identifier: "SEAL Team 1", name: "SEAL Team 1", parent: "NSWG-1" },
  { identifier: "SEAL Team 3", name: "SEAL Team 3", parent: "NSWG-1" },
  { identifier: "SEAL Team 5", name: "SEAL Team 5", parent: "NSWG-1" },
  { identifier: "SEAL Team 7", name: "SEAL Team 7", parent: "NSWG-1" },
  { identifier: "VFA-31", name: "Strike Fighter Squadron 31 (Tomcatters)" },
  { identifier: "VFA-86", name: "Strike Fighter Squadron 86 (Sidewinders)" },
  { identifier: "VFA-87", name: "Strike Fighter Squadron 87 (Golden Warriors)" },
  { identifier: "HSC-3", name: "Helicopter Sea Combat Squadron 3 (Merlins)" },
  { identifier: "EODMU-1", name: "Explosive Ordnance Disposal Mobile Unit 1" },
  { identifier: "Naval Information Forces", name: "Naval Information Forces (NIFC)" },
];

const USMC_UNITS: UnitEntry[] = [
  { identifier: "1st MARDIV", name: "1st Marine Division", parent: "I MEF" },
  { identifier: "2d MARDIV", name: "2d Marine Division", parent: "II MEF" },
  { identifier: "3d MARDIV", name: "3d Marine Division", parent: "III MEF" },
  { identifier: "1st MAW", name: "1st Marine Aircraft Wing", parent: "III MEF" },
  { identifier: "2d MAW", name: "2d Marine Aircraft Wing", parent: "II MEF" },
  { identifier: "3d MAW", name: "3d Marine Aircraft Wing", parent: "I MEF" },
  { identifier: "1st MLG", name: "1st Marine Logistics Group", parent: "I MEF" },
  { identifier: "2d MLG", name: "2d Marine Logistics Group", parent: "II MEF" },
  { identifier: "3d MLG", name: "3d Marine Logistics Group", parent: "III MEF" },
  { identifier: "MAG-11", name: "Marine Aircraft Group 11", parent: "3d MAW" },
  { identifier: "MAG-12", name: "Marine Aircraft Group 12", parent: "1st MAW" },
  { identifier: "MAG-13", name: "Marine Aircraft Group 13", parent: "3d MAW" },
  { identifier: "MAG-14", name: "Marine Aircraft Group 14", parent: "2d MAW" },
  { identifier: "MAG-16", name: "Marine Aircraft Group 16", parent: "3d MAW" },
  { identifier: "MAG-24", name: "Marine Aircraft Group 24", parent: "1st MAW" },
  { identifier: "MAG-26", name: "Marine Aircraft Group 26", parent: "2d MAW" },
  { identifier: "MAG-29", name: "Marine Aircraft Group 29", parent: "2d MAW" },
  { identifier: "MAG-31", name: "Marine Aircraft Group 31", parent: "2d MAW" },
  { identifier: "MAG-39", name: "Marine Aircraft Group 39", parent: "3d MAW" },
  { identifier: "MALS-12", name: "Marine Aviation Logistics Squadron 12", parent: "MAG-12" },
  { identifier: "MALS-31", name: "Marine Aviation Logistics Squadron 31", parent: "MAG-31" },
  { identifier: "MALS-39", name: "Marine Aviation Logistics Squadron 39", parent: "MAG-39" },
  { identifier: "VMFA-122", name: "Marine Fighter Attack Squadron 122", parent: "MAG-31" },
  { identifier: "VMFA-251", name: "Marine Fighter Attack Squadron 251", parent: "MAG-31" },
  { identifier: "VMFA-312", name: "Marine Fighter Attack Squadron 312", parent: "MAG-31" },
  { identifier: "1st Marines", name: "1st Marine Regiment", parent: "1st MARDIV" },
  { identifier: "5th Marines", name: "5th Marine Regiment", parent: "1st MARDIV" },
  { identifier: "7th Marines", name: "7th Marine Regiment", parent: "1st MARDIV" },
  { identifier: "MARSOC", name: "Marine Forces Special Operations Command" },
];

const AIR_FORCE_UNITS: UnitEntry[] = [
  { identifier: "1st Fighter Wing", name: "1st Fighter Wing", parent: "Air Combat Command" },
  { identifier: "4th Fighter Wing", name: "4th Fighter Wing" },
  { identifier: "20th Fighter Wing", name: "20th Fighter Wing" },
  { identifier: "23d Wing", name: "23d Wing (A-10s)" },
  { identifier: "33d Fighter Wing", name: "33d Fighter Wing (F-35A)" },
  { identifier: "53d Wing", name: "53d Wing (Test & Evaluation)" },
  { identifier: "60th Air Mobility Wing", name: "60th Air Mobility Wing" },
  { identifier: "62d Airlift Wing", name: "62d Airlift Wing" },
  { identifier: "92d Air Refueling Wing", name: "92d Air Refueling Wing" },
  { identifier: "97th Air Mobility Wing", name: "97th Air Mobility Wing" },
  { identifier: "375th Air Mobility Wing", name: "375th Air Mobility Wing" },
  { identifier: "388th Fighter Wing", name: "388th Fighter Wing (F-35A)" },
  { identifier: "509th Bomb Wing", name: "509th Bomb Wing (B-2)" },
  { identifier: "2d Bomb Wing", name: "2d Bomb Wing (B-52H)" },
  { identifier: "7th Bomb Wing", name: "7th Bomb Wing (B-1)" },
  { identifier: "24th Special Operations Wing", name: "24th Special Operations Wing", parent: "AFSOC" },
  { identifier: "27th Special Operations Wing", name: "27th Special Operations Wing", parent: "AFSOC" },
  { identifier: "AFSOC", name: "Air Force Special Operations Command" },
  { identifier: "ACC", name: "Air Combat Command" },
  { identifier: "AMC", name: "Air Mobility Command" },
  { identifier: "AETC", name: "Air Education and Training Command" },
  { identifier: "AFGSC", name: "Air Force Global Strike Command" },
];

const SPACE_FORCE_UNITS: UnitEntry[] = [
  { identifier: "Space Operations Command", name: "Space Operations Command (SpOC)" },
  { identifier: "Space Systems Command", name: "Space Systems Command (SSC)" },
  { identifier: "Space Training and Readiness Command", name: "Space Training and Readiness Command (STARCOM)" },
  { identifier: "Space Delta 2", name: "Space Delta 2 — Space Domain Awareness", parent: "SpOC" },
  { identifier: "Space Delta 3", name: "Space Delta 3 — Space Electromagnetic Warfare", parent: "SpOC" },
  { identifier: "Space Delta 4", name: "Space Delta 4 — Missile Warning", parent: "SpOC" },
  { identifier: "Space Delta 5", name: "Space Delta 5 — Combined Space Operations Center", parent: "SpOC" },
  { identifier: "Space Delta 6", name: "Space Delta 6 — Cyberspace Operations", parent: "SpOC" },
  { identifier: "Space Delta 7", name: "Space Delta 7 — Intelligence, Surveillance, Reconnaissance", parent: "SpOC" },
  { identifier: "Space Delta 8", name: "Space Delta 8 — Satellite Communications & Navigation Warfare", parent: "SpOC" },
  { identifier: "Space Delta 9", name: "Space Delta 9 — Orbital Warfare", parent: "SpOC" },
];

const COAST_GUARD_UNITS: UnitEntry[] = [
  { identifier: "Atlantic Area", name: "Coast Guard Atlantic Area (LANTAREA)" },
  { identifier: "Pacific Area", name: "Coast Guard Pacific Area (PACAREA)" },
  { identifier: "District 1", name: "First Coast Guard District", parent: "LANTAREA" },
  { identifier: "District 5", name: "Fifth Coast Guard District", parent: "LANTAREA" },
  { identifier: "District 7", name: "Seventh Coast Guard District", parent: "LANTAREA" },
  { identifier: "District 8", name: "Eighth Coast Guard District", parent: "LANTAREA" },
  { identifier: "District 9", name: "Ninth Coast Guard District", parent: "LANTAREA" },
  { identifier: "District 11", name: "Eleventh Coast Guard District", parent: "PACAREA" },
  { identifier: "District 13", name: "Thirteenth Coast Guard District", parent: "PACAREA" },
  { identifier: "District 14", name: "Fourteenth Coast Guard District", parent: "PACAREA" },
  { identifier: "District 17", name: "Seventeenth Coast Guard District", parent: "PACAREA" },
  { identifier: "USCGC Hamilton (WMSL-753)", name: "USCGC Hamilton" },
  { identifier: "USCGC Stratton (WMSL-752)", name: "USCGC Stratton" },
  { identifier: "USCGC Healy (WAGB-20)", name: "USCGC Healy" },
  { identifier: "USCGC Polar Star (WAGB-10)", name: "USCGC Polar Star" },
  { identifier: "MSST", name: "Maritime Safety and Security Team" },
  { identifier: "MSRT", name: "Maritime Security Response Team" },
  { identifier: "Coast Guard Cyber Command", name: "Coast Guard Cyber Command" },
];

const UNITS_BY_BRANCH: Record<Branch["code"], UnitEntry[]> = {
  army: ARMY_UNITS,
  navy: NAVY_UNITS,
  marines: USMC_UNITS,
  air_force: AIR_FORCE_UNITS,
  space_force: SPACE_FORCE_UNITS,
  coast_guard: COAST_GUARD_UNITS,
};

export function listUnitsForBranch(code: Branch["code"] | null): UnitEntry[] {
  if (!code) return [];
  return UNITS_BY_BRANCH[code] ?? [];
}

export function findUnitEntry(
  code: Branch["code"] | null,
  identifier: string | null | undefined,
): UnitEntry | null {
  if (!code || !identifier) return null;
  const norm = identifier.trim().toLowerCase();
  return (
    UNITS_BY_BRANCH[code]?.find(
      (u) => u.identifier.toLowerCase() === norm,
    ) ?? null
  );
}
