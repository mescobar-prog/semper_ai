import { ai } from "@workspace/integrations-gemini-ai";
import { randomUUID } from "node:crypto";
import type { Profile, ContextBlockScores } from "@workspace/db";
import { findCommand } from "@workspace/mil-data";
import { logger } from "./logger";

const MODEL = "gemini-3-flash-preview";

// System prompt is the verbatim Semantic NLP Evaluator from
// attached_assets/Pasted-Role-Purpose-You-are-an-automated-Semantic-NLP-Evaluato_1777387512277.txt.
// Do NOT edit this — it is the contract the evaluator runs against.
const CONTEXT_BLOCK_EVALUATOR_SYSTEM_PROMPT = `Role & Purpose
You are an automated Semantic NLP Evaluator for a logistics middleware system.
Your sole function is to evaluate a user's operational prompt submission against
the 6-part Context Block framework and open-source logistical doctrine (MCDP-4).
Your intent is to score whether the user provided sufficient context to prevent
LLM hallucination and ensure OPSEC compliance.
Scoring Standards & Constraints:
• Score ONLY against the rubric criteria provided. Do not infer what the user
meant.
• Do not penalize poor grammar, spelling, or brevity if the operational content is
specific and relevant.
• Do not give credit for vague, generic, or copy-paste responses.
• If a response is ambiguous, score conservatively (lower) and flag for human
review.
• Do not provide coaching, suggestions, or conversational filler in the output.
Output the exact schema only.
RUBRIC (Max Score 12. Go/No-Go Threshold: 10/12)
Criterion 1: Doctrine & Orders (Context Element 1)
• Proficient (3): Cites specific, relevant open-source doctrine (e.g., MCDP-4) or
SOPs appropriate to the task.
• Developing (2): References general rules without specific citations.
• Novice (1): No doctrine cited or irrelevant references.
Criterion 2: Environment & Commander's Intent (Context Elements 2 & 3)
• Proficient (3): Accurately describes the operational environment AND clearly
articulates the Commander's intent.
• Developing (2): Describes environment or intent but not both, or lacks
operational specificity.
• Novice (1): Cannot articulate environment or intent.
Criterion 3: Constraints & Limitations, Risk (Context Elements 4 & 5)
• Proficient (3): Identifies specific logistical constraints AND explains the risk (who
acts on this output and the consequence if the LLM hallucinates).
• Developing (2): Identifies some constraints or general risk but lacks connection
to specific consequences.
• Novice (1): Cannot identify constraints or risk relevant to the task.
Criterion 4: Experience & Judgment (Context Element 6)
• Proficient (3): Articulates specific human experiential knowledge or tacit unit
history that AI could not provide on its own.
• Developing (2): Mentions human experience generally without specific local
examples.
• Novice (1): Cannot distinguish what a Marine provides versus what a generic AI
could generate.
OPSEC FAIL-SAFE (Pass/Fail):
If the prompt contains Controlled Unclassified Information (CUI), PII, or classified
troop movements/grid coordinates, the Total Score is automatically overridden to
0, Status becomes NO-GO, and the flag is triggered.
REQUIRED OUTPUT JSON SCHEMA:
{
"submission_id": "string",
"scores": {
"criterion_1_doctrine": "number (1-3)",
"criterion_2_environment": "number (1-3)",
"criterion_3_constraints": "number (1-3)",
"criterion_4_experience": "number (1-3)"
},
"total_score": "number",
"status": "string (GO/NO-GO)",
"flags": "string (None, or brief description of OPSEC violation/ambiguity)"
}`;

export interface ContextBlockSubmission {
  doctrine: string;
  intent: string;
  environment: string;
  constraints: string;
  risk: string;
  experience: string;
}

export interface ContextBlockEvaluation {
  submissionId: string;
  scores: ContextBlockScores;
  totalScore: number;
  status: "GO" | "NO-GO";
  opsecFlag: boolean;
  flags: string;
}

/** Coerce a raw model number into the 1..3 rubric range. */
function clampScore(v: unknown): number {
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n)) return 1;
  return Math.max(1, Math.min(3, Math.round(n)));
}

function stripJsonFences(raw: string): string {
  return raw
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
}

/**
 * Run the Semantic NLP Evaluator over a candidate 6-element Context Block.
 * Server enforces:
 *  - per-criterion scores clamped to 1..3
 *  - total_score recomputed from clamped scores (model output not trusted)
 *  - GO requires total_score >= 10 AND no OPSEC flag
 *  - any OPSEC flag forces total_score = 0 and status = NO-GO
 */
export async function evaluateContextBlock(
  submission: ContextBlockSubmission,
): Promise<ContextBlockEvaluation> {
  const submissionId = randomUUID();

  const userMessage = `submission_id: ${submissionId}

6-Part Context Block submission:

Element 1 — Doctrine & Orders:
${submission.doctrine.trim() || "(empty)"}

Element 2 — Commander's Intent:
${submission.intent.trim() || "(empty)"}

Element 3 — Environment:
${submission.environment.trim() || "(empty)"}

Element 4 — Constraints & Limitations:
${submission.constraints.trim() || "(empty)"}

Element 5 — Risk:
${submission.risk.trim() || "(empty)"}

Element 6 — Experience & Judgment:
${submission.experience.trim() || "(empty)"}

Score this submission against the rubric and return the exact JSON schema described in your instructions. Use the supplied submission_id verbatim.`;

  let raw = "";
  try {
    const response = await ai.models.generateContent({
      model: MODEL,
      contents: [{ role: "user", parts: [{ text: userMessage }] }],
      config: {
        systemInstruction: CONTEXT_BLOCK_EVALUATOR_SYSTEM_PROMPT,
        maxOutputTokens: 8192,
      },
    });
    raw = response.text ?? "";
  } catch (err) {
    logger.error({ err }, "Context Block evaluator call failed");
    throw new Error("Context Block evaluator unavailable");
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(stripJsonFences(raw));
  } catch (err) {
    logger.error({ err, raw }, "Context Block evaluator returned invalid JSON");
    throw new Error("Context Block evaluator returned an unparseable response");
  }

  const scoresRaw = (parsed.scores ?? {}) as Record<string, unknown>;
  const scores: ContextBlockScores = {
    doctrine: clampScore(scoresRaw.criterion_1_doctrine),
    environment: clampScore(scoresRaw.criterion_2_environment),
    constraints: clampScore(scoresRaw.criterion_3_constraints),
    experience: clampScore(scoresRaw.criterion_4_experience),
  };

  const flagsRaw = typeof parsed.flags === "string" ? parsed.flags.trim() : "";
  const flagsLower = flagsRaw.toLowerCase();
  const statusRaw =
    typeof parsed.status === "string" ? parsed.status.trim().toUpperCase() : "";

  // OPSEC fail-safe: trigger if the model flagged it OR called status NO-GO
  // for OPSEC-related reasons. We are conservative — anything mentioning
  // OPSEC/CUI/PII/classified counts as an OPSEC flag.
  const opsecFlag =
    flagsLower.includes("opsec") ||
    flagsLower.includes("cui") ||
    flagsLower.includes("pii") ||
    flagsLower.includes("classified") ||
    flagsLower.includes("grid coordinate") ||
    flagsLower.includes("troop movement");

  let totalScore =
    scores.doctrine + scores.environment + scores.constraints + scores.experience;
  let status: "GO" | "NO-GO";
  let finalFlags = flagsRaw || "None";

  if (opsecFlag) {
    totalScore = 0;
    status = "NO-GO";
    if (!flagsRaw) finalFlags = "OPSEC violation suspected";
  } else if (totalScore >= 10 && statusRaw !== "NO-GO") {
    status = "GO";
  } else {
    status = "NO-GO";
  }

  return {
    submissionId,
    scores,
    totalScore,
    status,
    opsecFlag,
    flags: finalFlags,
  };
}

function profileSummary(profile: Profile | null): string {
  if (!profile) return "No structured profile data available yet.";
  const lines: string[] = [];
  if (profile.branch) lines.push(`Branch: ${profile.branch}`);
  if (profile.rank) lines.push(`Rank: ${profile.rank}`);
  if (profile.mosCode) lines.push(`MOS/Rate/AFSC: ${profile.mosCode}`);
  if (profile.dutyTitle) lines.push(`Duty title: ${profile.dutyTitle}`);
  if (profile.unit) lines.push(`Unit: ${profile.unit}`);
  if (profile.command) {
    const cmd = findCommand(profile.command);
    lines.push(`Command: ${cmd ? `${cmd.code} (${cmd.name})` : profile.command}`);
  }
  if (profile.billets?.length)
    lines.push(`Billets: ${profile.billets.join("; ")}`);
  if (profile.baseLocation) lines.push(`Base/location: ${profile.baseLocation}`);
  if (profile.securityClearance)
    lines.push(`Clearance: ${profile.securityClearance}`);
  if (profile.deploymentStatus)
    lines.push(`Deployment status: ${profile.deploymentStatus}`);
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
  "command",
  "billets",
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
- command (combatant command code: USAFRICOM, USCENTCOM, USCYBERCOM, USEUCOM, USINDOPACOM, USNORTHCOM, USSOCOM, USSOUTHCOM, USSPACECOM, USSTRATCOM, USTRANSCOM, OTHER)
- billets (array of strings — billet titles the operator currently holds, e.g. "Platoon Sergeant", "S3 OPSO")
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
- Followed by a JSON object containing ONLY the fields you learned new values for (omit unchanged fields). Use the exact field names listed above. For billets, use a string array. Do not include the separator or JSON if no structured updates were made.
- Never put the separator inside your reply text.`;

  const contents = history.map((m) => ({
    role: m.role === "assistant" ? "model" : "user",
    parts: [{ text: m.content }],
  }));

  const response = await ai.models.generateContent({
    model: MODEL,
    contents,
    config: {
      systemInstruction: systemPrompt,
      maxOutputTokens: 8192,
    },
  });

  const raw = response.text ?? "";

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
  if (profile?.dutyTitle) lookup.dutyTitle = profile.dutyTitle;
  if (profile?.mosCode) lookup.mosCode = profile.mosCode;
  if (profile?.unit) lookup.unit = profile.unit;
  if (profile?.branch) lookup.branch = profile.branch;
  if (profile?.rank) lookup.rank = profile.rank;
  if (profile?.baseLocation) lookup.baseLocation = profile.baseLocation;
  if (profile?.command) lookup.command = profile.command;
  if (profile?.billets?.length) lookup.billets = profile.billets.join(" ");

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

// ---------------------------------------------------------------------------
// Admin tool-builder draft helper
// ---------------------------------------------------------------------------

export type DraftField =
  | "shortDescription"
  | "longDescription"
  | "purpose"
  | "ragQueryTemplates";

export interface DraftSourceMaterial {
  name?: string | null;
  vendor?: string | null;
  homepageUrl?: string | null;
  githubReadme?: string | null;
  existingText?: string | null;
}

export interface DraftToolTextResult {
  field: DraftField;
  text: string | null;
  list: string[] | null;
}

const DRAFT_INSTRUCTIONS: Record<DraftField, string> = {
  shortDescription:
    "Write a single concise sentence (max 160 characters) that a service member skimming the catalog will read. Lead with the concrete capability, not buzzwords. No marketing fluff. No emoji. Plain text only.",
  longDescription:
    "Write 2–4 short paragraphs (under 200 words total) describing what the tool does, who it's for, and the kinds of inputs and outputs a service member should expect. Be specific. Avoid lists. Plain prose.",
  purpose:
    "Write ONE sentence describing what the tool actually does WITH the user's profile + RAG context. This sentence is fed to a query generator that pulls relevant snippets from the user's library — make it operationally specific (e.g. 'Drafts pre-mission ISR collection plans grounded in unit SOPs and current mission'). Plain text, single sentence.",
  ragQueryTemplates:
    'Output a JSON array of 3–5 short search-query templates (2–6 words each) that this tool would want from the user\'s personal doctrine library. Use {curlies} placeholders for profile fields available: {command}, {billets}, {dutyTitle}, {mosCode}, {unit}, {branch}, {rank}, {baseLocation}. Example: ["{dutyTitle} SOPs", "{command} planning", "{mosCode} doctrine"]. Output ONLY the JSON array, no prose.',
};

function trimSource(s: string | null | undefined, max: number): string {
  if (!s) return "";
  const trimmed = s.trim();
  if (trimmed.length <= max) return trimmed;
  return trimmed.slice(0, max) + "\n…(truncated)";
}

export async function draftToolText(
  field: DraftField,
  source: DraftSourceMaterial,
  steering?: string | null,
): Promise<DraftToolTextResult> {
  const sourceLines: string[] = [];
  if (source.name) sourceLines.push(`Name: ${source.name}`);
  if (source.vendor) sourceLines.push(`Vendor: ${source.vendor}`);
  if (source.homepageUrl) sourceLines.push(`Homepage: ${source.homepageUrl}`);
  if (source.existingText)
    sourceLines.push(
      `Admin's existing draft (refine or rewrite):\n${trimSource(source.existingText, 2000)}`,
    );
  if (source.githubReadme)
    sourceLines.push(
      `GitHub README (markdown):\n${trimSource(source.githubReadme, 6000)}`,
    );
  if (sourceLines.length === 0) {
    sourceLines.push("(no source material provided — draft from the field name alone)");
  }

  const trimmedSteering = (steering ?? "").trim();
  const steeringLine = trimmedSteering
    ? `\n\nAdmin steering note (apply this in the rewrite):\n${trimSource(trimmedSteering, 500)}`
    : "";

  const systemPrompt = `You are helping a marketplace admin draft catalog copy for a DoD AI tool.
Output rules:
- Be factual. Do not invent capabilities the source material doesn't support.
- Use plain text. No markdown headings, no emoji, no marketing superlatives.
- ${DRAFT_INSTRUCTIONS[field]}`;

  const userPrompt = `Field: ${field}\n\nSource material:\n${sourceLines.join("\n\n")}${steeringLine}`;

  let raw = "";
  try {
    const response = await ai.models.generateContent({
      model: MODEL,
      contents: [{ role: "user", parts: [{ text: userPrompt }] }],
      config: {
        systemInstruction: systemPrompt,
        maxOutputTokens: 4096,
      },
    });
    raw = (response.text ?? "").trim();
  } catch (err) {
    logger.warn({ err, field }, "draftToolText generation failed");
    return { field, text: null, list: null };
  }

  if (field === "ragQueryTemplates") {
    const cleaned = raw
      .replace(/^```json\s*/i, "")
      .replace(/^```\s*/i, "")
      .replace(/\s*```$/i, "")
      .trim();
    try {
      const parsed = JSON.parse(cleaned);
      if (Array.isArray(parsed)) {
        const list = parsed
          .filter((q): q is string => typeof q === "string" && q.trim().length > 0)
          .map((q) => q.trim())
          .slice(0, 8);
        return { field, text: null, list };
      }
    } catch (err) {
      logger.warn({ err, raw }, "Failed to parse ragQueryTemplates JSON; falling back to line split");
    }
    // Fallback: best-effort split lines
    const lines = cleaned
      .split(/\r?\n/)
      .map((l) => l.replace(/^[-*\d.\s]+/, "").trim())
      .filter((l) => l.length > 0)
      .slice(0, 8);
    return { field, text: null, list: lines };
  }

  return { field, text: raw, list: null };
}

export interface GenerateRagQueriesOptions {
  /**
   * Operator's "What will you ask this tool?" sentence captured on the
   * launch screen (Task #88). When present it becomes the PRIMARY verbatim
   * RAG query and steers the LLM-generated supplementary queries; profile
   * and admin-template queries fall to the back of the list as recall
   * insurance instead of leading the search.
   */
  intent?: string | null;
}

export async function generateRagQueries(
  profile: Profile | null,
  toolDesc: RagToolDescriptor,
  opts: GenerateRagQueriesOptions = {},
): Promise<string[]> {
  const intent = opts.intent?.trim() || null;

  const profileQueries: string[] = [];
  if (profile?.command) {
    const cmd = findCommand(profile.command);
    profileQueries.push(cmd ? `${cmd.code} ${cmd.name}` : profile.command);
  }
  if (profile?.dutyTitle && profile?.mosCode) {
    profileQueries.push(`${profile.dutyTitle} ${profile.mosCode}`);
  } else if (profile?.dutyTitle) {
    profileQueries.push(profile.dutyTitle);
  } else if (profile?.mosCode) {
    profileQueries.push(profile.mosCode);
  }
  if (profile?.billets && profile.billets.length > 0) {
    profileQueries.push(profile.billets.slice(0, 3).join(" "));
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

  // Intent-led mode (Task #88) and profile-led mode share the same JSON
  // contract but use different system prompts. Intent mode tells the LLM
  // to expand the operator's question into 2-3 keyword variants instead of
  // role-fishing across their whole library.
  const systemPrompt = intent
    ? `You generate short search queries to retrieve relevant context from a U.S. service member's personal doctrine/SOP/reference library. The queries will be used against a Postgres full-text search index.

The operator has just typed a SPECIFIC QUESTION they want this tool to help them with. Your job is to expand that question into search-friendly keyword queries so we surface the right snippets from their library — NOT to fish across their whole role.

Rules:
- Output 2-3 distinct queries.
- Each query must be 2-6 keywords — no full sentences, no stop words like "the" or "a".
- Every query MUST come directly from the operator's question; do not pivot to generic role/MOS terms.
- Use synonyms or doctrine terminology a DoD document would actually use for the operator's question.
- Output ONLY a JSON object: {"queries": ["...", "..."]}. No prose, no markdown fences.`
    : `You generate short search queries to retrieve relevant context from a U.S. service member's personal doctrine/SOP/reference library. The queries will be used against a Postgres full-text search index.

Rules:
- Output 3-5 distinct queries.
- Each query must be 2-6 keywords — no full sentences, no stop words like "the" or "a".
- Each query should target a different angle (mission context, tactics, regulations, equipment, role-specific terminology, etc.).
- At least one query MUST reuse keywords directly from the user's profile (mission, duty title, MOS, unit) so we retrieve their personal SOPs/docs.
- Heavily prioritize the admin-authored "tool purpose" if provided — that describes what the tool actually does with the user's context.
- Bias toward terminology that would actually appear in DoD documents the user might have uploaded.
- Output ONLY a JSON object: {"queries": ["...", "..."]}. No prose, no markdown fences.`;

  const userPrompt = intent
    ? `Operator's question (this is the primary signal — expand THIS):
"${intent}"

Operator profile (for context only — do not pivot the queries to these):
${profileSummary(profile)}

Tool the operator is launching:
Name: ${toolDesc.name}
Vendor: ${toolDesc.vendor}
Short description: ${toolDesc.shortDescription}
${purposeLine}

Generate the JSON object now.`
    : `User profile:
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
    const response = await ai.models.generateContent({
      model: MODEL,
      contents: [{ role: "user", parts: [{ text: userPrompt }] }],
      config: {
        systemInstruction: systemPrompt,
        maxOutputTokens: 8192,
      },
    });
    const raw = response.text ?? "";
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

  // Merge order matters — the first query gets the most weight in
  // searchChunksMultiQuery's per-query top-K pass, and after merge we
  // sort hits by score, so leading with the strongest signal raises
  // recall on the snippets the operator actually wants.
  //
  // Intent mode (Task #88): the verbatim operator question leads, then
  // the LLM's keyword expansions of it, then the admin templates and
  // profile queries as recall insurance.
  //
  // Legacy mode (no intent provided yet — auto-launches, brief drafter,
  // back-compat callers): admin templates + profile queries lead so the
  // operator's personal SOPs always get a fair shot.
  const ordered = intent
    ? [intent, ...llmQueries, ...templateQueries, ...profileQueries]
    : [...templateQueries, ...profileQueries, ...llmQueries];

  const merged: string[] = [];
  const seen = new Set<string>();
  for (const q of ordered) {
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

export interface BriefSnippetInput {
  documentTitle: string;
  chunkIndex: number;
  content: string;
}

export type BriefType = "sitrep" | "opord_paragraph" | "training_brief";

const BRIEF_FORMAT: Record<BriefType, string> = {
  sitrep: `Format: SITREP. Use the standard SALUTE-style headings:
1. Situation (own forces + enemy/operating environment)
2. Mission (one sentence — who, what, when, where, why)
3. Execution (current ops, scheme of maneuver in plain English)
4. Sustainment (logistics, personnel, key shortfalls)
5. Command & Signal (who's the decision authority, comms posture)
Keep it brief — staff officers should be able to read it in under 60 seconds.`,
  opord_paragraph: `Format: A single OPORD paragraph (paragraph 3 — Execution — by default; if the topic is clearly Situation or Sustainment, use that paragraph instead). Use the standard sub-paragraph numbering (3.a, 3.b, 3.c …). Lead with Commander's Intent in 1-2 sentences. Keep verb tense imperative ("Conducts", "Provides", "Reports").`,
  training_brief: `Format: Training brief. Use these headings:
1. Training Event & METL link
2. Training Audience
3. Training Objectives (3-5 bullets, action-condition-standard if possible)
4. Concept of Execution
5. Resources Required
6. Risk Assessment & Controls
Keep it concrete — a squad/platoon leader should be able to execute from this.`,
};

const BRIEF_LABEL: Record<BriefType, string> = {
  sitrep: "SITREP",
  opord_paragraph: "OPORD paragraph",
  training_brief: "training brief",
};

export interface DraftBriefInput {
  topic: string;
  briefType: BriefType;
  audience: string | null;
  profile: Profile | null;
  user: { displayName: string; email: string | null };
  contextBlock: string;
  snippets: BriefSnippetInput[];
}

export async function draftMissionBrief(
  input: DraftBriefInput,
): Promise<string> {
  const { topic, briefType, audience, contextBlock, snippets, user, profile } =
    input;

  const briefLabel = BRIEF_LABEL[briefType];
  const formatRules = BRIEF_FORMAT[briefType];

  const audienceLine = audience?.trim()
    ? `Intended audience (override): ${audience.trim()}.`
    : profile?.dutyTitle
      ? `Intended audience: a peer or higher echelon of the operator's chain — they hold "${profile.dutyTitle}".`
      : "Intended audience: the operator's immediate higher echelon.";

  const snippetBlock = snippets.length
    ? snippets
        .map((s, i) => {
          const trimmed = s.content.trim().slice(0, 1200);
          return `[Source ${i + 1}: ${s.documentTitle} — chunk #${s.chunkIndex}]\n${trimmed}`;
        })
        .join("\n\n")
    : "(No matching snippets in the operator's library — draft from profile context only and call out gaps.)";

  const systemPrompt = `You are a U.S. military staff writer embedded in the "Mission Brief Drafter" tool inside a DoD AI Tool Marketplace. Your job is to draft a ${briefLabel} for the operator below, anchored in their structured profile and the snippets pulled from their personal doctrine/SOP library.

Hard rules:
- Never invent classified facts, casualty figures, friendly force locations, or specific OPSEC-sensitive details. If the operator hasn't given you a fact, say "TBD" rather than guessing.
- Quote sparingly from the provided library snippets; do not fabricate doctrine references.
- Match the operator's service voice (Army, Navy, USMC, USAF, USSF, USCG) when the branch is known.
- Output Markdown only. No preamble, no "Here is your draft" — go straight into the brief.
- Keep total length under ~400 words unless the topic clearly demands more.

${formatRules}`;

  const userPrompt = `${contextBlock}

${audienceLine}

Topic the operator wants drafted:
"${topic.trim()}"

Library snippets retrieved on the operator's behalf (use these to anchor specifics — DO NOT invent beyond them):
${snippetBlock}

Draft the ${briefLabel} now in the operator's voice (${user.displayName}). Output Markdown only.`;

  const response = await ai.models.generateContent({
    model: MODEL,
    contents: [{ role: "user", parts: [{ text: userPrompt }] }],
    config: {
      systemInstruction: systemPrompt,
      maxOutputTokens: 1400,
    },
  });

  const raw = response.text ?? "";
  const cleaned = raw
    .replace(/^```(?:markdown|md)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
  if (!cleaned) {
    throw new Error("Model returned an empty draft");
  }
  return cleaned;
}
