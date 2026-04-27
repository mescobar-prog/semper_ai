import { eq } from "drizzle-orm";
import { db, profilesTable, type Profile } from "@workspace/db";

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

  if (!appendedSection) {
    // No profile sections were appended at all — the operator hasn't filled
    // in any structured fields. Make that explicit to the tool, regardless of
    // whether we have an email line.
    lines.push(
      "_The operator has not yet completed their structured profile. Ask them about their role, mission, and unit before producing personalized output._",
    );
  }

  return lines.join("\n").trim() + "\n";
}

export function serializeProfile(profile: Profile) {
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
    completenessPct: completenessPct(profile),
    updatedAt: profile.updatedAt.toISOString(),
  };
}
