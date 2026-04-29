import { useEffect, useMemo, useState } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  draftBrief,
  exchangeContextToken,
  type BriefDraft,
  type ContextExchangeResponse,
  type RagSnippet,
} from "@workspace/api-client-react";

const queryClient = new QueryClient();

type ExchangeState =
  | { status: "loading" }
  | { status: "no-token" }
  | { status: "error"; message: string }
  | { status: "ready"; data: ContextExchangeResponse };

type DraftState =
  | { status: "idle" }
  | { status: "drafting" }
  | { status: "ready"; data: BriefDraft }
  | { status: "error"; message: string };

type BriefType = "sitrep" | "opord_paragraph" | "training_brief";

const BRIEF_OPTIONS: { value: BriefType; label: string; help: string }[] = [
  {
    value: "sitrep",
    label: "SITREP",
    help: "Situation report — Situation, Mission, Execution, Sustainment, Command & Signal.",
  },
  {
    value: "opord_paragraph",
    label: "OPORD paragraph",
    help: "Single OPORD paragraph (defaults to paragraph 3 — Execution).",
  },
  {
    value: "training_brief",
    label: "Training brief",
    help: "Training event brief with METL link, objectives, and risk controls.",
  },
];

function badge(
  label: string,
  tone: "neutral" | "good" | "warn" | "info" = "neutral",
) {
  const tones: Record<string, string> = {
    neutral: "bg-slate-700/60 text-slate-100 border border-slate-600",
    good: "bg-emerald-500/15 text-emerald-300 border border-emerald-400/40",
    warn: "bg-amber-500/15 text-amber-200 border border-amber-400/40",
    info: "bg-sky-500/15 text-sky-200 border border-sky-400/40",
  };
  return (
    <span
      className={`inline-flex items-center px-2 py-0.5 rounded text-[11px] font-medium tracking-wide uppercase ${tones[tone]}`}
    >
      {label}
    </span>
  );
}

function atoTone(status: string): "good" | "warn" | "info" {
  if (status === "full_ato") return "good";
  if (status === "ipa") return "info";
  return "warn";
}

function atoLabel(status: string): string {
  if (status === "full_ato") return "Full ATO";
  if (status === "ipa") return "Interim Authority";
  if (status === "in_review") return "In ATO Review";
  return status;
}

function Field({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5">
      <div className="text-[11px] uppercase tracking-wider text-slate-500">
        {label}
      </div>
      <div className="text-sm text-slate-100">
        {value || <span className="text-slate-600 italic">unset</span>}
      </div>
    </div>
  );
}

function SnippetView({ s }: { s: RagSnippet }) {
  return (
    <div className="rounded-lg border border-slate-700/70 bg-slate-900/60 p-4">
      <div className="flex items-center justify-between mb-2">
        <div className="text-sm font-medium text-slate-200">
          {s.documentTitle}
        </div>
        <div className="text-[11px] uppercase tracking-wider text-slate-500">
          chunk #{s.chunkIndex} · score {s.score.toFixed(3)}
        </div>
      </div>
      <div className="text-sm text-slate-300 whitespace-pre-wrap leading-relaxed font-mono">
        {s.content}
      </div>
    </div>
  );
}

function BriefDrafterPage() {
  const [state, setState] = useState<ExchangeState>({ status: "loading" });
  const [briefType, setBriefType] = useState<BriefType>("sitrep");
  const [topic, setTopic] = useState("");
  const [audience, setAudience] = useState("");
  const [draftState, setDraftState] = useState<DraftState>({ status: "idle" });
  const [editedDraft, setEditedDraft] = useState("");
  const [copyStatus, setCopyStatus] = useState<"idle" | "copied" | "error">(
    "idle",
  );

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const token = params.get("token");
    if (!token) {
      setState({ status: "no-token" });
      return;
    }
    exchangeContextToken({ launchToken: token })
      .then((data) => {
        setState({ status: "ready", data });
        // Task #88: pre-fill the topic with the operator's launch intent
        // so they don't have to retype what they already told the marketplace.
        if (data.launchIntent) {
          setTopic((prev) => (prev.trim() ? prev : (data.launchIntent ?? "")));
        }
      })
      .catch((err: unknown) => {
        const message =
          err instanceof Error ? err.message : "Token exchange failed";
        setState({ status: "error", message });
      });
  }, []);

  const sessionToken =
    state.status === "ready" ? state.data.sessionToken : null;

  const selectedOption = useMemo(
    () => BRIEF_OPTIONS.find((o) => o.value === briefType) ?? BRIEF_OPTIONS[0],
    [briefType],
  );

  async function handleDraft(e: React.FormEvent) {
    e.preventDefault();
    const trimmedTopic = topic.trim();
    if (!trimmedTopic || !sessionToken) return;
    setDraftState({ status: "drafting" });
    setCopyStatus("idle");
    try {
      const result = await draftBrief({
        sessionToken,
        briefType,
        topic: trimmedTopic,
        audience: audience.trim() ? audience.trim() : null,
      });
      setDraftState({ status: "ready", data: result });
      setEditedDraft(result.draft);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Drafting failed";
      setDraftState({ status: "error", message });
    }
  }

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(editedDraft);
      setCopyStatus("copied");
      setTimeout(() => setCopyStatus("idle"), 1800);
    } catch {
      setCopyStatus("error");
      setTimeout(() => setCopyStatus("idle"), 1800);
    }
  }

  if (state.status === "loading") {
    return (
      <div className="min-h-screen bg-slate-950 text-slate-100 flex items-center justify-center">
        <div className="text-slate-400">Exchanging launch token…</div>
      </div>
    );
  }
  if (state.status === "no-token") {
    return (
      <div className="min-h-screen bg-slate-950 text-slate-100 flex items-center justify-center p-8">
        <div className="max-w-md text-center space-y-3">
          <div className="text-2xl font-semibold tracking-tight">
            Mission Brief Drafter
          </div>
          <p className="text-slate-400 leading-relaxed">
            This tool drafts a SITREP, OPORD paragraph, or training brief in
            your service's voice — anchored in your profile and the most
            relevant snippets from your personal library. Launch it from the
            Semper AI catalog so the platform can mint a one-time launch
            token for you.
          </p>
          <a
            href="/"
            className="inline-block mt-2 px-4 py-2 rounded-md bg-sky-500 hover:bg-sky-400 text-slate-900 font-medium"
          >
            Open platform
          </a>
        </div>
      </div>
    );
  }
  if (state.status === "error") {
    return (
      <div className="min-h-screen bg-slate-950 text-slate-100 flex items-center justify-center p-8">
        <div className="max-w-md text-center space-y-3">
          <div className="text-2xl font-semibold tracking-tight text-rose-300">
            Token exchange failed
          </div>
          <p className="text-slate-400">{state.message}</p>
          <a
            href="/"
            className="inline-block mt-2 px-4 py-2 rounded-md bg-slate-800 hover:bg-slate-700 text-slate-100"
          >
            Back to platform
          </a>
        </div>
      </div>
    );
  }

  const { tool, user, profile, primer, sessionExpiresAt, launchIntent } =
    state.data;

  const profileSummaryParts: string[] = [];
  if (profile.rank) profileSummaryParts.push(profile.rank);
  if (profile.dutyTitle) profileSummaryParts.push(profile.dutyTitle);
  if (profile.unit) profileSummaryParts.push(profile.unit);
  const profileSummary = profileSummaryParts.join(" · ");

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100">
      <div
        role="status"
        aria-label="Classification banner"
        className="w-full bg-green-500 text-black font-bold text-center text-sm tracking-widest uppercase py-1.5 border-b border-green-700"
      >
        UNCLASSIFIED (DEMO)
      </div>
      <header className="border-b border-slate-800 bg-slate-900/40 backdrop-blur sticky top-0 z-10">
        <div className="max-w-6xl mx-auto px-6 py-4 flex items-center justify-between gap-4">
          <div className="space-y-1">
            <div className="flex items-center gap-3">
              <span className="text-[11px] uppercase tracking-[0.2em] text-sky-400 font-semibold">
                Demo Tool
              </span>
              <span className="text-slate-600">·</span>
              <span className="text-sm text-slate-400">{tool.vendor}</span>
            </div>
            <div className="flex items-center gap-3">
              <h1 className="text-2xl font-semibold tracking-tight">
                {tool.name}
              </h1>
              {badge(atoLabel(tool.atoStatus), atoTone(tool.atoStatus))}
            </div>
          </div>
          <a href="/" className="text-sm text-slate-400 hover:text-slate-100">
            ← Back to platform
          </a>
        </div>
      </header>

      <div className="max-w-6xl mx-auto px-6 py-10 space-y-10">
        <section className="rounded-xl border border-slate-800 bg-slate-900/40 p-6">
          <h2 className="text-lg font-semibold mb-1">
            Drafting on behalf of {user.displayName}
          </h2>
          <p className="text-sm text-slate-400 mb-6">
            {profileSummary || "Profile incomplete"} · session expires{" "}
            {new Date(sessionExpiresAt).toLocaleTimeString()} ·{" "}
            {profile.completenessPct}% profile complete ·{" "}
            {primer.snippets.length} primer snippet
            {primer.snippets.length === 1 ? "" : "s"} from your library
          </p>

          {launchIntent && (
            <div className="mb-6 rounded-lg border border-sky-500/30 bg-sky-500/5 px-4 py-3">
              <div className="text-[11px] uppercase tracking-wider text-sky-300 font-semibold mb-1">
                Launch intent received
              </div>
              <div className="text-sm text-slate-200 whitespace-pre-wrap">
                {launchIntent}
              </div>
              <div className="text-xs text-slate-500 mt-1">
                Pre-filled into the topic field below — edit it before drafting
                if you want to refine.
              </div>
            </div>
          )}

          <form onSubmit={handleDraft} className="space-y-5">
            <div>
              <label className="block text-[11px] uppercase tracking-wider text-slate-500 mb-2">
                Brief type
              </label>
              <div className="grid sm:grid-cols-3 gap-2">
                {BRIEF_OPTIONS.map((opt) => {
                  const active = opt.value === briefType;
                  return (
                    <button
                      key={opt.value}
                      type="button"
                      onClick={() => setBriefType(opt.value)}
                      className={`text-left rounded-lg border p-3 transition-colors ${
                        active
                          ? "border-sky-400 bg-sky-500/10"
                          : "border-slate-700 bg-slate-950 hover:border-slate-600"
                      }`}
                    >
                      <div
                        className={`text-sm font-medium ${
                          active ? "text-sky-200" : "text-slate-200"
                        }`}
                      >
                        {opt.label}
                      </div>
                      <div className="text-xs text-slate-500 mt-1 leading-snug">
                        {opt.help}
                      </div>
                    </button>
                  );
                })}
              </div>
            </div>

            <div>
              <label
                htmlFor="topic"
                className="block text-[11px] uppercase tracking-wider text-slate-500 mb-2"
              >
                Topic
              </label>
              <input
                id="topic"
                type="text"
                value={topic}
                onChange={(e) => setTopic(e.target.value)}
                placeholder={
                  briefType === "sitrep"
                    ? "e.g. Last 24h of company route clearance ops"
                    : briefType === "opord_paragraph"
                      ? "e.g. Platoon attack on OBJ FALCON, H+0 to H+4"
                      : "e.g. Squad live-fire CALFEX, two iterations day/night"
                }
                className="w-full px-3 py-2 rounded-md bg-slate-950 border border-slate-700 text-slate-100 placeholder-slate-600 focus:border-sky-500 focus:outline-none"
              />
              <p className="text-xs text-slate-500 mt-2">
                Used as the primary library query and as the brief subject.
              </p>
            </div>

            <div>
              <label
                htmlFor="audience"
                className="block text-[11px] uppercase tracking-wider text-slate-500 mb-2"
              >
                Audience override{" "}
                <span className="text-slate-600 normal-case">(optional)</span>
              </label>
              <input
                id="audience"
                type="text"
                value={audience}
                onChange={(e) => setAudience(e.target.value)}
                placeholder={
                  profile.dutyTitle
                    ? `defaults to your higher echelon (${profile.dutyTitle}'s chain)`
                    : "e.g. battalion commander, training NCO"
                }
                className="w-full px-3 py-2 rounded-md bg-slate-950 border border-slate-700 text-slate-100 placeholder-slate-600 focus:border-sky-500 focus:outline-none"
              />
            </div>

            <div className="flex items-center gap-3 pt-2">
              <button
                type="submit"
                disabled={!topic.trim() || draftState.status === "drafting"}
                className="px-4 py-2 rounded-md bg-sky-500 hover:bg-sky-400 disabled:bg-slate-800 disabled:text-slate-600 text-slate-900 font-medium"
              >
                {draftState.status === "drafting"
                  ? "Drafting…"
                  : `Draft ${selectedOption.label}`}
              </button>
              {draftState.status === "drafting" && (
                <span className="text-xs text-slate-500">
                  Pulling library snippets and calling agents…
                </span>
              )}
              {draftState.status === "error" && (
                <span className="text-sm text-rose-300">
                  {draftState.message}
                </span>
              )}
            </div>
          </form>
        </section>

        {draftState.status === "ready" && (
          <section className="rounded-xl border border-slate-800 bg-slate-900/40 p-6">
            <div className="flex items-start justify-between gap-4 mb-4">
              <div>
                <h2 className="text-lg font-semibold">
                  Draft —{" "}
                  {BRIEF_OPTIONS.find(
                    (o) => o.value === draftState.data.briefType,
                  )?.label ?? draftState.data.briefType}
                </h2>
                <p className="text-sm text-slate-400 mt-1">
                  Topic:{" "}
                  <span className="text-slate-300">
                    {draftState.data.topic}
                  </span>
                </p>
              </div>
              <button
                type="button"
                onClick={handleCopy}
                className="shrink-0 px-3 py-1.5 rounded-md bg-slate-800 hover:bg-slate-700 text-slate-100 text-sm border border-slate-700"
              >
                {copyStatus === "copied"
                  ? "Copied ✓"
                  : copyStatus === "error"
                    ? "Copy failed"
                    : "Copy to clipboard"}
              </button>
            </div>
            <textarea
              value={editedDraft}
              onChange={(e) => setEditedDraft(e.target.value)}
              className="w-full min-h-[480px] px-4 py-3 rounded-md bg-slate-950 border border-slate-700 text-slate-100 font-mono text-sm leading-relaxed focus:border-sky-500 focus:outline-none whitespace-pre-wrap"
              spellCheck
            />
            <div className="text-xs text-slate-500 mt-2">
              Edit in place — your changes stay client-side. Use copy to paste
              into your staff product.
            </div>
          </section>
        )}

        {draftState.status === "ready" && (
          <section className="rounded-xl border border-slate-800 bg-slate-900/40 p-6">
            <div className="mb-4">
              <h2 className="text-lg font-semibold">
                Sources used for this draft
              </h2>
              <p className="text-sm text-slate-400 mt-1">
                Snippets from your library that the model was anchored to. If a
                section doesn't show up, the draft falls back to your profile
                only and flags the gap.
              </p>
            </div>
            <div className="mb-4">
              <div className="text-[11px] uppercase tracking-wider text-slate-500 mb-2">
                Library queries run
              </div>
              {draftState.data.queries.length === 0 ? (
                <div className="text-sm text-slate-600 italic">
                  No queries run.
                </div>
              ) : (
                <div className="flex flex-wrap gap-2">
                  {draftState.data.queries.map((q) => (
                    <span
                      key={q}
                      className="text-xs px-2 py-1 rounded-full bg-slate-800 border border-slate-700 text-slate-300 font-mono"
                    >
                      {q}
                    </span>
                  ))}
                </div>
              )}
            </div>
            <div className="space-y-3 mt-4">
              {draftState.data.snippets.length === 0 ? (
                <div className="text-sm text-slate-500">
                  No matching snippets from your library — draft was anchored to
                  your profile only.
                </div>
              ) : (
                draftState.data.snippets.map((s) => (
                  <SnippetView key={s.chunkId} s={s} />
                ))
              )}
            </div>
          </section>
        )}

        <section className="rounded-xl border border-slate-800 bg-slate-900/40 p-6">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-lg font-semibold">Service member profile</h2>
            <span className="text-xs text-slate-500">
              {profile.completenessPct}% complete
            </span>
          </div>
          <div className="grid sm:grid-cols-3 gap-x-8 gap-y-4">
            <Field label="Branch" value={profile.branch} />
            <Field label="Rank" value={profile.rank} />
            <Field label="MOS / Rate / AFSC" value={profile.mosCode} />
            <Field label="Duty title" value={profile.dutyTitle} />
            <Field label="Unit" value={profile.unit} />
            <Field label="Base / location" value={profile.baseLocation} />
            <Field label="Combatant command" value={profile.command} />
          </div>
          {profile.billets && profile.billets.length > 0 && (
            <div className="mt-6">
              <Field label="Billets" value={profile.billets.join(", ")} />
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <BriefDrafterPage />
    </QueryClientProvider>
  );
}

export default App;
