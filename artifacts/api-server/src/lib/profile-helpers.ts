import { and, asc, eq, sql } from "drizzle-orm";
import {
  db,
  profilesTable,
  presetsTable,
  presetDocumentsTable,
  contextBlocksTable,
  type Preset,
  type PresetProfileSnapshot,
  type Profile,
  type ContextBlock,
  type ContextBlockScores,
} from "@workspace/db";
import { findCommand } from "@workspace/mil-data";

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

// Identity / persistent profile fields tracked for completeness. The 6-element
// Context Block lives in its own table and contributes to completeness via the
// helper below.
const TRACKED_PROFILE_FIELDS: Array<keyof Profile> = [
  "branch",
  "rank",
  "mosCode",
  "dutyTitle",
  "unit",
  "baseLocation",
  "securityClearance",
  "deploymentStatus",
  "command",
  "billets",
  "freeFormContext",
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
  "command",
  "billets",
  "freeFormContext",
];

const TRACKED_CB_FIELDS: Array<keyof ContextBlock> = [
  "doctrine",
  "intent",
  "environment",
  "constraints",
  "risk",
  "experience",
];

export function completenessPct(
  profile: Profile | null,
  contextBlock: ContextBlock | null,
): number {
  const total = TRACKED_PROFILE_FIELDS.length + TRACKED_CB_FIELDS.length;
  if (!profile && !contextBlock) return 0;
  let filled = 0;
  if (profile) {
    for (const f of TRACKED_PROFILE_FIELDS) {
      const v = profile[f];
      if (Array.isArray(v)) {
        if (v.length > 0) filled++;
      } else if (typeof v === "string") {
        if (v.trim()) filled++;
      }
    }
  }
  if (contextBlock) {
    for (const f of TRACKED_CB_FIELDS) {
      const v = contextBlock[f];
      if (typeof v === "string" && v.trim()) filled++;
    }
  }
  return Math.round((filled / total) * 100);
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
    .values({ userId, billets: [] })
    .returning();
  return created;
}

// The Context Block's "Doctrine & Orders" textarea (Task #85) embeds one
// `<<< doc:<id> >>> … <<< /doc >>>` block per document the operator ticked
// in the doctrine picker. This regex pulls those ids back out so we can
// scope launch-time RAG (Task #88) to the doctrine the operator already
// affirmed as relevant for this tasking.
const DOCTRINE_DOC_ID_RE = /<<<\s*doc:([^\s>]+)\s*>>>/g;

export function parseSelectedDoctrineDocIds(
  doctrine: string | null | undefined,
): string[] {
  if (!doctrine) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  // Reset lastIndex defensively — the regex literal is module-scoped.
  DOCTRINE_DOC_ID_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = DOCTRINE_DOC_ID_RE.exec(doctrine))) {
    const id = m[1];
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

export async function getOrCreateContextBlock(
  userId: string,
): Promise<ContextBlock> {
  const existing = await db
    .select()
    .from(contextBlocksTable)
    .where(eq(contextBlocksTable.userId, userId))
    .limit(1);
  if (existing[0]) return existing[0];

  const [created] = await db
    .insert(contextBlocksTable)
    .values({ userId })
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
  // Monotonic version (bumped on every edit / re-confirm). The launch-time
  // affirmation gate (Task #45) keys on this so any change automatically
  // invalidates an outstanding affirmation.
  version: number;
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
  cb: ContextBlock | null,
): SerializedContextBlockState {
  if (!cb) {
    return {
      doctrine: null,
      intent: null,
      environment: null,
      constraints: null,
      risk: null,
      experience: null,
      confirmedAt: null,
      lastEvaluation: null,
      version: 1,
    };
  }
  const lastEvaluation: SerializedContextBlockEvaluation | null =
    cb.scoreTotal != null && cb.scores && cb.status
      ? {
          submissionId: cb.submissionId ?? "",
          scores: cb.scores,
          totalScore: cb.scoreTotal,
          status: cb.status,
          opsecFlag: cb.opsecFlag === "true",
          flags: cb.flags ?? "None",
        }
      : null;
  return {
    doctrine: cb.doctrine,
    intent: cb.intent,
    environment: cb.environment,
    constraints: cb.constraints,
    risk: cb.risk,
    experience: cb.experience,
    confirmedAt: cb.confirmedAt ? cb.confirmedAt.toISOString() : null,
    lastEvaluation,
    version: cb.version ?? 1,
  };
}

export function hasConfirmedContextBlock(cb: ContextBlock | null): boolean {
  if (!cb || !cb.confirmedAt) return false;
  // All 6 elements must have been filled at confirm time.
  return [
    cb.doctrine,
    cb.intent,
    cb.environment,
    cb.constraints,
    cb.risk,
    cb.experience,
  ].every((v) => typeof v === "string" && v.trim().length > 0);
}

/**
 * Build a tool-friendly Markdown context block for a launching user. Tool
 * builders can drop this string directly into their model prompt without
 * re-parsing the structured profile JSON. Sections that have no data are
 * omitted so the block stays tight. The Markdown sources from BOTH the
 * persistent profile (identity, billets, command, …) and the latest
 * context_block row (the 6 elements + evaluation).
 */
export function buildContextBlock(
  user: { displayName: string; email: string | null },
  profile: Profile | null,
  contextBlock: ContextBlock | null,
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
  if (profile?.command) {
    const cmd = findCommand(profile.command);
    identity.push(
      `- Command: ${cmd ? `${cmd.code} (${cmd.name})` : profile.command}`,
    );
  }
  if (profile?.billets && profile.billets.length > 0) {
    identity.push(`- Billets: ${profile.billets.join("; ")}`);
  }
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

  if (profile?.freeFormContext && profile.freeFormContext.trim()) {
    lines.push("## Additional context");
    lines.push(profile.freeFormContext.trim());
    lines.push("");
    appendedSection = true;
  }

  // 6-element Context Block (verification gate). Only render when the
  // operator has actually confirmed one. Otherwise drop a one-line note so
  // tool builders know the gate has not been cleared yet.
  if (hasConfirmedContextBlock(contextBlock)) {
    const score = contextBlock!.scoreTotal;
    const status = contextBlock!.status;
    const confirmedAt = contextBlock!.confirmedAt!.toISOString();
    lines.push("## Context Block");
    lines.push(
      `_Confirmed ${confirmedAt} · evaluator score ${score ?? "?"} /12 · status ${status ?? "?"}_`,
    );
    lines.push("");
    lines.push("### 1. Doctrine & Orders");
    lines.push(contextBlock!.doctrine!.trim());
    lines.push("");
    lines.push("### 2. Commander's Intent");
    lines.push(contextBlock!.intent!.trim());
    lines.push("");
    lines.push("### 3. Environment");
    lines.push(contextBlock!.environment!.trim());
    lines.push("");
    lines.push("### 4. Constraints & Limitations");
    lines.push(contextBlock!.constraints!.trim());
    lines.push("");
    lines.push("### 5. Risk");
    lines.push(contextBlock!.risk!.trim());
    lines.push("");
    lines.push("### 6. Experience & Judgment");
    lines.push(contextBlock!.experience!.trim());
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
    command: profile.command ?? null,
    billets: Array.isArray(profile.billets) ? profile.billets : [],
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
    command: null,
    billets: [],
    freeFormContext: null,
  };
}

/**
 * Build a "Profile-shaped" object whose identity fields come from a preset
 * snapshot, while live-only fields (activePresetId, isAdmin, updatedAt)
 * fall back to the live profile. Used by launch flows where the preset's
 * snapshot drives identity but the user's confirmed Context Block lives in
 * its own table.
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
    command: snap.command,
    billets: snap.billets ?? [],
    freeFormContext: snap.freeFormContext,
  };
}

export function serializeProfile(
  profile: Profile,
  contextBlock: ContextBlock | null,
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
    command: profile.command,
    billets: profile.billets ?? [],
    freeFormContext: profile.freeFormContext,
    isAdmin: profile.isAdmin === "true",
    viewMode:
      profile.isAdmin === "true" && profile.viewMode === "operator"
        ? "operator"
        : "admin",
    activePresetId: activePresetId ?? profile.activePresetId ?? null,
    launchPreference:
      profile.launchPreference === "direct" ? "direct" : "preview",
    completenessPct: completenessPct(profile, contextBlock),
    updatedAt: profile.updatedAt.toISOString(),
  };
}

// Comma-separated list of operator emails (case-insensitive) that should
// be auto-promoted to admin when they sign in. Reading the env var on each
// call keeps tests + dev workflows simple — there is no caching.
export function getAdminEmails(): string[] {
  const raw = process.env.ADMIN_EMAILS;
  if (!raw) return [];
  return raw
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter((e) => e.length > 0);
}

export function isAdminEmail(email: string | null | undefined): boolean {
  if (!email) return false;
  const list = getAdminEmails();
  if (list.length === 0) return false;
  return list.includes(email.trim().toLowerCase());
}

/**
 * If the given user's email is on the configured admin list and their
 * profile is not yet flagged as admin, set is_admin=true. Idempotent —
 * repeated logins are safe and never demote an already-admin account.
 * If the env var is unset/empty, this is a no-op.
 */
export async function autoPromoteAdminIfListed(
  userId: string,
  email: string | null | undefined,
): Promise<void> {
  if (!isAdminEmail(email)) return;
  // Make sure a profile row exists, then flip the flag if it's not already
  // true. The conditional WHERE keeps this idempotent on re-login.
  await getOrCreateProfile(userId);
  await db
    .update(profilesTable)
    .set({ isAdmin: "true" })
    .where(
      and(
        eq(profilesTable.userId, userId),
        sql`${profilesTable.isAdmin} <> 'true'`,
      ),
    );
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

// Profile field keys eligible to be shared with a launching tool, plus
// human-readable labels. Order is the order shown in the preview UI.
export const SHAREABLE_PROFILE_FIELDS: Array<{
  key: keyof Profile;
  label: string;
}> = [
  { key: "branch", label: "Branch" },
  { key: "rank", label: "Rank" },
  { key: "mosCode", label: "MOS / Rate / AFSC" },
  { key: "dutyTitle", label: "Duty title" },
  { key: "unit", label: "Unit" },
  { key: "baseLocation", label: "Base / location" },
  { key: "securityClearance", label: "Security clearance" },
  { key: "deploymentStatus", label: "Deployment status" },
  { key: "command", label: "Combatant command" },
  { key: "billets", label: "Billets" },
  { key: "freeFormContext", label: "Free-form context" },
];

export function profileFieldDisplayValue(
  profile: Profile,
  key: keyof Profile,
): { value: string; hasValue: boolean } {
  const raw = profile[key] as unknown;
  if (Array.isArray(raw)) {
    const arr = raw as string[];
    return { value: arr.join(", "), hasValue: arr.length > 0 };
  }
  if (typeof raw === "string") {
    return { value: raw, hasValue: raw.trim().length > 0 };
  }
  return { value: "", hasValue: false };
}

// Build a Profile-shaped object containing only the allow-listed field keys;
// every other shareable field is set to null (or [] for billets) so the
// receiving tool sees a stable shape with explicit "redacted" markers.
export function redactProfileForLaunch(
  profile: Profile,
  allowedKeys: ReadonlyArray<string>,
): Profile {
  const allowed = new Set(allowedKeys);
  const out: Profile = { ...profile };
  for (const { key } of SHAREABLE_PROFILE_FIELDS) {
    if (allowed.has(key as string)) continue;
    if (key === "billets") {
      (out as Record<string, unknown>)[key] = [];
    } else {
      (out as Record<string, unknown>)[key] = null;
    }
  }
  return out;
}
