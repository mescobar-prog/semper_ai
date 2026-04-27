import { eq } from "drizzle-orm";
import { db, profilesTable, type Profile } from "@workspace/db";

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
