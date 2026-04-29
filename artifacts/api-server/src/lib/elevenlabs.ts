import fs from "node:fs/promises";
import path from "node:path";
import { logger } from "./logger";

const ELEVENLABS_BASE = "https://api.elevenlabs.io";

// "Bill" — strong, mature male from the public ElevenLabs voice library.
// Used as the drill-instructor default. Operators can override at any
// time by setting the `ELEVENLABS_VOICE_ID` env var (the chosen voice
// must already be visible in the workspace's ElevenLabs library).
const DEFAULT_VOICE_ID = "pqHfZKP75CvOlQylNhV4";

// On-disk fallback for the lazily-created agent id. Only used when
// `ELEVENLABS_AGENT_ID` is not set in the environment. Living in
// `.local/` keeps it out of git but persists across server restarts so
// we don't recreate a fresh agent on every boot.
const AGENT_ID_FILE = path.resolve(
  process.cwd(),
  "..",
  "..",
  ".local",
  "elevenlabs-agent-id",
);

let cachedAgentId: string | null = null;
let cachedAgentIdPromise: Promise<string> | null = null;

export class VoiceAgentNotConfiguredError extends Error {
  constructor(message = "ElevenLabs API key is not configured on the server") {
    super(message);
    this.name = "VoiceAgentNotConfiguredError";
  }
}

export class VoiceAgentApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "VoiceAgentApiError";
    this.status = status;
  }
}

function getApiKey(): string {
  const key = process.env.ELEVENLABS_API_KEY;
  if (!key) throw new VoiceAgentNotConfiguredError();
  return key;
}

export function getVoiceId(): string {
  return process.env.ELEVENLABS_VOICE_ID || DEFAULT_VOICE_ID;
}

async function callElevenLabs(
  pathname: string,
  init: RequestInit & { json?: unknown } = {},
): Promise<Response> {
  const { json, headers, ...rest } = init;
  const finalHeaders: Record<string, string> = {
    "xi-api-key": getApiKey(),
    Accept: "application/json",
    ...((headers as Record<string, string>) ?? {}),
  };
  if (json !== undefined) {
    finalHeaders["Content-Type"] = "application/json";
  }
  const res = await fetch(`${ELEVENLABS_BASE}${pathname}`, {
    ...rest,
    headers: finalHeaders,
    body: json !== undefined ? JSON.stringify(json) : rest.body,
  });
  return res;
}

// Marines / drill-instructor system prompt. Encodes the 6-step flow
// described in Task #126 and the guardrails the agent must respect.
// The literal handoff line and the "Are you satisfied" question are
// included verbatim so QA can confirm them in the running app.
function systemPrompt(): string {
  return `You are MARINES VOICE AGENT, a hands-free assistant for U.S.
service members using the DoW AI Tool Marketplace. Your tone is calm,
clipped, command-voice — like a Marine drill instructor giving
mission-critical instructions. Be concise. No filler. No parody.

You drive the marketplace via JavaScript "client tools" the operator's
browser exposes to you. You may speak only English. Never invent
profile or context-block content the operator did not say. If a field
already has a value and the operator's new dictation would overwrite
it, read the current value back and ask "Confirm overwrite?" before
calling setProfileField / setContextBlockElement.

==== Tools available ====
- getCurrentRoute() — current page path.
- navigate({ to }) — go to /profile, /catalog, /catalog/browse, or
  /catalog/<slug>.
- getProfileState() — returns which profile fields are filled vs empty.
- setProfileField({ field, value }) — write one profile field.
  field must be one of: rank, dutyTitle, branch, mosCode, unit,
  baseLocation, securityClearance, deploymentStatus, command, billets,
  freeFormContext.
- getContextBlockState() — which of the 6 elements are still empty.
- setContextBlockElement({ element, value }) — write one of doctrine,
  intent, environment, constraints, risk, experience.
- clickEvaluate() — runs the evaluator. Returns { totalScore, status,
  opsecFlag, flags }.
- clickConfirmContextBlock({ bypass? }) — confirms the block. Rejects
  with a readable reason if confirm is not allowed. For sub-threshold
  scores (NO-GO without an OPSEC flag) the call MUST include
  bypass=true; the bridge will refuse a plain confirm and ask you to
  re-call with bypass once the operator has explicitly accepted the
  risk. Never pass bypass=true on a clean GO score.
- goToCatalogBrowse() — navigate to /catalog/browse.
- findTool({ spokenName }) — fuzzy-match against the catalog.
- openTool({ slug }) — navigate to /catalog/<slug>.
- clickLaunchWithMyContext() — trigger "Launch with my context".

==== Flow ====
1. PROFILE (when on /profile): call getProfileState. For each empty
   field, ask the operator one question at a time. After they answer,
   call setProfileField. When all fields are filled, ask: "Profile is
   complete. Now let's go to the catalog?"

2. HANDOFF: when the operator says "now let's go to the catalog" or a
   close variant ("take me to the catalog", "catalog now", etc.), call
   navigate({ to: "/catalog" }) and then say EXACTLY this line:
   "Before you use AI tools, please fill out your context block.
   Orientation is Boyd's Schwerpunkt."

3. CONTEXT BLOCK (on /catalog): call getContextBlockState. Walk the
   operator through the six elements in order — doctrine, intent,
   environment, constraints, risk, experience — explaining each in one
   short sentence ("Element one: doctrine and orders. What doctrine or
   SOP governs this task?"). After each answer, call
   setContextBlockElement.

4. EVALUATE: when the operator says "evaluate", call clickEvaluate.
   Read the score and verdict aloud, then ask EXACTLY: "Are you
   satisfied with this evaluation score?"

5. CONFIRM: if the operator says yes:
   - On a clean GO score, call clickConfirmContextBlock with no args.
   - On a sub-threshold (NO-GO, no OPSEC flag) score, the operator's
     "yes" *is* the bypass acknowledgement — call
     clickConfirmContextBlock({ bypass: true }).
   - If the operator says no, leave the form alone so they can edit and
     try again.
   Then call goToCatalogBrowse and ask: "Which tool do you want to use
   for this mission?"

6. TOOL SELECT (on /catalog/browse): when the operator names a tool,
   call findTool({ spokenName }). If exactly one match, call
   openTool({ slug }) and then clickLaunchWithMyContext. If multiple
   close matches, read them back and ask the operator to choose.

==== Style ====
- Short sentences. Active voice. Clear next-step prompts.
- Never narrate that you're "calling a tool". Just speak the result.
- If a tool errors, report the human-readable reason and ask the
  operator how to proceed.
- If the operator interrupts, stop speaking and listen.`;
}

// Minimal client-tool definitions the agent knows about. The actual
// implementations live in the browser bridge; here we only declare
// names + parameter schemas so the agent can call them. Each entry
// uses ElevenLabs' client-tool schema:
//   { name, description, parameters: { type:"object", properties, required } }
function clientToolDefinitions() {
  return [
    {
      name: "getCurrentRoute",
      description: "Return the current wouter route the browser is on.",
      parameters: { type: "object", properties: {} },
    },
    {
      name: "navigate",
      description:
        "Navigate the marketplace to /profile, /catalog, /catalog/browse, or /catalog/<slug>.",
      parameters: {
        type: "object",
        properties: {
          to: {
            type: "string",
            description: "Wouter path starting with /",
          },
        },
        required: ["to"],
      },
    },
    {
      name: "getProfileState",
      description:
        "Return which operator-profile fields are filled vs empty.",
      parameters: { type: "object", properties: {} },
    },
    {
      name: "setProfileField",
      description:
        "Write a single operator-profile field. Allowed field names: rank, dutyTitle, branch, mosCode, unit, baseLocation, securityClearance, deploymentStatus, command, billets, freeFormContext.",
      parameters: {
        type: "object",
        properties: {
          field: {
            type: "string",
            description:
              "Profile field name. One of: rank, dutyTitle, branch, mosCode, unit, baseLocation, securityClearance, deploymentStatus, command, billets, freeFormContext.",
          },
          value: {
            type: "string",
            description:
              "Spoken value. The browser maps it to the closest valid option (branch / clearance / MOS / unit). For billets pass a comma-separated list.",
          },
        },
        required: ["field", "value"],
      },
    },
    {
      name: "getContextBlockState",
      description:
        "Return which of the 6 context-block elements are still empty.",
      parameters: { type: "object", properties: {} },
    },
    {
      name: "setContextBlockElement",
      description:
        "Write one element of the 6-element context block. Allowed names: doctrine, intent, environment, constraints, risk, experience.",
      parameters: {
        type: "object",
        properties: {
          element: {
            type: "string",
            description:
              "Context-block element name. One of: doctrine, intent, environment, constraints, risk, experience.",
          },
          value: {
            type: "string",
            description:
              "Operator's dictated content for this element. Free-form prose; the browser stores it verbatim.",
          },
        },
        required: ["element", "value"],
      },
    },
    {
      name: "clickEvaluate",
      description:
        "Trigger the Evaluate button on the catalog page. Returns the resulting score / verdict / OPSEC flag.",
      parameters: { type: "object", properties: {} },
    },
    {
      name: "clickConfirmContextBlock",
      description:
        "Trigger Confirm Context Block. For sub-threshold (NO-GO, non-OPSEC) scores, you MUST set bypass=true and you must only do so after the operator has explicitly accepted the risk in response to 'Are you satisfied with this evaluation score?'. On a clean GO, omit bypass.",
      parameters: {
        type: "object",
        properties: {
          bypass: {
            type: "boolean",
            description:
              "Pass true ONLY for sub-threshold confirms after the operator has explicitly accepted the risk verbally.",
          },
        },
      },
    },
    {
      name: "goToCatalogBrowse",
      description: "Navigate to the catalog browse view (/catalog/browse).",
      parameters: { type: "object", properties: {} },
    },
    {
      name: "findTool",
      description:
        "Fuzzy-match a spoken tool name against the current catalog.",
      parameters: {
        type: "object",
        properties: {
          spokenName: {
            type: "string",
            description:
              "Tool name as the operator said it. The browser fuzzy-matches against the catalog's display names.",
          },
        },
        required: ["spokenName"],
      },
    },
    {
      name: "openTool",
      description: "Navigate to /catalog/<slug>.",
      parameters: {
        type: "object",
        properties: {
          slug: {
            type: "string",
            description:
              "Catalog slug returned by findTool — the URL-safe id of the chosen tool.",
          },
        },
        required: ["slug"],
      },
    },
    {
      name: "clickLaunchWithMyContext",
      description:
        "Trigger the 'Launch with my context' button on the current tool detail page.",
      parameters: { type: "object", properties: {} },
    },
  ];
}

function agentCreatePayload() {
  return {
    name: "DoW Marines Voice Agent",
    conversation_config: {
      agent: {
        first_message:
          "Marines voice agent on the line. Stand by for orientation.",
        language: "en",
        prompt: {
          prompt: systemPrompt(),
          tools: clientToolDefinitions().map((def) => ({
            type: "client",
            name: def.name,
            description: def.description,
            parameters: def.parameters,
            // The conversation cannot continue until the browser
            // returns the tool result. Required for getProfileState,
            // findTool, clickEvaluate, etc.
            response_timeout_secs: 30,
            expects_response: true,
          })),
        },
      },
      tts: {
        voice_id: getVoiceId(),
      },
    },
  };
}

async function readPersistedAgentId(): Promise<string | null> {
  try {
    const raw = await fs.readFile(AGENT_ID_FILE, "utf8");
    const id = raw.trim();
    return id || null;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    logger.warn({ err }, "Could not read persisted ElevenLabs agent id");
    return null;
  }
}

async function persistAgentId(id: string): Promise<void> {
  try {
    await fs.mkdir(path.dirname(AGENT_ID_FILE), { recursive: true });
    await fs.writeFile(AGENT_ID_FILE, id, "utf8");
  } catch (err) {
    logger.warn({ err }, "Could not persist ElevenLabs agent id");
  }
}

async function createAgent(): Promise<string> {
  const res = await callElevenLabs("/v1/convai/agents/create", {
    method: "POST",
    json: agentCreatePayload(),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new VoiceAgentApiError(
      `ElevenLabs agent create failed (${res.status}): ${body || res.statusText}`,
      res.status,
    );
  }
  const json = (await res.json()) as { agent_id?: string; agentId?: string };
  const id = json.agent_id ?? json.agentId;
  if (!id) {
    throw new VoiceAgentApiError(
      "ElevenLabs agent create returned no agent_id",
      500,
    );
  }
  return id;
}

/**
 * Resolve the configured ElevenLabs agent id, creating one if neither the
 * env var nor the on-disk fallback knows about it. Memoised in-process
 * after the first successful resolution.
 */
export async function ensureAgentId(): Promise<string> {
  if (cachedAgentId) return cachedAgentId;
  if (cachedAgentIdPromise) return cachedAgentIdPromise;

  cachedAgentIdPromise = (async () => {
    const fromEnv = process.env.ELEVENLABS_AGENT_ID?.trim();
    if (fromEnv) {
      cachedAgentId = fromEnv;
      return fromEnv;
    }
    const persisted = await readPersistedAgentId();
    if (persisted) {
      cachedAgentId = persisted;
      return persisted;
    }
    // Verify the API key is present before attempting create — the
    // create call would 401 anyway but the explicit error makes the
    // failure mode obvious in the logs.
    getApiKey();
    logger.info("Creating ElevenLabs Conversational AI agent…");
    const id = await createAgent();
    await persistAgentId(id);
    logger.info(
      { agentId: id, file: AGENT_ID_FILE },
      "Created ElevenLabs agent. Set ELEVENLABS_AGENT_ID to this id to override the on-disk fallback.",
    );
    cachedAgentId = id;
    return id;
  })();

  try {
    return await cachedAgentIdPromise;
  } catch (err) {
    cachedAgentIdPromise = null;
    throw err;
  }
}

/**
 * Mint a short-lived signed URL the browser uses to open a WebSocket
 * conversation with the agent. The signed URL expires in ~15 minutes
 * (ElevenLabs default) and may only be used once.
 */
export async function getSignedUrl(
  agentId: string,
): Promise<string> {
  const res = await callElevenLabs(
    `/v1/convai/conversation/get-signed-url?agent_id=${encodeURIComponent(agentId)}`,
    { method: "GET" },
  );
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new VoiceAgentApiError(
      `ElevenLabs get-signed-url failed (${res.status}): ${body || res.statusText}`,
      res.status,
    );
  }
  const json = (await res.json()) as { signed_url?: string; signedUrl?: string };
  const url = json.signed_url ?? json.signedUrl;
  if (!url) {
    throw new VoiceAgentApiError(
      "ElevenLabs get-signed-url returned no URL",
      500,
    );
  }
  return url;
}

export function isVoiceAgentConfigured(): boolean {
  return !!process.env.ELEVENLABS_API_KEY;
}
