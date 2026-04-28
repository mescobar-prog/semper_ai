import { useEffect, useMemo, useState } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  exchangeContextToken,
  queryLibrary,
  type ContextExchangeResponse,
  type RagSnippet,
} from "@workspace/api-client-react";

const queryClient = new QueryClient();

type ExchangeState =
  | { status: "loading" }
  | { status: "no-token" }
  | { status: "error"; message: string }
  | { status: "ready"; data: ContextExchangeResponse };

function badge(label: string, tone: "neutral" | "good" | "warn" | "info" = "neutral") {
  const tones: Record<string, string> = {
    neutral:
      "bg-slate-700/60 text-slate-100 border border-slate-600",
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

function Snippet({ s }: { s: RagSnippet }) {
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

interface FollowUp {
  id: string;
  query: string;
  snippets: RagSnippet[] | null;
  error: string | null;
  loading: boolean;
}

function ContextEchoPage() {
  const [state, setState] = useState<ExchangeState>({ status: "loading" });
  const [followUps, setFollowUps] = useState<FollowUp[]>([]);
  const [followUpInput, setFollowUpInput] = useState("");

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const token = params.get("token");
    if (!token) {
      setState({ status: "no-token" });
      return;
    }
    exchangeContextToken({ launchToken: token })
      .then((data) => setState({ status: "ready", data }))
      .catch((err: unknown) => {
        const message =
          err instanceof Error ? err.message : "Token exchange failed";
        setState({ status: "error", message });
      });
  }, []);

  const sessionToken =
    state.status === "ready" ? state.data.sessionToken : null;

  async function runFollowUp(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = followUpInput.trim();
    if (!trimmed || !sessionToken) return;
    const id = crypto.randomUUID();
    const draft: FollowUp = {
      id,
      query: trimmed,
      snippets: null,
      error: null,
      loading: true,
    };
    setFollowUps((prev) => [draft, ...prev]);
    setFollowUpInput("");
    try {
      const result = await queryLibrary({
        sessionToken,
        query: trimmed,
        limit: 6,
      });
      setFollowUps((prev) =>
        prev.map((f) =>
          f.id === id
            ? { ...f, snippets: result.snippets, loading: false }
            : f,
        ),
      );
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Library query failed";
      setFollowUps((prev) =>
        prev.map((f) =>
          f.id === id ? { ...f, error: message, loading: false } : f,
        ),
      );
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
            Context Echo
          </div>
          <p className="text-slate-400 leading-relaxed">
            This is the demo tool used by the marketplace launch protocol. To
            see it in action, launch it from the marketplace catalog — the
            marketplace will mint a one-time launch token, and Context Echo
            will exchange that token for the context bundle the marketplace
            forwarded on your behalf.
          </p>
          <a
            href="/"
            className="inline-block mt-2 px-4 py-2 rounded-md bg-sky-500 hover:bg-sky-400 text-slate-900 font-medium"
          >
            Open marketplace
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
            Back to marketplace
          </a>
        </div>
      </div>
    );
  }

  const { tool, user, profile, primer, sessionExpiresAt } = state.data;

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100">
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
          <a
            href="/"
            className="text-sm text-slate-400 hover:text-slate-100"
          >
            ← Back to marketplace
          </a>
        </div>
      </header>

      <div className="max-w-6xl mx-auto px-6 py-10 space-y-10">
        <section className="rounded-xl border border-slate-800 bg-slate-900/40 p-6">
          <h2 className="text-lg font-semibold mb-1">
            Launch payload received
          </h2>
          <p className="text-sm text-slate-400 mb-6">
            This is exactly what the marketplace forwarded to {tool.name}{" "}
            on your behalf. Session token expires{" "}
            {new Date(sessionExpiresAt).toLocaleTimeString()}.
          </p>
          <div className="grid sm:grid-cols-2 gap-x-8 gap-y-4">
            <Field label="Authenticated as" value={user.displayName} />
            <Field label="Email" value={user.email} />
            <Field label="User ID" value={<code className="text-xs">{user.id}</code>} />
            <Field
              label="Session token"
              value={<code className="text-xs break-all">{state.data.sessionToken.slice(0, 24)}…</code>}
            />
          </div>
        </section>

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
            <Field label="Command" value={profile.command} />
            <Field label="Base / location" value={profile.baseLocation} />
            <Field label="Clearance" value={profile.securityClearance} />
            <Field label="Deployment status" value={profile.deploymentStatus} />
          </div>
          {profile.billets.length > 0 && (
            <div className="mt-6">
              <Field
                label="Billets"
                value={
                  <ul className="list-disc list-inside text-slate-200 space-y-0.5">
                    {profile.billets.map((b) => (
                      <li key={b}>{b}</li>
                    ))}
                  </ul>
                }
              />
            </div>
          )}
          {profile.freeFormContext && (
            <div className="mt-6">
              <Field
                label="Narrative context"
                value={
                  <div className="whitespace-pre-wrap text-slate-300">
                    {profile.freeFormContext}
                  </div>
                }
              />
            </div>
          )}
        </section>

        <section className="rounded-xl border border-slate-800 bg-slate-900/40 p-6">
          <div className="mb-4">
            <h2 className="text-lg font-semibold">RAG primer from your library</h2>
            <p className="text-sm text-slate-400 mt-1">
              The marketplace asked Claude to generate search queries from your
              profile and {tool.name}'s description, then ran them against your
              uploaded documents.
            </p>
          </div>
          <div className="mb-4">
            <div className="text-[11px] uppercase tracking-wider text-slate-500 mb-2">
              Generated queries
            </div>
            {primer.queries.length === 0 ? (
              <div className="text-sm text-slate-600 italic">
                No queries generated.
              </div>
            ) : (
              <div className="flex flex-wrap gap-2">
                {primer.queries.map((q) => (
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
          <div className="space-y-3 mt-6">
            {primer.snippets.length === 0 ? (
              <div className="text-sm text-slate-500">
                No matching snippets — upload documents to your library to
                give tools richer primer context.
              </div>
            ) : (
              primer.snippets.map((s) => <Snippet key={s.chunkId} s={s} />)
            )}
          </div>
        </section>

        <section className="rounded-xl border border-slate-800 bg-slate-900/40 p-6">
          <h2 className="text-lg font-semibold mb-1">
            Live library lookup
          </h2>
          <p className="text-sm text-slate-400 mb-4">
            Tools can also issue ad-hoc queries during the session — for
            example, when the user asks a follow-up question.
          </p>
          <form onSubmit={runFollowUp} className="flex gap-2 mb-6">
            <input
              type="text"
              value={followUpInput}
              onChange={(e) => setFollowUpInput(e.target.value)}
              placeholder="e.g. risk assessment matrix, ammo basic load…"
              className="flex-1 px-3 py-2 rounded-md bg-slate-950 border border-slate-700 text-slate-100 placeholder-slate-600 focus:border-sky-500 focus:outline-none"
            />
            <button
              type="submit"
              disabled={!followUpInput.trim()}
              className="px-4 py-2 rounded-md bg-sky-500 hover:bg-sky-400 disabled:bg-slate-800 disabled:text-slate-600 text-slate-900 font-medium"
            >
              Query library
            </button>
          </form>
          <div className="space-y-6">
            {followUps.map((f) => (
              <div key={f.id} className="space-y-2">
                <div className="text-sm text-slate-300">
                  <span className="text-slate-500">query · </span>
                  <span className="font-mono">{f.query}</span>
                </div>
                {f.loading && (
                  <div className="text-sm text-slate-500">Searching…</div>
                )}
                {f.error && (
                  <div className="text-sm text-rose-300">{f.error}</div>
                )}
                {f.snippets &&
                  (f.snippets.length === 0 ? (
                    <div className="text-sm text-slate-600 italic">
                      No matches.
                    </div>
                  ) : (
                    <div className="space-y-3">
                      {f.snippets.map((s) => (
                        <Snippet key={s.chunkId} s={s} />
                      ))}
                    </div>
                  ))}
              </div>
            ))}
          </div>
        </section>
      </div>
    </div>
  );
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <ContextEchoPage />
    </QueryClientProvider>
  );
}

export default App;
