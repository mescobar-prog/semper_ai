import { useEffect, useRef, useState } from "react";
import type {
  ContextBlockFields,
  ContextBlockState,
  ProfileUpdate,
} from "@workspace/api-client-react";

// ---------------------------------------------------------------------------
// Shared Export menu (Markdown / JSON dropdown) used by both the Operator
// Profile page and the 6-Element Context Block page so the two surfaces look
// and behave the same.
// ---------------------------------------------------------------------------

export function ExportMenu({
  onExport,
}: {
  onExport: (format: "md" | "json") => void | Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const wrapperRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (
        wrapperRef.current &&
        !wrapperRef.current.contains(e.target as Node)
      ) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  const choose = (fmt: "md" | "json") => {
    setOpen(false);
    void onExport(fmt);
  };

  return (
    <div className="relative" ref={wrapperRef}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="menu"
        aria-expanded={open}
        className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md border border-border bg-background hover:bg-accent text-sm font-medium"
      >
        Export
        <svg
          width="10"
          height="10"
          viewBox="0 0 10 10"
          aria-hidden="true"
          className="opacity-70"
        >
          <path
            d="M2 3.5l3 3 3-3"
            stroke="currentColor"
            strokeWidth="1.5"
            fill="none"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </button>
      {open && (
        <div
          role="menu"
          className="absolute right-0 mt-1 w-48 rounded-md border border-border bg-card shadow-lg z-10 py-1"
        >
          <button
            type="button"
            role="menuitem"
            onClick={() => choose("md")}
            className="w-full text-left px-3 py-1.5 text-sm hover:bg-accent flex items-center justify-between"
          >
            <span>Markdown</span>
            <span className="text-[10px] font-mono text-muted-foreground">
              .md
            </span>
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() => choose("json")}
            className="w-full text-left px-3 py-1.5 text-sm hover:bg-accent flex items-center justify-between"
          >
            <span>JSON</span>
            <span className="text-[10px] font-mono text-muted-foreground">
              .json
            </span>
          </button>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Shared Import button. Owns the hidden file input + busy state. The parent
// receives the chosen file and is responsible for parsing, validating, and
// surfacing inline errors / notices in a layout slot of its choosing.
// ---------------------------------------------------------------------------

export function ImportControl({
  onFile,
  label = "Import",
}: {
  onFile: (file: File) => void | Promise<void>;
  label?: string;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);

  const onChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    // Reset so picking the same file twice still fires onChange.
    e.target.value = "";
    if (!file) return;
    setBusy(true);
    try {
      await onFile(file);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <button
        type="button"
        onClick={() => inputRef.current?.click()}
        disabled={busy}
        className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md border border-border bg-background hover:bg-accent text-sm font-medium disabled:opacity-50"
      >
        {busy ? "Importing…" : label}
      </button>
      <input
        ref={inputRef}
        type="file"
        accept=".json,application/json"
        className="hidden"
        onChange={onChange}
      />
    </>
  );
}

// ---------------------------------------------------------------------------
// Inline import-result banner — small status row used by both pages so error
// and notice messages render in a consistent place / style.
// ---------------------------------------------------------------------------

export type ImportMessage =
  | { kind: "error"; text: string }
  | { kind: "notice"; text: string };

export function ImportMessageBanner({
  message,
  onDismiss,
}: {
  message: ImportMessage | null;
  onDismiss: () => void;
}) {
  if (!message) return null;
  const isErr = message.kind === "error";
  return (
    <div
      role={isErr ? "alert" : "status"}
      className={`mb-4 rounded-md border px-3 py-2 text-xs flex items-start gap-3 ${
        isErr
          ? "border-red-500/40 bg-red-500/10 text-red-200"
          : "border-emerald-500/40 bg-emerald-500/10 text-emerald-200"
      }`}
    >
      <span className="font-mono uppercase tracking-wider text-[10px] shrink-0">
        {isErr ? "Import failed" : "Imported"}
      </span>
      <span className="flex-1">{message.text}</span>
      <button
        type="button"
        onClick={onDismiss}
        aria-label="Dismiss"
        className="text-[11px] font-mono uppercase tracking-wider opacity-70 hover:opacity-100"
      >
        Dismiss
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Validation helpers. Both pages share the same payload shape: an envelope
// `{ profile?, contextBlock? }`. Each page reads the half it cares about and
// surfaces a notice if the file also carried the other half.
// ---------------------------------------------------------------------------

const PROFILE_STRING_KEYS = [
  "branch",
  "rank",
  "mosCode",
  "dutyTitle",
  "unit",
  "baseLocation",
  "securityClearance",
  "deploymentStatus",
  "command",
  "freeFormContext",
] as const;

const PROFILE_ALL_KEYS = [
  ...PROFILE_STRING_KEYS,
  "billets",
  "launchPreference",
] as const;

const CB_FIELD_KEYS: Array<keyof ContextBlockFields> = [
  "doctrine",
  "intent",
  "environment",
  "constraints",
  "risk",
  "experience",
];

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export type ProfileImportResult =
  | { ok: true; profile: ProfileUpdate; hasContextBlock: boolean }
  | { ok: false; error: string };

export function parseProfileImport(json: unknown): ProfileImportResult {
  if (!isPlainObject(json)) {
    return { ok: false, error: "Imported file must be a JSON object." };
  }

  // Accept either an envelope `{ profile, contextBlock? }` or a flat profile.
  let src: Record<string, unknown>;
  let hasContextBlock = false;
  if (isPlainObject(json.profile)) {
    src = json.profile;
    hasContextBlock = isPlainObject(json.contextBlock);
  } else if (PROFILE_ALL_KEYS.some((k) => k in json)) {
    src = json;
  } else {
    return {
      ok: false,
      error: "JSON does not look like an exported operator profile.",
    };
  }

  const out: ProfileUpdate = {};
  for (const key of PROFILE_STRING_KEYS) {
    if (!(key in src)) continue;
    const v = src[key];
    if (v === null || typeof v === "string") {
      (out as Record<string, unknown>)[key] = v;
    } else {
      return { ok: false, error: `Field "${key}" must be a string or null.` };
    }
  }
  if ("billets" in src) {
    const v = src.billets;
    if (!Array.isArray(v) || !v.every((x) => typeof x === "string")) {
      return {
        ok: false,
        error: 'Field "billets" must be an array of strings.',
      };
    }
    out.billets = v as string[];
  }
  if ("launchPreference" in src) {
    const v = src.launchPreference;
    if (v !== "preview" && v !== "direct") {
      return {
        ok: false,
        error: 'Field "launchPreference" must be "preview" or "direct".',
      };
    }
    out.launchPreference = v;
  }

  if (Object.keys(out).length === 0) {
    return {
      ok: false,
      error: "No recognized profile fields were found in the imported file.",
    };
  }

  return { ok: true, profile: out, hasContextBlock };
}

export type ContextBlockImportResult =
  | { ok: true; fields: ContextBlockFields; hasProfile: boolean }
  | { ok: false; error: string };

export function parseContextBlockImport(
  json: unknown,
): ContextBlockImportResult {
  if (!isPlainObject(json)) {
    return { ok: false, error: "Imported file must be a JSON object." };
  }

  let src: Record<string, unknown>;
  let hasProfile = false;
  if (isPlainObject(json.contextBlock)) {
    src = json.contextBlock;
    hasProfile = isPlainObject(json.profile);
  } else if (CB_FIELD_KEYS.some((k) => k in json)) {
    src = json;
  } else {
    return {
      ok: false,
      error: "JSON does not look like an exported Context Block.",
    };
  }

  const fields: ContextBlockFields = {
    doctrine: "",
    intent: "",
    environment: "",
    constraints: "",
    risk: "",
    experience: "",
  };
  let sawAny = false;
  for (const key of CB_FIELD_KEYS) {
    if (!(key in src)) continue;
    sawAny = true;
    const v = src[key];
    if (v === null || v === undefined) {
      fields[key] = "";
    } else if (typeof v === "string") {
      fields[key] = v;
    } else {
      return { ok: false, error: `Field "${key}" must be a string.` };
    }
  }
  if (!sawAny) {
    return {
      ok: false,
      error:
        "No Context Block fields (doctrine, intent, environment, constraints, risk, experience) were found.",
    };
  }
  return { ok: true, fields, hasProfile };
}

// ---------------------------------------------------------------------------
// Markdown rendering for the Context Block export.
// ---------------------------------------------------------------------------

const CB_LABELS: Record<keyof ContextBlockFields, string> = {
  doctrine: "1. Doctrine & Orders",
  intent: "2. Commander's Intent",
  environment: "3. Environment",
  constraints: "4. Constraints & Limitations",
  risk: "5. Risk",
  experience: "6. Experience & Judgment",
};

export function contextBlockToMarkdown(
  fields: ContextBlockFields,
  meta: ContextBlockState | null | undefined,
): string {
  const block = (v: string | null | undefined) =>
    v && v.trim() ? v.trim() : "—";

  const lines: string[] = [];
  lines.push("# 6-Element Context Block");
  lines.push("");
  lines.push(`_Exported ${new Date().toISOString()}_`);
  lines.push("");

  if (meta) {
    lines.push("## Status");
    lines.push("");
    if (meta.confirmedAt) {
      const raw: unknown = meta.confirmedAt;
      const ts =
        raw instanceof Date
          ? raw.toISOString()
          : String(raw);
      lines.push(`- **Last confirmed:** ${ts}`);
    } else {
      lines.push("- **Last confirmed:** never");
    }
    lines.push(`- **Version:** ${meta.version}`);
    if (meta.lastEvaluation) {
      const ev = meta.lastEvaluation;
      lines.push(`- **Latest score:** ${ev.totalScore}/12`);
      lines.push(`- **Status:** ${ev.status}`);
      if (ev.opsecFlag) lines.push(`- **OPSEC fail-safe:** tripped`);
      if (ev.flags) lines.push(`- **Flags:** ${ev.flags}`);
    }
    lines.push("");
  }

  for (const key of CB_FIELD_KEYS) {
    lines.push(`## ${CB_LABELS[key]}`);
    lines.push("");
    lines.push(block(fields[key]));
    lines.push("");
  }
  return lines.join("\n");
}
