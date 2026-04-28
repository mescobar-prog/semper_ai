import { and, asc, eq, sql } from "drizzle-orm";
import {
  db,
  profilesTable,
  presetsTable,
  presetDocumentsTable,
  type Preset,
  type PresetProfileSnapshot,
  type Profile,
  type ContextBlockScores,
} from "@workspace/db";

const BRANCH_LABEL: Record<string, string> = {
  army: "U.S. Army",
  navy: "U.S. Navy",
  marines: "U.S. Marine Corps",
  air_force: "U.S. Air Force",
  space_force: "U.S. Space Force",
  coast_guard: "U.S. Coast Guard",
};

const CLEARANCE_LABEL: Record<string, string> = {
  none: "No clearance",
  secret: "Secret",
  top_secret: "Top Secret",
  ts_sci: "TS/SCI",
};

const DEPLOYMENT_LABEL: Record<string, string> = {
  garrison: "Garrison",
  deployed: "Deployed",
  training: "In training",
  transitioning: "Transitioning",
};

const TRACKED_FIELDS: Array<keyof Profile> = [
  "branch",
  "rank",
  "mosCode",
  "dutyTitle",
  "unit",
  "baseLocation",
  "securityClearance",
  "deploymentStatus",
  "primaryMission",
  "aiUseCases",
  "freeFormContext",
  // The 6-element Context Block also counts toward profile completeness:
  // operators are not "done" until they have a confirmed block.
  "cbDoctrine",
  "cbIntent",
  "cbEnvironment",
  "cbConstraints",
  "cbRisk",
  "cbExperience",
];

const SNAPSHOT_TRACKED_FIELDS: Array<keyof PresetProfileSnapshot> = [
  "branch",
  "rank",
  "mosCode",
  "dutyTitle",
  "unit",
  "baseLocation",
  "securityClearance",
  "deploymentStatus",
  "primaryMission",
  "aiUseCases",
  "freeFormContext",
];

export function completenessPct(profile: Profile | null): number {
  if (!profile) return 0;
  let filled = 0;
  for (const f of TRACKED_FIELDS) {
    const v = profile[f];
    if (Array.isArray(v)) {
      if (v.length > 0) filled++;
    } else if (typeof v === "string") {
      if (v.trim()) filled++;
    }
  }
  return Math.round((filled / TRACKED_FIELDS.length) * 100);
}

export function completenessPctFromSnapshot(
  snap: PresetProfileSnapshot,
): number {
  let filled = 0;
  for (const f of SNAPSHOT_TRACKED_FIELDS) {
    const v = snap[f];
    if (Array.isArray(v)) {
      if (v.length > 0) filled++;
    } else if (typeof v === "string") {
      if (v.trim()) filled++;
    }
  }
  return Math.round((filled / SNAPSHOT_TRACKED_FIELDS.length) * 100);
}

export async function getOrCreateProfile(userId: string): Promise<Profile> {
  const existing = await db
    .select()
    .from(profilesTable)
    .where(eq(profilesTable.userId, userId))
    .limit(1);
  if (existing[0]) return existing[0];

  const [created] = await db
    .insert(profilesTable)
    .values({ userId, aiUseCases: [] })
    .returning();
  return created;
}

export interface SerializedContextBlockState {
  doctrine: string | null;
  intent: string | null;
  environment: string | null;
  constraints: string | null;
  risk: string | null;
  experience: string | null;
  confirmedAt: string | null;
  lastEvaluation: SerializedContextBlockEvaluation | null;
}

export interface SerializedContextBlockEvaluation {
  submissionId: string;
  scores: ContextBlockScores;
  totalScore: number;
  status: string;
  opsecFlag: boolean;
  flags: string;
}

export function serializeContextBlock(
  profile: Profile,
): SerializedContextBlockState {
  const lastEvaluation: SerializedContextBlockEvaluation | null =
    profile.cbScoreTotal != null && profile.cbScores && profile.cbStatus
      ? {
          submissionId: profile.cbSubmissionId ?? "",
          scores: profile.cbScores,
          totalScore: profile.cbScoreTotal,
          status: profile.cbStatus,
          opsecFlag: profile.cbOpsecFlag === "true",
          flags: profile.cbFlags ?? "None",
        }
      : null;
  return {
    doctrine: profile.cbDoctrine,
    intent: profile.cbIntent,
    environment: profile.cbEnvironment,
    constraints: profile.cbConstraints,
    risk: profile.cbRisk,
    experience: profile.cbExperience,
    confirmedAt: profile.cbConfirmedAt ? profile.cbConfirmedAt.toISOString() : null,
    lastEvaluation,
  };
}

export function hasConfirmedContextBlock(profile: Profile | null): boolean {
  if (!profile || !profile.cbConfirmedAt) return false;
  // All 6 elements must have been filled at confirm time.
  return [
    profile.cbDoctrine,
    profile.cbIntent,
    profile.cbEnvironment,
    profile.cbConstraints,
    profile.cbRisk,
    profile.cbExperience,
  ].every((v) => typeof v === "string" && v.trim().length > 0);
}

/**
 * Build a tool-friendly Markdown context block for a launching user. Tool
 * builders can drop this string directly into their model prompt without
 * re-parsing the structured profile JSON. Sections that have no data are
 * omitted so the block stays tight.
 */
export function buildContextBlock(
  user: { displayName: string; email: string | null },
  profile: Profile | null,
): string {
  const lines: string[] = [];
  lines.push(`# Operator context for ${user.displayName}`);
  if (user.email) lines.push(`Email: ${user.email}`);
  lines.push("");

  let appendedSection = false;

  const identity: string[] = [];
  if (profile?.branch)
    identity.push(`- Branch: ${BRANCH_LABEL[profile.branch] ?? profile.branch}`);
  if (profile?.rank) identity.push(`- Rank: ${profile.rank}`);
  if (profile?.mosCode) identity.push(`- MOS/Rate/AFSC: ${profile.mosCode}`);
  if (profile?.dutyTitle) identity.push(`- Duty title: ${profile.dutyTitle}`);
  if (profile?.unit) identity.push(`- Unit: ${profile.unit}`);
  if (profile?.baseLocation)
    identity.push(`- Base/location: ${profile.baseLocation}`);
  if (identity.length > 0) {
    lines.push("## Identity & assignment");
    lines.push(...identity);
    lines.push("");
    appendedSection = true;
  }

  const status: string[] = [];
  if (profile?.securityClearance) {
    status.push(
      `- Clearance: ${
        CLEARANCE_LABEL[profile.securityClearance] ?? profile.securityClearance
      }`,
    );
  }
  if (profile?.deploymentStatus) {
    status.push(
      `- Deployment status: ${
        DEPLOYMENT_LABEL[profile.deploymentStatus] ?? profile.deploymentStatus
      }`,
    );
  }
  if (status.length > 0) {
    lines.push("## Status");
    lines.push(...status);
    lines.push("");
    appendedSection = true;
  }

  if (profile?.primaryMission) {
    lines.push("## Primary mission");
    lines.push(profile.primaryMission.trim());
    lines.push("");
    appendedSection = true;
  }

  if (profile?.aiUseCases && profile.aiUseCases.length > 0) {
    lines.push("## What they want AI help with");
    for (const uc of profile.aiUseCases) lines.push(`- ${uc}`);
    lines.push("");
    appendedSection = true;
  }

  if (profile?.freeFormContext && profile.freeFormContext.trim()) {
    lines.push("## Additional context");
    lines.push(profile.freeFormContext.trim());
    lines.push("");
    appendedSection = true;
  }

  // 6-element Context Block (verification gate). Only render when the
  // operator has actually confirmed one. Otherwise drop a one-line note so
  // tool builders know the gate has not been cleared yet.
  if (hasConfirmedContextBlock(profile)) {
    const score = profile!.cbScoreTotal;
    const status = profile!.cbStatus;
    const confirmedAt = profile!.cbConfirmedAt!.toISOString();
    lines.push("## Context Block");
    lines.push(
      `_Confirmed ${confirmedAt} · evaluator score ${score ?? "?"} /12 · status ${status ?? "?"}_`,
    );
    lines.push("");
    lines.push("### 1. Doctrine & Orders");
    lines.push(profile!.cbDoctrine!.trim());
    lines.push("");
    lines.push("### 2. Commander's Intent");
    lines.push(profile!.cbIntent!.trim());
    lines.push("");
    lines.push("### 3. Environment");
    lines.push(profile!.cbEnvironment!.trim());
    lines.push("");
    lines.push("### 4. Constraints & Limitations");
    lines.push(profile!.cbConstraints!.trim());
    lines.push("");
    lines.push("### 5. Risk");
    lines.push(profile!.cbRisk!.trim());
    lines.push("");
    lines.push("### 6. Experience & Judgment");
    lines.push(profile!.cbExperience!.trim());
    lines.push("");
    appendedSection = true;
  } else {
    lines.push("## Context Block");
    lines.push(
      "_The operator has not yet confirmed a 6-element Context Block. Treat any operational specifics with extra caution and ask clarifying questions before producing high-stakes output._",
    );
    lines.push("");
    appendedSection = true;
  }

  if (!appendedSection) {
    lines.push(
      "_The operator has not yet completed their structured profile. Ask them about their role, mission, and unit before producing personalized output._",
    );
  }

  return lines.join("\n").trim() + "\n";
}

export function snapshotFromProfile(profile: Profile): PresetProfileSnapshot {
  return {
    branch: profile.branch ?? null,
    rank: profile.rank ?? null,
    mosCode: profile.mosCode ?? null,
    dutyTitle: profile.dutyTitle ?? null,
    unit: profile.unit ?? null,
    baseLocation: profile.baseLocation ?? null,
    securityClearance: profile.securityClearance ?? null,
    deploymentStatus: profile.deploymentStatus ?? null,
    primaryMission: profile.primaryMission ?? null,
    aiUseCases: Array.isArray(profile.aiUseCases) ? profile.aiUseCases : [],
    freeFormContext: profile.freeFormContext ?? null,
  };
}

export function emptySnapshot(): PresetProfileSnapshot {
  return {
    branch: null,
    rank: null,
    mosCode: null,
    dutyTitle: null,
    unit: null,
    baseLocation: null,
    securityClearance: null,
    deploymentStatus: null,
    primaryMission: null,
    aiUseCases: [],
    freeFormContext: null,
  };
}

/**
 * Build a "Profile-shaped" object whose identity/mission fields come from a
 * preset snapshot, while the cb_* / Context Block fields and other live-only
 * fields fall back to the live profile. Used by launch flows where the
 * preset's snapshot drives identity but the user's confirmed Context Block
 * is still a property of the live profile.
 */
export function snapshotAsProfile(
  snap: PresetProfileSnapshot,
  fallback: Profile,
): Profile {
  return {
    ...fallback,
    branch: snap.branch,
    rank: snap.rank,
    mosCode: snap.mosCode,
    dutyTitle: snap.dutyTitle,
    unit: snap.unit,
    baseLocation: snap.baseLocation,
    securityClearance: snap.securityClearance,
    deploymentStatus: snap.deploymentStatus,
    primaryMission: snap.primaryMission,
    aiUseCases: snap.aiUseCases ?? [],
    freeFormContext: snap.freeFormContext,
  };
}

export function serializeProfile(
  profile: Profile,
  activePresetId: string | null = null,
) {
  return {
    userId: profile.userId,
    branch: profile.branch,
    rank: profile.rank,
    mosCode: profile.mosCode,
    dutyTitle: profile.dutyTitle,
    unit: profile.unit,
    baseLocation: profile.baseLocation,
    securityClearance: profile.securityClearance,
    deploymentStatus: profile.deploymentStatus,
    primaryMission: profile.primaryMission,
    aiUseCases: profile.aiUseCases ?? [],
    freeFormContext: profile.freeFormContext,
    isAdmin: profile.isAdmin === "true",
    activePresetId: activePresetId ?? profile.activePresetId ?? null,
    completenessPct: completenessPct(profile),
    contextBlock: serializeContextBlock(profile),
    updatedAt: profile.updatedAt.toISOString(),
  };
}

// Lazily ensure the user has at least one preset and an active-preset
// pointer. This is the migration path for accounts created before presets
// existed: on first read we mint a "Default" preset from their current
// profile and link every existing document to it.
export async function ensureActivePreset(userId: string): Promise<{
  profile: Profile;
  preset: Preset;
}> {
  let profile = await getOrCreateProfile(userId);

  if (profile.activePresetId) {
    const [preset] = await db
      .select()
      .from(presetsTable)
      .where(
        and(
          eq(presetsTable.id, profile.activePresetId),
          eq(presetsTable.userId, userId),
        ),
      )
      .limit(1);
    if (preset) return { profile, preset };
    // Stale pointer (deleted preset) — fall through to repair.
  }

  // Try to adopt an existing preset before creating a new one.
  const [existingPreset] = await db
    .select()
    .from(presetsTable)
    .where(eq(presetsTable.userId, userId))
    .orderBy(asc(presetsTable.createdAt))
    .limit(1);

  if (existingPreset) {
    const [updated] = await db
      .update(profilesTable)
      .set({ activePresetId: existingPreset.id })
      .where(eq(profilesTable.userId, userId))
      .returning();
    return { profile: updated ?? profile, preset: existingPreset };
  }

  // Mint a default preset from the current profile.
  const [created] = await db
    .insert(presetsTable)
    .values({
      userId,
      name: "Default",
      description: "Auto-created from your current profile",
      profileSnapshot: snapshotFromProfile(profile),
    })
    .returning();

  // Link every existing library doc to this preset (best-effort backfill).
  await db.execute(sql`
    INSERT INTO ${presetDocumentsTable} (preset_id, document_id)
    SELECT ${created.id}, d.id FROM documents d WHERE d.user_id = ${userId}
    ON CONFLICT DO NOTHING
  `);

  const [updated] = await db
    .update(profilesTable)
    .set({ activePresetId: created.id })
    .where(eq(profilesTable.userId, userId))
    .returning();

  return { profile: updated ?? profile, preset: created };
}

export interface ActiveContext {
  profile: Profile;
  activePreset: Preset;
  snapshot: PresetProfileSnapshot;
  documentIds: string[];
}

export async function getActiveContext(userId: string): Promise<ActiveContext> {
  const { profile, preset } = await ensureActivePreset(userId);
  const docLinks = await db
    .select({ documentId: presetDocumentsTable.documentId })
    .from(presetDocumentsTable)
    .where(eq(presetDocumentsTable.presetId, preset.id));
  return {
    profile,
    activePreset: preset,
    snapshot: preset.profileSnapshot,
    documentIds: docLinks.map((d) => d.documentId),
  };
}

export async function getPresetDocumentIds(
  userId: string,
  presetId: string,
): Promise<string[]> {
  // Verify ownership through the join; orphan/cross-user IDs are silently
  // dropped by the WHERE clause.
  const rows = await db
    .select({ id: presetDocumentsTable.documentId })
    .from(presetDocumentsTable)
    .innerJoin(presetsTable, eq(presetsTable.id, presetDocumentsTable.presetId))
    .where(
      and(
        eq(presetDocumentsTable.presetId, presetId),
        eq(presetsTable.userId, userId),
      ),
    );
  return rows.map((r) => r.id);
}

export function serializePreset(
  preset: Preset,
  documentIds: string[],
  isActive: boolean,
) {
  return {
    id: preset.id,
    name: preset.name,
    description: preset.description,
    profileSnapshot: preset.profileSnapshot,
    documentIds,
    isActive,
    createdAt: preset.createdAt.toISOString(),
    updatedAt: preset.updatedAt.toISOString(),
  };
}
