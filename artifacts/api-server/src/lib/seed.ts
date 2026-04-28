import { db, categoriesTable, toolsTable } from "@workspace/db";
import { eq, sql } from "drizzle-orm";
import { logger } from "./logger";

const CATEGORIES = [
  {
    slug: "intel-analysis",
    name: "Intelligence & Analysis",
    description: "OSINT, geospatial analysis, signals analysis support.",
    icon: "intel",
    sortOrder: 10,
  },
  {
    slug: "logistics",
    name: "Logistics & Sustainment",
    description: "Maintenance forecasting, inventory, supply chain.",
    icon: "logistics",
    sortOrder: 20,
  },
  {
    slug: "comms-writing",
    name: "Communications & Writing",
    description: "Drafting briefs, evals, awards, and orders.",
    icon: "writing",
    sortOrder: 30,
  },
  {
    slug: "training",
    name: "Training & Education",
    description: "Curriculum, scenario generation, simulation aids.",
    icon: "training",
    sortOrder: 40,
  },
  {
    slug: "cybersecurity",
    name: "Cyber & Network Defense",
    description: "Threat triage, log review, vulnerability scoping.",
    icon: "cyber",
    sortOrder: 50,
  },
  {
    slug: "personnel",
    name: "Personnel & Readiness",
    description: "Talent management, fitness, mental health resources.",
    icon: "personnel",
    sortOrder: 60,
  },
];

interface SeedTool {
  slug: string;
  name: string;
  vendor: string;
  categorySlug: string;
  shortDescription: string;
  longDescription: string;
  purpose: string;
  ragQueryTemplates: string[];
  atoStatus: string;
  impactLevels: string[];
  dataClassification: string;
  version: string;
  badges: string[];
  homepageUrl: string | null;
  launchUrl: string;
  documentationUrl: string | null;
  isActive: boolean;
}

const TOOLS: SeedTool[] = [
  {
    slug: "context-echo",
    name: "Context Echo",
    vendor: "DoW AI Marketplace",
    categorySlug: "comms-writing",
    shortDescription:
      "Reference tool that displays the exact context bundle the marketplace forwards on launch.",
    longDescription:
      "Context Echo is the demonstration tool for the marketplace launch protocol. When you launch it, the marketplace mints a one-time launch token, the tool exchanges that token for your sanitized profile and a bundle of relevant snippets pulled from your personal library, and Context Echo renders the full payload so you can see exactly what tool builders receive on your behalf. Use it to validate that your profile is complete and that your library is returning useful primer snippets before launching production tools.",
    purpose:
      "Surface the exact profile fields and library snippets that get forwarded on launch so operators can audit what each tool is allowed to see.",
    ragQueryTemplates: [
      "{billets}",
      "{dutyTitle} {mosCode}",
      "{unit} SOP",
    ],
    atoStatus: "full_ato",
    impactLevels: ["il2", "il4", "il5"],
    dataClassification: "cui",
    version: "1.0",
    badges: ["Reference Implementation", "FedRAMP Moderate", "Section 508"],
    homepageUrl: null,
    launchUrl: "/context-echo/",
    documentationUrl: null,
    isActive: true,
  },
  {
    slug: "brief-drafter",
    name: "Mission Brief Drafter",
    vendor: "DoW AI Marketplace",
    categorySlug: "comms-writing",
    shortDescription:
      "Drafts a SITREP, OPORD paragraph, or training brief in your voice from a one-line topic.",
    longDescription:
      "Mission Brief Drafter is the second reference tool for the marketplace. On launch it exchanges your launch token for the same context bundle Context Echo shows, then asks Claude to draft a SITREP, OPORD paragraph, or training brief in your service's voice — anchored to your profile (rank, billet, unit, mission) and the most relevant snippets from your personal library. The output is editable in-place so you can polish it and copy it straight into your staff product.",
    purpose:
      "Draft staff-ready briefs (SITREP, OPORD paragraph, or training brief) anchored in the operator's library of OPORDs, FRAGOs, and unit SOPs, in their service's voice.",
    ragQueryTemplates: [
      "{billets} OPORD",
      "{dutyTitle} commander's intent",
      "{unit} mission essential task",
      "MDMP commander's guidance",
    ],
    atoStatus: "full_ato",
    impactLevels: ["il2", "il4"],
    dataClassification: "cui",
    version: "1.0",
    badges: ["Reference Implementation", "FedRAMP High", "Section 508"],
    homepageUrl: null,
    launchUrl: "/brief-drafter/",
    documentationUrl: null,
    isActive: true,
  },
  {
    slug: "eval-assist",
    name: "EvalAssist",
    vendor: "Talent Forge",
    categorySlug: "personnel",
    shortDescription:
      "Drafts NCOERs, OERs, and FITREP bullets that match your service's current style guides.",
    longDescription:
      "EvalAssist drafts evaluation bullets in your service's exact voice, pulling from your service-specific style guide and your library of past evals. It never invents accomplishments — every bullet is anchored in inputs you provide.",
    purpose:
      "Draft NCOER/OER/FITREP bullets in service-specific voice, anchored to the operator's library of past evaluations, awards, and accomplishments.",
    ragQueryTemplates: [
      "{rank} evaluation bullets",
      "{dutyTitle} accomplishments",
      "award citations {unit}",
    ],
    atoStatus: "full_ato",
    impactLevels: ["il4", "il5"],
    dataClassification: "cui",
    version: "1.7",
    badges: ["DISA STIG", "FedRAMP High"],
    homepageUrl: null,
    launchUrl: "/context-echo/",
    documentationUrl: null,
    isActive: true,
  },
  {
    slug: "logix",
    name: "LogiX Forecaster",
    vendor: "Sustainment AI",
    categorySlug: "logistics",
    shortDescription:
      "Predictive maintenance and parts demand forecasting for fleet operations.",
    longDescription:
      "LogiX Forecaster ingests historical maintenance records and operational tempo to predict failure windows and parts demand. Pairs with GCSS-Army, NTCSS, and DPAS feeds.",
    purpose:
      "Predict equipment failure windows and parts demand using the operator's fleet maintenance records, OPTEMPO data, and historical 5988-E forms.",
    ragQueryTemplates: [
      "{unit} maintenance schedule",
      "GCSS-Army parts demand",
      "5988-E deadline equipment",
    ],
    atoStatus: "ipa",
    impactLevels: ["il4", "il5"],
    dataClassification: "cui",
    version: "0.9-beta",
    badges: ["Interim Authority", "FedRAMP Moderate"],
    homepageUrl: null,
    launchUrl: "/context-echo/",
    documentationUrl: null,
    isActive: true,
  },
  {
    slug: "osint-lens",
    name: "OSINT Lens",
    vendor: "Sentinel Analytics",
    categorySlug: "intel-analysis",
    shortDescription:
      "Open-source intelligence triage with provenance tracking and source confidence scoring.",
    longDescription:
      "OSINT Lens helps analysts triage open-source reporting at scale, tagging entities, deduplicating across sources, and maintaining provenance chains so finished products can be defended.",
    purpose:
      "Triage open-source reporting against the operator's collection plan and PIRs, scoring sources and preserving provenance for finished intelligence products.",
    ragQueryTemplates: [
      "{billets} collection requirements",
      "{unit} priority intelligence requirements",
      "OSINT source evaluation criteria",
    ],
    atoStatus: "full_ato",
    impactLevels: ["il5", "il6"],
    dataClassification: "secret",
    version: "3.1",
    badges: ["FedRAMP High", "DoW IL5"],
    homepageUrl: null,
    launchUrl: "/context-echo/",
    documentationUrl: null,
    isActive: true,
  },
  {
    slug: "geo-fuser",
    name: "GeoFuser",
    vendor: "Polaris Geospatial",
    categorySlug: "intel-analysis",
    shortDescription:
      "Multi-INT geospatial fusion with NGA-compliant export pipelines.",
    longDescription:
      "GeoFuser ingests SIGINT, IMINT, and HUMINT layers and fuses them onto a common geospatial canvas with NGA-compliant export.",
    purpose:
      "Fuse SIGINT/IMINT/HUMINT layers over the operator's named area of interest and produce NGA-compliant geospatial products.",
    ragQueryTemplates: [
      "{billets} named area of interest",
      "{baseLocation} geospatial baseline",
      "NGA export geospatial",
    ],
    atoStatus: "ipa",
    impactLevels: ["il5", "il6"],
    dataClassification: "secret",
    version: "1.2",
    badges: ["Interim Authority", "DoW IL6"],
    homepageUrl: null,
    launchUrl: "/context-echo/",
    documentationUrl: null,
    isActive: true,
  },
  {
    slug: "log-triage",
    name: "Log Triage",
    vendor: "CyberWatch",
    categorySlug: "cybersecurity",
    shortDescription:
      "Reduces SIEM alert fatigue by clustering and prioritizing log events.",
    longDescription:
      "Log Triage clusters raw SIEM alerts into prioritized incidents, suppressing known-benign patterns and surfacing the events that warrant immediate analyst attention.",
    purpose:
      "Cluster SIEM alerts into prioritized incidents using the operator's network baselines, known-benign playbooks, and threat hunt history.",
    ragQueryTemplates: [
      "{unit} network baseline",
      "SIEM alert playbook {dutyTitle}",
      "incident response procedure",
    ],
    atoStatus: "full_ato",
    impactLevels: ["il4", "il5"],
    dataClassification: "cui",
    version: "4.0",
    badges: ["FedRAMP High", "DISA STIG"],
    homepageUrl: null,
    launchUrl: "/context-echo/",
    documentationUrl: null,
    isActive: true,
  },
  {
    slug: "vuln-scoper",
    name: "VulnScoper",
    vendor: "CyberWatch",
    categorySlug: "cybersecurity",
    shortDescription:
      "Scopes CVE impact against your unit's actual asset inventory.",
    longDescription:
      "VulnScoper translates CVE advisories into unit-specific exposure assessments, mapping advisories against your live asset inventory and prioritizing patch order by mission impact.",
    purpose:
      "Translate CVE advisories into unit-specific exposure assessments by joining them against the operator's asset inventory and mission-criticality records.",
    ragQueryTemplates: [
      "{unit} asset inventory",
      "{billets} mission critical systems",
      "patch management policy",
    ],
    atoStatus: "in_review",
    impactLevels: ["il4"],
    dataClassification: "cui",
    version: "0.6-beta",
    badges: ["Pre-ATO"],
    homepageUrl: null,
    launchUrl: "/context-echo/",
    documentationUrl: null,
    isActive: true,
  },
  {
    slug: "scenario-forge",
    name: "Scenario Forge",
    vendor: "Range Operations LLC",
    categorySlug: "training",
    shortDescription:
      "Generates training scenarios calibrated to your unit's METL.",
    longDescription:
      "Scenario Forge generates STX/LFX scenarios calibrated to your unit's Mission Essential Task List, with white-cell injects, OPFOR profiles, and after-action prompts.",
    purpose:
      "Generate STX/LFX scenarios, white-cell injects, and AAR prompts calibrated to the operator's METL and recent training gaps.",
    ragQueryTemplates: [
      "{unit} mission essential task list",
      "{billets} training gaps",
      "STX after action review",
    ],
    atoStatus: "full_ato",
    impactLevels: ["il2", "il4"],
    dataClassification: "cui",
    version: "2.0",
    badges: ["FedRAMP Moderate"],
    homepageUrl: null,
    launchUrl: "/context-echo/",
    documentationUrl: null,
    isActive: true,
  },
  {
    slug: "doctrine-search",
    name: "Doctrine Search",
    vendor: "Joint Knowledge",
    categorySlug: "training",
    shortDescription:
      "Cross-service doctrine search across FMs, JPs, MCWPs, and AFDPs.",
    longDescription:
      "Doctrine Search indexes the full corpus of unclassified joint and service doctrine, returning answers with paragraph-level citations.",
    purpose:
      "Answer doctrinal questions with paragraph-level citations from the operator's saved FMs, JPs, MCWPs, AFDPs, and unit-authored references.",
    ragQueryTemplates: [
      "{billets} doctrine reference",
      "{dutyTitle} field manual",
      "joint publication tactics",
    ],
    atoStatus: "full_ato",
    impactLevels: ["il2"],
    dataClassification: "public",
    version: "5.4",
    badges: ["FedRAMP Moderate", "Section 508"],
    homepageUrl: null,
    launchUrl: "/context-echo/",
    documentationUrl: null,
    isActive: true,
  },
  {
    slug: "talent-match",
    name: "TalentMatch",
    vendor: "Talent Forge",
    categorySlug: "personnel",
    shortDescription:
      "Matches Soldiers to follow-on assignments by skill, preference, and unit demand.",
    longDescription:
      "TalentMatch combines AIM 2.0-style preferences with verified skill records and unit demand signals to surface high-fit follow-on assignments and broadening opportunities.",
    purpose:
      "Match the operator to follow-on assignments using their verified skills, AIM 2.0 preferences, prior duty history, and unit demand signals.",
    ragQueryTemplates: [
      "{rank} {mosCode} career path",
      "{dutyTitle} broadening opportunities",
      "AIM 2.0 preferences",
    ],
    atoStatus: "ipa",
    impactLevels: ["il4"],
    dataClassification: "cui",
    version: "1.1",
    badges: ["Interim Authority"],
    homepageUrl: null,
    launchUrl: "/context-echo/",
    documentationUrl: null,
    isActive: true,
  },
  {
    slug: "ready-medic",
    name: "ReadyMedic",
    vendor: "BlueForce Health",
    categorySlug: "personnel",
    shortDescription:
      "Personalized PRT/PFT plans calibrated to your profile and event date.",
    longDescription:
      "ReadyMedic builds personalized PRT/PFT plans calibrated to your service's standards, your current performance, and the date of your next record event.",
    purpose:
      "Build personalized PRT/PFT plans using the operator's service standards, current diagnostic scores, injury history, and record event date.",
    ragQueryTemplates: [
      "{branch} fitness standards {rank}",
      "PRT diagnostic score history",
      "injury rehabilitation profile",
    ],
    atoStatus: "in_review",
    impactLevels: ["il2"],
    dataClassification: "public",
    version: "0.4-beta",
    badges: ["Pre-ATO"],
    homepageUrl: null,
    launchUrl: "/context-echo/",
    documentationUrl: null,
    isActive: true,
  },
];

export async function seedCatalog(): Promise<void> {
  const [{ count }] = await db
    .select({ count: sql<number>`COUNT(*)::int` })
    .from(categoriesTable);

  let slugToId: Map<string, string>;

  if (Number(count) > 0) {
    logger.info({ count }, "catalog already seeded; backfilling purpose & rag templates");
    const cats = await db.select().from(categoriesTable);
    slugToId = new Map(cats.map((c) => [c.slug, c.id]));
  } else {
    logger.info("seeding catalog");
    const insertedCats = await db
      .insert(categoriesTable)
      .values(CATEGORIES)
      .returning();
    slugToId = new Map(insertedCats.map((c) => [c.slug, c.id]));

    await db.insert(toolsTable).values(
      TOOLS.map((t) => ({
        slug: t.slug,
        name: t.name,
        vendor: t.vendor,
        shortDescription: t.shortDescription,
        longDescription: t.longDescription,
        purpose: t.purpose,
        ragQueryTemplates: t.ragQueryTemplates,
        categoryId: slugToId.get(t.categorySlug) ?? null,
        atoStatus: t.atoStatus,
        impactLevels: t.impactLevels,
        dataClassification: t.dataClassification,
        version: t.version,
        badges: t.badges,
        homepageUrl: t.homepageUrl,
        launchUrl: t.launchUrl,
        documentationUrl: t.documentationUrl,
        isActive: t.isActive ? "true" : "false",
        createdBy: null,
      })),
    );
    logger.info({ tools: TOOLS.length }, "catalog seeded");
    return;
  }

  // Backfill purpose & ragQueryTemplates onto existing seed rows that were
  // created before those columns existed. Only update rows where BOTH fields
  // still hold their schema defaults (empty string + empty array) so we never
  // clobber admin edits — even partial ones.
  for (const t of TOOLS) {
    await db
      .update(toolsTable)
      .set({
        purpose: t.purpose,
        ragQueryTemplates: t.ragQueryTemplates,
      })
      .where(
        sql`${toolsTable.slug} = ${t.slug}
          AND ${toolsTable.purpose} = ''
          AND ${toolsTable.ragQueryTemplates} = '[]'::jsonb`,
      );
  }

  // Rename the legacy "brief-builder" placeholder row to the real
  // "brief-drafter" tool. The earlier catalog seeded a stub at slug
  // "brief-builder" pointing at /context-echo/; now that the real artifact
  // exists at /brief-drafter/ we promote that row in place so existing
  // launches and pinned categories don't dangle.
  const briefDrafterDef = TOOLS.find((t) => t.slug === "brief-drafter");
  if (briefDrafterDef) {
    await db
      .update(toolsTable)
      .set({
        slug: briefDrafterDef.slug,
        name: briefDrafterDef.name,
        vendor: briefDrafterDef.vendor,
        shortDescription: briefDrafterDef.shortDescription,
        longDescription: briefDrafterDef.longDescription,
        purpose: briefDrafterDef.purpose,
        ragQueryTemplates: briefDrafterDef.ragQueryTemplates,
        atoStatus: briefDrafterDef.atoStatus,
        impactLevels: briefDrafterDef.impactLevels,
        dataClassification: briefDrafterDef.dataClassification,
        version: briefDrafterDef.version,
        badges: briefDrafterDef.badges,
        homepageUrl: briefDrafterDef.homepageUrl,
        launchUrl: briefDrafterDef.launchUrl,
        documentationUrl: briefDrafterDef.documentationUrl,
        categoryId: slugToId.get(briefDrafterDef.categorySlug) ?? null,
      })
      .where(sql`${toolsTable.slug} = 'brief-builder'`);
  }

  // For any other still-stub rows that point at the /context-echo/ placeholder
  // (besides context-echo itself), if the seed catalog now has a real
  // launchUrl for that slug, promote it. This keeps launchUrl in sync as new
  // demo tools come online without clobbering admin-customized launchUrls.
  for (const t of TOOLS) {
    if (t.slug === "context-echo") continue;
    if (t.launchUrl === "/context-echo/") continue;
    await db
      .update(toolsTable)
      .set({ launchUrl: t.launchUrl })
      .where(
        sql`${toolsTable.slug} = ${t.slug}
          AND ${toolsTable.launchUrl} = '/context-echo/'`,
      );
  }

  logger.info("backfill complete");
}
