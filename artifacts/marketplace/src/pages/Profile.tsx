import { useCallback, useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useGetMyProfile,
  useUpdateMyProfile,
  useGetProfileChatHistory,
  useSendProfileChat,
  useResetProfileChat,
  getGetMyProfileQueryKey,
  getGetProfileChatHistoryQueryKey,
} from "@workspace/api-client-react";
import type {
  ProfileUpdate,
  UserProfile,
  ChatMessage,
} from "@workspace/api-client-react";
import { PageContainer, ErrorBox, formatDate } from "@/lib/format";

const BRANCHES = [
  "Army",
  "Navy",
  "Marine Corps",
  "Air Force",
  "Space Force",
  "Coast Guard",
];
const CLEARANCES = [
  "None",
  "Public Trust",
  "Secret",
  "Top Secret",
  "TS/SCI",
];
const DEPLOYMENT_STATUS = [
  "Garrison",
  "Train-up",
  "Deployed",
  "Reset",
  "TDY",
];

const FIELDS: Array<{
  key: keyof ProfileUpdate;
  label: string;
  type: "text" | "select" | "textarea";
  options?: string[];
  span?: 1 | 2 | 3;
  placeholder?: string;
}> = [
  { key: "branch", label: "Branch", type: "select", options: BRANCHES },
  { key: "rank", label: "Rank", type: "text", placeholder: "e.g. SSG, O-3" },
  {
    key: "mosCode",
    label: "MOS / Rate / AFSC",
    type: "text",
    placeholder: "e.g. 11B, IT2, 1N3X1",
  },
  {
    key: "dutyTitle",
    label: "Duty title",
    type: "text",
    placeholder: "e.g. Platoon Sergeant",
  },
  {
    key: "unit",
    label: "Unit",
    type: "text",
    placeholder: "e.g. 3-187 IN, 1st BCT",
  },
  {
    key: "baseLocation",
    label: "Base / location",
    type: "text",
    placeholder: "e.g. Fort Campbell, KY",
  },
  {
    key: "securityClearance",
    label: "Clearance",
    type: "select",
    options: CLEARANCES,
  },
  {
    key: "deploymentStatus",
    label: "Deployment status",
    type: "select",
    options: DEPLOYMENT_STATUS,
  },
  {
    key: "primaryMission",
    label: "Primary mission",
    type: "textarea",
    span: 3,
    placeholder: "What does your unit actually do day-to-day?",
  },
  {
    key: "freeFormContext",
    label: "Narrative context",
    type: "textarea",
    span: 3,
    placeholder:
      "Anything else a tool should know — current operation, equipment, AOR, frequent tasks…",
  },
];

export function Profile() {
  const queryClient = useQueryClient();
  const { data: profile, isLoading, error } = useGetMyProfile();
  const updateMutation = useUpdateMyProfile();

  const [draft, setDraft] = useState<ProfileUpdate | null>(null);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);

  // Versioning + timer refs prevent out-of-order responses from clobbering
  // newer user input. Every queued save bumps the version, the in-flight
  // request only commits if it is still the latest.
  const versionRef = useRef(0);
  const lastCommittedRef = useRef(0);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingDraftRef = useRef<ProfileUpdate | null>(null);

  useEffect(() => {
    if (profile && !draft) {
      setDraft(profileToDraft(profile));
    }
  }, [profile, draft]);

  const flush = useCallback(async () => {
    const next = pendingDraftRef.current;
    if (!next) return;
    const myVersion = ++versionRef.current;
    setSaveError(null);
    try {
      const updated = await updateMutation.mutateAsync({ data: next });
      // Only commit this response if no newer save has been queued in the
      // meantime — discards stale "last response wins" overwrites.
      if (myVersion >= lastCommittedRef.current) {
        lastCommittedRef.current = myVersion;
        setSavedAt(Date.now());
        queryClient.setQueryData(getGetMyProfileQueryKey(), updated);
      }
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : "Failed to save profile");
    }
  }, [queryClient, updateMutation]);

  const queueSave = useCallback(
    (next: ProfileUpdate) => {
      setDraft(next);
      pendingDraftRef.current = next;
      if (debounceRef.current) clearTimeout(debounceRef.current);
      debounceRef.current = setTimeout(() => {
        debounceRef.current = null;
        void flush();
      }, 400);
    },
    [flush],
  );

  // On unmount, flush any pending edit so we don't lose the last keystrokes.
  useEffect(() => {
    return () => {
      if (debounceRef.current) {
        clearTimeout(debounceRef.current);
        debounceRef.current = null;
        void flush();
      }
    };
  }, [flush]);

  const onChange = (key: keyof ProfileUpdate, value: string) => {
    if (!draft) return;
    queueSave({ ...draft, [key]: value || null });
  };

  const onAiUseCases = (value: string) => {
    if (!draft) return;
    const arr = value
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    queueSave({ ...draft, aiUseCases: arr });
  };

  const applySuggestion = (suggestion: ProfileUpdate) => {
    if (!draft) return;
    queueSave({ ...draft, ...suggestion });
  };

  const exportProfile = useCallback(
    async (format: "md" | "json") => {
      // Flush any pending debounced save so the export reflects the latest edits.
      if (debounceRef.current) {
        clearTimeout(debounceRef.current);
        debounceRef.current = null;
        await flush();
      }
      const latest =
        queryClient.getQueryData<UserProfile>(getGetMyProfileQueryKey()) ??
        profile;
      if (!latest) return;

      const date = new Date().toISOString().slice(0, 10);
      let content: string;
      let mime: string;
      let ext: string;
      if (format === "md") {
        content = profileToMarkdown(latest);
        mime = "text/markdown;charset=utf-8";
        ext = "md";
      } else {
        content = JSON.stringify(latest, null, 2);
        mime = "application/json;charset=utf-8";
        ext = "json";
      }
      const blob = new Blob([content], { type: mime });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `operator-profile-${date}.${ext}`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    },
    [flush, profile, queryClient],
  );

  if (error) {
    return (
      <PageContainer>
        <ErrorBox>{(error as Error).message}</ErrorBox>
      </PageContainer>
    );
  }

  return (
    <PageContainer>
      <div className="mb-8 flex items-end justify-between gap-6">
        <div>
          <div className="text-[10px] uppercase tracking-[0.25em] text-primary font-mono font-semibold mb-2">
            Operator Profile
          </div>
          <h1 className="text-3xl font-semibold tracking-tight">
            Mission context
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            Every tool you launch receives this context. Edit fields directly,
            or chat with the assistant to fill it in conversationally.
          </p>
        </div>
        {profile && (
          <div className="flex items-end gap-5">
            <ExportMenu onExport={exportProfile} />
            <div className="text-right">
              <div className="text-[10px] font-mono uppercase tracking-wider text-muted-foreground">
                Completeness
              </div>
              <div className="text-3xl font-semibold tabular-nums">
                {profile.completenessPct}%
              </div>
              <div className="w-32 h-1 bg-border rounded-full overflow-hidden mt-1">
                <div
                  className="h-full bg-primary"
                  style={{ width: `${profile.completenessPct}%` }}
                />
              </div>
            </div>
          </div>
        )}
      </div>

      <div className="grid lg:grid-cols-5 gap-6">
        <section className="lg:col-span-3 bg-card border border-border rounded-md p-5">
          {isLoading || !draft ? (
            <div className="text-muted-foreground text-sm">
              Loading profile…
            </div>
          ) : (
            <div className="grid grid-cols-3 gap-4">
              {FIELDS.map((f) => {
                const colSpan =
                  f.span === 3
                    ? "col-span-3"
                    : f.span === 2
                      ? "col-span-2"
                      : "col-span-3 sm:col-span-1";
                const value =
                  ((draft as Record<string, unknown>)[f.key] as
                    | string
                    | null) ?? "";
                return (
                  <div key={f.key} className={colSpan}>
                    <label className="block text-[10px] font-mono uppercase tracking-wider text-muted-foreground mb-1.5">
                      {f.label}
                    </label>
                    {f.type === "select" ? (
                      <select
                        value={value}
                        onChange={(e) => onChange(f.key, e.target.value)}
                        className="w-full px-3 py-2 rounded-md bg-background border border-border text-sm focus:border-primary focus:outline-none"
                      >
                        <option value="">— unset —</option>
                        {f.options?.map((o) => (
                          <option key={o} value={o}>
                            {o}
                          </option>
                        ))}
                      </select>
                    ) : f.type === "textarea" ? (
                      <textarea
                        value={value}
                        onChange={(e) => onChange(f.key, e.target.value)}
                        placeholder={f.placeholder}
                        rows={3}
                        className="w-full px-3 py-2 rounded-md bg-background border border-border text-sm focus:border-primary focus:outline-none resize-y"
                      />
                    ) : (
                      <input
                        type="text"
                        value={value}
                        onChange={(e) => onChange(f.key, e.target.value)}
                        placeholder={f.placeholder}
                        className="w-full px-3 py-2 rounded-md bg-background border border-border text-sm focus:border-primary focus:outline-none"
                      />
                    )}
                  </div>
                );
              })}
              <div className="col-span-3">
                <label className="block text-[10px] font-mono uppercase tracking-wider text-muted-foreground mb-1.5">
                  AI use cases (comma-separated)
                </label>
                <input
                  type="text"
                  defaultValue={(draft.aiUseCases ?? []).join(", ")}
                  onBlur={(e) => onAiUseCases(e.target.value)}
                  placeholder="planning, analysis, drafting, code review…"
                  className="w-full px-3 py-2 rounded-md bg-background border border-border text-sm focus:border-primary focus:outline-none"
                />
              </div>
              <div className="col-span-3 space-y-2">
                <div className="text-[10px] font-mono uppercase tracking-wider text-muted-foreground">
                  {updateMutation.isPending
                    ? "Saving…"
                    : savedAt
                      ? `Saved · ${formatDate(new Date(savedAt).toISOString())}`
                      : "Changes save automatically"}
                </div>
                {saveError && <ErrorBox>Save failed: {saveError}</ErrorBox>}
              </div>
            </div>
          )}
        </section>

        <ChatPanel onApply={applySuggestion} />
      </div>
    </PageContainer>
  );
}

function ExportMenu({
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

function profileToMarkdown(p: UserProfile): string {
  const dash = (v: string | null | undefined) =>
    v && v.trim() ? v.trim() : "—";
  const block = (v: string | null | undefined) =>
    v && v.trim() ? v.trim() : "—";

  const lines: string[] = [];
  lines.push("# Operator Profile");
  lines.push("");
  lines.push(`_Exported ${new Date().toISOString()}_`);
  lines.push("");
  lines.push(`**Completeness:** ${p.completenessPct}%`);
  lines.push("");

  lines.push("## Service info");
  lines.push("");
  lines.push(`- **Branch:** ${dash(p.branch)}`);
  lines.push(`- **Rank:** ${dash(p.rank)}`);
  lines.push(`- **MOS / Rate / AFSC:** ${dash(p.mosCode)}`);
  lines.push("");

  lines.push("## Duty");
  lines.push("");
  lines.push(`- **Duty title:** ${dash(p.dutyTitle)}`);
  lines.push(`- **Unit:** ${dash(p.unit)}`);
  lines.push(`- **Base / location:** ${dash(p.baseLocation)}`);
  lines.push("");

  lines.push("## Readiness & security");
  lines.push("");
  lines.push(`- **Clearance:** ${dash(p.securityClearance)}`);
  lines.push(`- **Deployment status:** ${dash(p.deploymentStatus)}`);
  lines.push("");

  lines.push("## Narrative");
  lines.push("");
  lines.push("### Primary mission");
  lines.push("");
  lines.push(block(p.primaryMission));
  lines.push("");
  lines.push("### Narrative context");
  lines.push("");
  lines.push(block(p.freeFormContext));
  lines.push("");

  lines.push("## AI use cases");
  lines.push("");
  if (!p.aiUseCases || p.aiUseCases.length === 0) {
    lines.push("—");
  } else {
    for (const uc of p.aiUseCases) lines.push(`- ${uc}`);
  }
  lines.push("");

  return lines.join("\n");
}

function profileToDraft(p: UserProfile): ProfileUpdate {
  return {
    branch: p.branch,
    rank: p.rank,
    mosCode: p.mosCode,
    dutyTitle: p.dutyTitle,
    unit: p.unit,
    baseLocation: p.baseLocation,
    securityClearance: p.securityClearance,
    deploymentStatus: p.deploymentStatus,
    primaryMission: p.primaryMission,
    aiUseCases: p.aiUseCases,
    freeFormContext: p.freeFormContext,
  };
}

function ChatPanel({
  onApply,
}: {
  onApply: (s: ProfileUpdate) => void;
}) {
  const queryClient = useQueryClient();
  const { data: history } = useGetProfileChatHistory();
  const sendMutation = useSendProfileChat();
  const resetMutation = useResetProfileChat();
  const [input, setInput] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);
  const [latestSuggestion, setLatestSuggestion] = useState<{
    messageId: string;
    suggestion: ProfileUpdate;
  } | null>(null);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [history]);

  const onSend = async (e: React.FormEvent) => {
    e.preventDefault();
    const text = input.trim();
    if (!text) return;
    setInput("");
    try {
      const resp = await sendMutation.mutateAsync({ data: { message: text } });
      queryClient.invalidateQueries({
        queryKey: getGetProfileChatHistoryQueryKey(),
      });
      if (resp.suggestedProfile) {
        setLatestSuggestion({
          messageId: crypto.randomUUID(),
          suggestion: resp.suggestedProfile,
        });
      }
    } catch (err) {
      console.error(err);
    }
  };

  const onReset = async () => {
    await resetMutation.mutateAsync();
    queryClient.invalidateQueries({
      queryKey: getGetProfileChatHistoryQueryKey(),
    });
    setLatestSuggestion(null);
  };

  const messages: ChatMessage[] = history ?? [];

  return (
    <section className="lg:col-span-2 bg-card border border-border rounded-md flex flex-col h-[640px]">
      <div className="px-5 py-4 border-b border-border flex items-center justify-between">
        <div>
          <div className="text-[10px] uppercase tracking-wider text-muted-foreground font-mono">
            Profile assistant
          </div>
          <div className="text-sm font-semibold mt-0.5">
            Conversational fill-in
          </div>
        </div>
        {messages.length > 0 && (
          <button
            onClick={onReset}
            className="text-[10px] font-mono uppercase tracking-wider text-muted-foreground hover:text-foreground"
          >
            Reset
          </button>
        )}
      </div>
      <div ref={scrollRef} className="flex-1 overflow-y-auto p-5 space-y-3">
        {messages.length === 0 && (
          <div className="text-sm text-muted-foreground py-8 text-center">
            Tell me about your role and mission. I'll suggest profile fields
            you can apply with one click.
          </div>
        )}
        {messages.map((m) => (
          <div
            key={m.id}
            className={`flex ${m.role === "user" ? "justify-end" : "justify-start"}`}
          >
            <div
              className={`max-w-[85%] rounded-md px-3 py-2 text-sm leading-relaxed ${
                m.role === "user"
                  ? "bg-primary/15 text-foreground border border-primary/30"
                  : "bg-background border border-border"
              }`}
            >
              <div className="whitespace-pre-wrap">{m.content}</div>
              <div className="text-[10px] text-muted-foreground font-mono mt-1.5">
                {formatDate(m.createdAt)}
              </div>
            </div>
          </div>
        ))}
        {latestSuggestion && (
          <div className="rounded-md border border-emerald-500/40 bg-emerald-500/5 p-3">
            <div className="text-[10px] font-mono uppercase tracking-wider text-emerald-300 mb-2">
              Suggested updates
            </div>
            <div className="text-xs space-y-0.5 mb-3 text-emerald-100/90">
              {Object.entries(latestSuggestion.suggestion).map(([k, v]) => {
                if (v == null || (Array.isArray(v) && v.length === 0))
                  return null;
                return (
                  <div key={k}>
                    <span className="text-emerald-400 font-mono">{k}:</span>{" "}
                    {Array.isArray(v) ? v.join(", ") : String(v)}
                  </div>
                );
              })}
            </div>
            <div className="flex gap-2">
              <button
                onClick={() => {
                  onApply(latestSuggestion.suggestion);
                  setLatestSuggestion(null);
                }}
                className="px-3 py-1.5 rounded bg-emerald-500/20 hover:bg-emerald-500/30 text-emerald-300 text-xs font-medium"
              >
                Apply suggestions
              </button>
              <button
                onClick={() => setLatestSuggestion(null)}
                className="px-3 py-1.5 rounded text-xs text-emerald-200/70 hover:text-emerald-200"
              >
                Dismiss
              </button>
            </div>
          </div>
        )}
        {sendMutation.isPending && (
          <div className="text-xs text-muted-foreground">Thinking…</div>
        )}
      </div>
      <form
        onSubmit={onSend}
        className="border-t border-border p-3 flex gap-2"
      >
        <input
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Tell me about your role…"
          className="flex-1 px-3 py-2 rounded-md bg-background border border-border text-sm focus:border-primary focus:outline-none"
        />
        <button
          type="submit"
          disabled={!input.trim() || sendMutation.isPending}
          className="px-4 py-2 rounded-md bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 disabled:opacity-50"
        >
          Send
        </button>
      </form>
    </section>
  );
}
