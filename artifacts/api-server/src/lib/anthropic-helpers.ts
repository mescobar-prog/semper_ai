import { anthropic } from "@workspace/integrations-anthropic-ai";
import type { Profile } from "@workspace/db";
import { logger } from "./logger";

const MODEL = "claude-sonnet-4-6";

function profileSummary(profile: Profile | null): string {
  if (!profile) return "No structured profile data available yet.";
  const lines: string[] = [];
  if (profile.branch) lines.push(`Branch: ${profile.branch}`);
  if (profile.rank) lines.push(`Rank: ${profile.rank}`);
  if (profile.mosCode) lines.push(`MOS/Rate/AFSC: ${profile.mosCode}`);
  if (profile.dutyTitle) lines.push(`Duty title: ${profile.dutyTitle}`);
  if (profile.unit) lines.push(`Unit: ${profile.unit}`);
  if (profile.baseLocation) lines.push(`Base/location: ${profile.baseLocation}`);
  if (profile.securityClearance)
    lines.push(`Clearance: ${profile.securityClearance}`);
  if (profile.deploymentStatus)
    lines.push(`Deployment status: ${profile.deploymentStatus}`);
  if (profile.primaryMission) lines.push(`Mission: ${profile.primaryMission}`);
  if (profile.aiUseCases?.length)
    lines.push(`AI use cases: ${profile.aiUseCases.join(", ")}`);
  if (profile.freeFormContext)
    lines.push(`Free-form context:\n${profile.freeFormContext}`);
  return lines.length ? lines.join("\n") : "No structured profile data yet.";
}

export interface ProfileChatTurn {
  role: "user" | "assistant";
  content: string;
}

export interface ProfileChatResult {
  reply: string;
  suggestedProfile: Record<string, unknown> | null;
}

const PROFILE_FIELDS = [
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
] as const;

export async function runProfileChat(
  history: ProfileChatTurn[],
  currentProfile: Profile | null,
): Promise<ProfileChatResult> {
  const systemPrompt = `You are an intake assistant for a U.S. Department of Defense AI Tool Marketplace. Your job is to help a service member build a structured profile that AI tools will use to provide personalized, mission-relevant outputs.

Current profile data:
${profileSummary(currentProfile)}

Available structured fields you can populate:
- branch (army, navy, marines, air_force, space_force, coast_guard)
- rank (e.g. "E-5 Sergeant", "O-3 Captain")
- mosCode (MOS/Rate/AFSC code)
- dutyTitle (current duty title or billet)
- unit (current unit)
- baseLocation (current base/station)
- securityClearance (none, secret, top_secret, ts_sci)
- deploymentStatus (garrison, deployed, training, transitioning)
- primaryMission (1-2 sentence mission statement)
- aiUseCases (array of strings — what they want AI to help with)
- freeFormContext (any narrative context not captured elsewhere)

Conversation rules:
- Be warm, brief, and respectful. Address them as a professional colleague.
- Ask ONE focused question per turn, building on what they've already shared.
- When they provide new information, acknowledge it briefly and probe deeper or move to the next topic.
- Never invent details. Only suggest profile updates for things they explicitly told you.
- Once a topic is covered, move on. Do not re-ask known fields.

Output format (CRITICAL):
- First, write your conversational reply as plain text.
- Then, if the user's most recent message contains new structured information, append the literal separator on its own line:
  ---PROFILE---
- Followed by a JSON object containing ONLY the fields you learned new values for (omit unchanged fields). Use the exact field names listed above. For aiUseCases, use a string array. Do not include the separator or JSON if no structured updates were made.
- Never put the separator inside your reply text.`;

  const messages = history.map((m) => ({
    role: m.role,
    content: m.content,
  }));

  const response = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 1024,
    system: systemPrompt,
    messages,
  });

  const textBlock = response.content.find((b) => b.type === "text");
  const raw = textBlock && "text" in textBlock ? textBlock.text : "";

  const sepIdx = raw.indexOf("---PROFILE---");
  if (sepIdx === -1) {
    return { reply: raw.trim(), suggestedProfile: null };
  }

  const reply = raw.slice(0, sepIdx).trim();
  const jsonPart = raw.slice(sepIdx + "---PROFILE---".length).trim();

  let suggestedProfile: Record<string, unknown> | null = null;
  try {
    const cleaned = jsonPart
      .replace(/^```json\s*/i, "")
      .replace(/^```\s*/i, "")
      .replace(/\s*```$/i, "")
      .trim();
    const parsed = JSON.parse(cleaned);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const filtered: Record<string, unknown> = {};
      for (const k of PROFILE_FIELDS) {
        if (k in parsed && parsed[k] !== undefined) filtered[k] = parsed[k];
      }
      if (Object.keys(filtered).length) suggestedProfile = filtered;
    }
  } catch (err) {
    logger.warn({ err, jsonPart }, "Failed to parse profile suggestion JSON");
  }

  return { reply: reply || raw.trim(), suggestedProfile };
}

/**
 * Resolve admin-authored {curlies} placeholders in RAG query templates against
 * a launching user's profile. Templates with unresolved variables are dropped
 * silently — that field just isn't on the profile yet.
 */
function resolveTemplate(template: string, profile: Profile | null): string | null {
  const lookup: Record<string, string> = {};
  if (profile?.primaryMission) lookup.primaryMission = profile.primaryMission;
  if (profile?.dutyTitle) lookup.dutyTitle = profile.dutyTitle;
  if (profile?.mosCode) lookup.mosCode = profile.mosCode;
  if (profile?.unit) lookup.unit = profile.unit;
  if (profile?.branch) lookup.branch = profile.branch;
  if (profile?.rank) lookup.rank = profile.rank;
  if (profile?.baseLocation) lookup.baseLocation = profile.baseLocation;
  if (profile?.aiUseCases?.length)
    lookup.aiUseCases = profile.aiUseCases.join(" ");

  let unresolved = false;
  const out = template.replace(/\{(\w+)\}/g, (_m, key) => {
    const v = lookup[key];
    if (v == null || v === "") {
      unresolved = true;
      return "";
    }
    return v;
  });
  if (unresolved) return null;
  const trimmed = out.replace(/\s+/g, " ").trim();
  return trimmed.length ? trimmed : null;
}

export interface RagToolDescriptor {
  name: string;
  vendor: string;
  shortDescription: string;
  longDescription: string;
  /** Admin-authored sentence describing what the tool actually does with the user's context. */
  purpose?: string;
  /** Admin-authored seed query templates with {curlies} placeholders. */
  ragQueryTemplates?: string[];
}

export async function generateRagQueries(
  profile: Profile | null,
  toolDesc: RagToolDescriptor,
): Promise<string[]> {
  const profileQueries: string[] = [];
  if (profile?.primaryMission) profileQueries.push(profile.primaryMission);
  if (profile?.dutyTitle && profile?.mosCode) {
    profileQueries.push(`${profile.dutyTitle} ${profile.mosCode}`);
  } else if (profile?.dutyTitle) {
    profileQueries.push(profile.dutyTitle);
  } else if (profile?.mosCode) {
    profileQueries.push(profile.mosCode);
  }
  if (profile?.aiUseCases && profile.aiUseCases.length > 0) {
    profileQueries.push(profile.aiUseCases.slice(0, 3).join(" "));
  }
  if (profile?.unit) profileQueries.push(profile.unit);

  // Admin-authored templates with profile-variable interpolation. These are
  // the catalog admin's hand-picked RAG queries for THIS specific tool.
  const templateQueries: string[] = [];
  for (const tpl of toolDesc.ragQueryTemplates ?? []) {
    const resolved = resolveTemplate(tpl, profile);
    if (resolved) templateQueries.push(resolved);
  }

  const purposeLine = toolDesc.purpose?.trim()
    ? `Tool's actual purpose (admin-authored): ${toolDesc.purpose.trim()}`
    : "";

  const systemPrompt = `You generate short search queries to retrieve relevant context from a U.S. service member's personal doctrine/SOP/reference library. The queries will be used against a Postgres full-text search index.

Rules:
- Output 3-5 distinct queries.
- Each query must be 2-6 keywords — no full sentences, no stop words like "the" or "a".
- Each query should target a different angle (mission context, tactics, regulations, equipment, role-specific terminology, etc.).
- At least one query MUST reuse keywords directly from the user's profile (mission, duty title, MOS, unit) so we retrieve their personal SOPs/docs.
- Heavily prioritize the admin-authored "tool purpose" if provided — that describes what the tool actually does with the user's context.
- Bias toward terminology that would actually appear in DoD documents the user might have uploaded.
- Output ONLY a JSON object: {"queries": ["...", "..."]}. No prose, no markdown fences.`;

  const userPrompt = `User profile:
${profileSummary(profile)}

Tool the user is launching:
Name: ${toolDesc.name}
Vendor: ${toolDesc.vendor}
Short description: ${toolDesc.shortDescription}
Long description: ${toolDesc.longDescription}
${purposeLine}

Generate the JSON object now.`;

  let llmQueries: string[] = [];
  try {
    const response = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 400,
      system: systemPrompt,
      messages: [{ role: "user", content: userPrompt }],
    });
    const textBlock = response.content.find((b) => b.type === "text");
    const raw = textBlock && "text" in textBlock ? textBlock.text : "";
    const cleaned = raw
      .replace(/^```json\s*/i, "")
      .replace(/^```\s*/i, "")
      .replace(/\s*```$/i, "")
      .trim();
    const parsed = JSON.parse(cleaned);
    if (parsed && Array.isArray(parsed.queries)) {
      llmQueries = parsed.queries
        .filter((q: unknown): q is string => typeof q === "string" && q.trim().length > 0)
        .map((q: string) => q.trim())
        .slice(0, 5);
    }
  } catch (err) {
    logger.warn({ err }, "RAG query generation failed; falling back to profile-only queries");
  }

  // Always merge admin-authored templates (highest priority — these are
  // hand-tuned for this tool), profile-derived queries, and LLM-generated
  // queries. Templates and profile queries are guaranteed to recall the
  // user's personal docs even if the LLM drifts.
  const merged: string[] = [];
  const seen = new Set<string>();
  for (const q of [...templateQueries, ...profileQueries, ...llmQueries]) {
    const key = q.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(q);
  }
  if (merged.length === 0) {
    if (toolDesc.shortDescription) merged.push(toolDesc.shortDescription);
    if (toolDesc.name) merged.push(toolDesc.name);
  }
  return merged.slice(0, 8);
}
