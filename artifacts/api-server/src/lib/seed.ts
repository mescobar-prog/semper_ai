import { db, categoriesTable, toolsTable } from "@workspace/db";
import { sql } from "drizzle-orm";
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

const TOOLS = [
  {
    slug: "context-echo",
    name: "Context Echo",
    vendor: "DoD AI Marketplace",
    categorySlug: "comms-writing",
    shortDescription:
      "Reference tool that displays the exact context bundle the marketplace forwards on launch.",
    longDescription:
      "Context Echo is the demonstration tool for the marketplace launch protocol. When you launch it, the marketplace mints a one-time launch token, the tool exchanges that token for your sanitized profile and a bundle of relevant snippets pulled from your personal library, and Context Echo renders the full payload so you can see exactly what tool builders receive on your behalf. Use it to validate that your profile is complete and that your library is returning useful primer snippets before launching production tools.",
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
    slug: "brief-builder",
    name: "Brief Builder",
    vendor: "DoD AI Marketplace",
    categorySlug: "comms-writing",
    shortDescription:
      "Drafts staff-ready briefs from a one-line topic plus your library and profile.",
    longDescription:
      "Brief Builder turns a one-line topic into a staff-ready brief by combining your structured profile (rank, billet, unit) with the most relevant snippets from your personal library. Output follows standard MDMP/JOPP formatting and is ready to paste into a SmartBook deliverable.",
    atoStatus: "full_ato",
    impactLevels: ["il2", "il4"],
    dataClassification: "cui",
    version: "2.3",
    badges: ["FedRAMP High", "Section 508"],
    homepageUrl: null,
    launchUrl: "/context-echo/",
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
    atoStatus: "full_ato",
    impactLevels: ["il5", "il6"],
    dataClassification: "secret",
    version: "3.1",
    badges: ["FedRAMP High", "DoD IL5"],
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
    atoStatus: "ipa",
    impactLevels: ["il5", "il6"],
    dataClassification: "secret",
    version: "1.2",
    badges: ["Interim Authority", "DoD IL6"],
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
  if (Number(count) > 0) {
    logger.info({ count }, "catalog already seeded");
    return;
  }

  logger.info("seeding catalog");
  const insertedCats = await db
    .insert(categoriesTable)
    .values(CATEGORIES)
    .returning();
  const slugToId = new Map(insertedCats.map((c) => [c.slug, c.id]));

  await db.insert(toolsTable).values(
    TOOLS.map((t) => ({
      slug: t.slug,
      name: t.name,
      vendor: t.vendor,
      shortDescription: t.shortDescription,
      longDescription: t.longDescription,
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
    })),
  );
  logger.info({ tools: TOOLS.length }, "catalog seeded");
}
