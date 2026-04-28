// Curated doctrine map: (branch, mosCode) → array of public doctrine docs
// to auto-ingest into the user's library.
//
// Each entry points at a publicly reachable URL. We deliberately keep the
// set small (foundational + functional-area doctrine) so the library doesn't
// balloon. Where MOS-specific doctrine is thin we fall back to the branch's
// foundational publications.
//
// Sources are public DoW doctrine portals (armypubs.army.mil, marines.mil,
// doctrine.af.mil, navy.mil, etc.). If a URL goes 404 or stale, the rest of
// the package still ingests; the failure is recorded per-doc.

import type { Branch } from "./branches";

export interface DoctrineEntry {
  /** Display title used as the library document title. */
  title: string;
  /** Publicly reachable URL the server downloads. */
  url: string;
  /** Best-guess MIME type. The extractor still re-detects per-byte. */
  mimeTypeHint: string;
}

// ---------- Branch-foundational packages -----------------------------------

const ARMY_FOUNDATIONAL: DoctrineEntry[] = [
  {
    title: "ADP 1 — The Army",
    url: "https://armypubs.army.mil/epubs/DR_pubs/DR_a/ARN30966-ADP_1-000-WEB-1.pdf",
    mimeTypeHint: "application/pdf",
  },
  {
    title: "ADP 3-0 — Operations",
    url: "https://armypubs.army.mil/epubs/DR_pubs/DR_a/ARN36290-ADP_3-0-000-WEB-1.pdf",
    mimeTypeHint: "application/pdf",
  },
  {
    title: "ADP 6-0 — Mission Command",
    url: "https://armypubs.army.mil/epubs/DR_pubs/DR_a/ARN34403-ADP_6-0-000-WEB-3.pdf",
    mimeTypeHint: "application/pdf",
  },
];

const NAVY_FOUNDATIONAL: DoctrineEntry[] = [
  {
    title: "NDP 1 — Naval Warfare",
    url: "https://www.navy.mil/Portals/1/Documents/NDP1_Naval_Warfare.pdf",
    mimeTypeHint: "application/pdf",
  },
  {
    title: "NWP 3-32 — Maritime Operations at the Operational Level of War",
    url: "https://www.public.navy.mil/usff/Documents/NWP_3-32.pdf",
    mimeTypeHint: "application/pdf",
  },
];

const USMC_FOUNDATIONAL: DoctrineEntry[] = [
  {
    title: "MCDP 1 — Warfighting",
    url: "https://www.marines.mil/Portals/1/Publications/MCDP%201%20Warfighting.pdf",
    mimeTypeHint: "application/pdf",
  },
  {
    title: "MCDP 1-0 — Marine Corps Operations",
    url: "https://www.marines.mil/Portals/1/Publications/MCDP%201-0.pdf",
    mimeTypeHint: "application/pdf",
  },
  {
    title: "MCDP 6 — Command and Control",
    url: "https://www.marines.mil/Portals/1/Publications/MCDP%206%20Command%20and%20Control.pdf",
    mimeTypeHint: "application/pdf",
  },
];

const AIR_FORCE_FOUNDATIONAL: DoctrineEntry[] = [
  {
    title: "AFDP 1 — The Air Force",
    url: "https://www.doctrine.af.mil/Portals/61/documents/AFDP_1/AFDP-1.pdf",
    mimeTypeHint: "application/pdf",
  },
  {
    title: "AFDP 3-0 — Operations and Planning",
    url: "https://www.doctrine.af.mil/Portals/61/documents/AFDP_3-0/3-0-AFDP-OPERATIONS-PLANNING.pdf",
    mimeTypeHint: "application/pdf",
  },
];

const SPACE_FORCE_FOUNDATIONAL: DoctrineEntry[] = [
  {
    title: "Spacepower — Doctrine for Space Forces (SDP-1)",
    url: "https://www.spaceforce.mil/Portals/2/Space%20Capstone%20Publication_10%20Aug%202020.pdf",
    mimeTypeHint: "application/pdf",
  },
];

const COAST_GUARD_FOUNDATIONAL: DoctrineEntry[] = [
  {
    title: "Pub 1 — Doctrine for the U.S. Coast Guard",
    url: "https://www.dcms.uscg.mil/Portals/10/CG-5R/Publication%201/Pub1_2014.pdf",
    mimeTypeHint: "application/pdf",
  },
];

const FOUNDATIONAL_BY_BRANCH: Record<Branch["code"], DoctrineEntry[]> = {
  army: ARMY_FOUNDATIONAL,
  navy: NAVY_FOUNDATIONAL,
  marines: USMC_FOUNDATIONAL,
  air_force: AIR_FORCE_FOUNDATIONAL,
  space_force: SPACE_FORCE_FOUNDATIONAL,
  coast_guard: COAST_GUARD_FOUNDATIONAL,
};

// ---------- MOS-specific add-ons -------------------------------------------
//
// Keys are `${branchCode}:${mosCode}`. Values are the *additional* docs to
// pull on top of the branch foundational package. Where we don't have a good
// MOS-specific pub, the user still gets the branch foundational set.

const MOS_SPECIFIC: Record<string, DoctrineEntry[]> = {
  // ----- Army -----
  "army:11B": [
    {
      title: "FM 3-21.8 — The Infantry Rifle Platoon and Squad",
      url: "https://armypubs.army.mil/epubs/DR_pubs/DR_a/pdf/web/fm3_21x8.pdf",
      mimeTypeHint: "application/pdf",
    },
    {
      title: "ATP 3-21.8 — Infantry Platoon and Squad",
      url: "https://armypubs.army.mil/epubs/DR_pubs/DR_a/ARN31506-ATP_3-21.8-000-WEB-1.pdf",
      mimeTypeHint: "application/pdf",
    },
  ],
  "army:11C": [
    {
      title: "ATP 3-21.90 — Tactical Employment of Mortars",
      url: "https://armypubs.army.mil/epubs/DR_pubs/DR_a/pdf/web/atp3_21x90.pdf",
      mimeTypeHint: "application/pdf",
    },
  ],
  "army:13B": [
    {
      title: "TC 3-09.81 — Field Artillery Manual Cannon Gunnery",
      url: "https://armypubs.army.mil/epubs/DR_pubs/DR_a/pdf/web/tc3_09x81.pdf",
      mimeTypeHint: "application/pdf",
    },
  ],
  "army:35F": [
    {
      title: "ATP 2-19.4 — Brigade Combat Team Intelligence Techniques",
      url: "https://armypubs.army.mil/epubs/DR_pubs/DR_a/pdf/web/atp2_19x4.pdf",
      mimeTypeHint: "application/pdf",
    },
    {
      title: "FM 2-0 — Intelligence",
      url: "https://armypubs.army.mil/epubs/DR_pubs/DR_a/ARN35381-FM_2-0-000-WEB-1.pdf",
      mimeTypeHint: "application/pdf",
    },
  ],
  "army:25B": [
    {
      title: "FM 6-02 — Signal Support to Operations",
      url: "https://armypubs.army.mil/epubs/DR_pubs/DR_a/pdf/web/ARN16461_FM%206-02%20FINAL%20WEB.pdf",
      mimeTypeHint: "application/pdf",
    },
  ],
  "army:68W": [
    {
      title: "ATP 4-02.5 — Casualty Care",
      url: "https://armypubs.army.mil/epubs/DR_pubs/DR_a/pdf/web/atp4_02x5.pdf",
      mimeTypeHint: "application/pdf",
    },
  ],
  "army:88M": [
    {
      title: "ATP 4-11 — Army Motor Transport Operations",
      url: "https://armypubs.army.mil/epubs/DR_pubs/DR_a/pdf/web/atp4_11.pdf",
      mimeTypeHint: "application/pdf",
    },
  ],
  "army:92Y": [
    {
      title: "ATP 4-42 — General Supply Support",
      url: "https://armypubs.army.mil/epubs/DR_pubs/DR_a/pdf/web/atp4_42.pdf",
      mimeTypeHint: "application/pdf",
    },
  ],
  "army:18A": [
    {
      title: "ADP 3-05 — Special Operations",
      url: "https://armypubs.army.mil/epubs/DR_pubs/DR_a/ARN35415-ADP_3-05-000-WEB-1.pdf",
      mimeTypeHint: "application/pdf",
    },
  ],
  "army:17A": [
    {
      title: "FM 3-12 — Cyberspace and Electromagnetic Warfare",
      url: "https://armypubs.army.mil/epubs/DR_pubs/DR_a/ARN34403-FM_3-12-000-WEB-1.pdf",
      mimeTypeHint: "application/pdf",
    },
  ],

  // ----- Marines -----
  "marines:0311": [
    {
      title: "MCWP 3-11.2 — Marine Rifle Squad",
      url: "https://www.marines.mil/Portals/1/Publications/MCWP%203-11.2%20Marine%20Rifle%20Squad.pdf",
      mimeTypeHint: "application/pdf",
    },
  ],
  "marines:0231": [
    {
      title: "MCWP 2-10 — Intelligence Operations",
      url: "https://www.marines.mil/Portals/1/Publications/MCWP%202-10.pdf",
      mimeTypeHint: "application/pdf",
    },
  ],
  "marines:6602": [
    {
      title: "MCWP 3-21.2 — Aviation Logistics",
      url: "https://www.marines.mil/Portals/1/Publications/MCWP%203-21.2%20Aviation%20Logistics.pdf",
      mimeTypeHint: "application/pdf",
    },
    {
      title: "MCRP 3-40A.5 — Aviation Maintenance Management",
      url: "https://www.marines.mil/Portals/1/Publications/MCRP%203-40A.5.pdf",
      mimeTypeHint: "application/pdf",
    },
  ],
  "marines:0651": [
    {
      title: "MCWP 3-30 — Communications and Information Systems",
      url: "https://www.marines.mil/Portals/1/Publications/MCWP%203-40.3%20Communications%20and%20Information%20Systems.pdf",
      mimeTypeHint: "application/pdf",
    },
  ],
  "marines:0402": [
    {
      title: "MCDP 4 — Logistics",
      url: "https://www.marines.mil/Portals/1/Publications/MCDP%204%20Logistics.pdf",
      mimeTypeHint: "application/pdf",
    },
  ],

  // ----- Navy -----
  "navy:IT": [
    {
      title: "NTP 3 — Naval Telecommunications Procedures (Computer Networks)",
      url: "https://www.public.navy.mil/fcc-c10f/Documents/NTP3.pdf",
      mimeTypeHint: "application/pdf",
    },
  ],
  "navy:HM": [
    {
      title: "NAVMED P-117 — Manual of the Medical Department",
      url: "https://www.med.navy.mil/Portals/62/Documents/BUMED/Directives/NAVMED%20P-117%20Manual%20of%20the%20Medical%20Department.pdf",
      mimeTypeHint: "application/pdf",
    },
  ],
  "navy:OS": [
    {
      title: "NWP 3-56 — Composite Warfare: Maritime Operations at the Tactical Level of War",
      url: "https://www.public.navy.mil/usff/Documents/NWP_3-56.pdf",
      mimeTypeHint: "application/pdf",
    },
  ],

  // ----- Air Force -----
  "air_force:1N0X1": [
    {
      title: "AFDP 2-0 — Intelligence, Surveillance, and Reconnaissance Operations",
      url: "https://www.doctrine.af.mil/Portals/61/documents/AFDP_2-0/2-0-AFDP-ISR-OPS.pdf",
      mimeTypeHint: "application/pdf",
    },
  ],
  "air_force:1B4X1": [
    {
      title: "AFDP 3-12 — Cyberspace Operations",
      url: "https://www.doctrine.af.mil/Portals/61/documents/AFDP_3-12/3-12-AFDP-CYBERSPACE-OPS.pdf",
      mimeTypeHint: "application/pdf",
    },
  ],
  "air_force:2A3X3": [
    {
      title: "AFI 21-101 — Aircraft and Equipment Maintenance Management",
      url: "https://static.e-publishing.af.mil/production/1/af_a4/publication/afi21-101/afi21-101.pdf",
      mimeTypeHint: "application/pdf",
    },
  ],

  // ----- Space Force -----
  "space_force:1C6X1": [
    {
      title: "Space Doctrine Publication 3-0 — Space Operations",
      url: "https://www.starcom.spaceforce.mil/Portals/2/SDP%203-0%20Operations%20-%20Final%20Web.pdf",
      mimeTypeHint: "application/pdf",
    },
  ],

  // ----- Coast Guard -----
  "coast_guard:BM": [
    {
      title: "USCG Boat Operations and Training (BOAT) Manual, Vol I",
      url: "https://media.defense.gov/2017/Mar/29/2001722272/-1/-1/0/CIM_16114_32E.PDF",
      mimeTypeHint: "application/pdf",
    },
  ],
  "coast_guard:ME": [
    {
      title: "USCG Maritime Law Enforcement Manual",
      url: "https://media.defense.gov/2018/Mar/05/2001880810/-1/-1/0/CIM_16247_1F.PDF",
      mimeTypeHint: "application/pdf",
    },
  ],
};

export function getMosDoctrinePackage(
  branchCode: Branch["code"],
  mosCode: string,
): DoctrineEntry[] {
  const foundational = FOUNDATIONAL_BY_BRANCH[branchCode] ?? [];
  const specific = MOS_SPECIFIC[`${branchCode}:${mosCode}`] ?? [];
  // De-dup by URL just in case the foundational set ever overlaps.
  const seen = new Set<string>();
  const merged: DoctrineEntry[] = [];
  for (const e of [...foundational, ...specific]) {
    if (seen.has(e.url)) continue;
    seen.add(e.url);
    merged.push(e);
  }
  return merged;
}

// ---------- Unit-specific add-ons ------------------------------------------
//
// Best-effort. Many units intentionally have no entry — that's fine, the
// auto-ingest endpoint just no-ops in that case.

const UNIT_SPECIFIC: Record<string, DoctrineEntry[]> = {
  // Army
  "army:101st Airborne Division": [
    {
      title: "ATP 3-18.10 — Air Assault Operations",
      url: "https://armypubs.army.mil/epubs/DR_pubs/DR_a/pdf/web/atp3_18x10.pdf",
      mimeTypeHint: "application/pdf",
    },
  ],
  "army:82nd Airborne Division": [
    {
      title: "ATP 3-18.11 — Special Forces Military Free-Fall Operations",
      url: "https://armypubs.army.mil/epubs/DR_pubs/DR_a/pdf/web/atp3_18x11.pdf",
      mimeTypeHint: "application/pdf",
    },
  ],
  "army:75th Ranger Regiment": [
    {
      title: "Ranger Handbook (TC 3-21.76)",
      url: "https://armypubs.army.mil/epubs/DR_pubs/DR_a/pdf/web/tc3_21x76.pdf",
      mimeTypeHint: "application/pdf",
    },
  ],

  // Marines
  "marines:MAG-12": [
    {
      title: "MCO 4790.25 — Aviation Logistics Support",
      url: "https://www.marines.mil/Portals/1/Publications/MCO%204790.25.pdf",
      mimeTypeHint: "application/pdf",
    },
  ],
  "marines:MALS-12": [
    {
      title: "MCO 4790.25 — Aviation Logistics Support",
      url: "https://www.marines.mil/Portals/1/Publications/MCO%204790.25.pdf",
      mimeTypeHint: "application/pdf",
    },
    {
      title: "NAVAIR 00-25-300 — Naval Air Maintenance Program",
      url: "https://www.navair.navy.mil/sites/g/files/jzttob151/files/2018-11/NAMP-00-25-300.pdf",
      mimeTypeHint: "application/pdf",
    },
  ],

  // Navy
  "navy:Naval Special Warfare Group 1": [
    {
      title: "NTTP 3-05 — Naval Special Warfare",
      url: "https://www.public.navy.mil/Documents/NTTP_3-05.pdf",
      mimeTypeHint: "application/pdf",
    },
  ],

  // Air Force
  "air_force:AFSOC": [
    {
      title: "AFDP 3-05 — Special Operations",
      url: "https://www.doctrine.af.mil/Portals/61/documents/AFDP_3-05/3-05-AFDP-Special-Ops.pdf",
      mimeTypeHint: "application/pdf",
    },
  ],

  // Space Force
  "space_force:Space Delta 6": [
    {
      title: "Space Doctrine Publication 3-12 — Cyberspace Operations",
      url: "https://www.starcom.spaceforce.mil/Portals/2/SDP%203-12%20Cyberspace%20Operations.pdf",
      mimeTypeHint: "application/pdf",
    },
  ],

  // Coast Guard
  "coast_guard:Coast Guard Cyber Command": [
    {
      title: "USCG Cyber Strategic Outlook",
      url: "https://www.uscg.mil/Portals/0/seniorleadership/alwaysready/CG_Cyber_Strategic_Outlook.PDF",
      mimeTypeHint: "application/pdf",
    },
  ],
};

export function getUnitDoctrinePackage(
  branchCode: Branch["code"],
  unit: string,
): DoctrineEntry[] {
  return UNIT_SPECIFIC[`${branchCode}:${unit}`] ?? [];
}

/**
 * True iff we have at least one doc curated for this unit. Used by the
 * profile-update hook to decide whether saving a unit value should kick off
 * an ingest at all.
 */
export function hasUnitDoctrinePackage(
  branchCode: Branch["code"],
  unit: string,
): boolean {
  return (UNIT_SPECIFIC[`${branchCode}:${unit}`]?.length ?? 0) > 0;
}
