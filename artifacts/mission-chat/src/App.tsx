import { useEffect, useRef, useState } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  exchangeContextToken,
  type ContextExchangeResponse,
  type RagSnippet,
} from "@workspace/api-client-react";

const queryClient = new QueryClient();

type ExchangeState =
  | { status: "loading" }
  | { status: "no-token" }
  | { status: "error"; message: string }
  | { status: "ready"; data: ContextExchangeResponse };

interface OperatorContextPayload {
  /** Marker so MessageBubble knows to render this as a structured card. */
  kind: "operator-context";
  data: ContextExchangeResponse;
}

interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  /** Plain text body. Empty for the structured opening turn. */
  content: string;
  /** Library snippets the server pulled for THIS user question. */
  snippets?: RagSnippet[];
  /** True while the assistant turn is still streaming. */
  pending?: boolean;
  /** Set on an assistant turn that failed mid-stream. */
  error?: string;
  /** ID of the user message that produced this assistant turn (used for Retry). */
  parentUserId?: string;
  /** Structured opening-turn payload (only on the first assistant message). */
  payload?: OperatorContextPayload;
}

const COLLAPSE_CHAR_LIMIT = 320;

function badgeClass(tone: "neutral" | "good" | "warn" | "info") {
  const tones: Record<string, string> = {
    neutral: "bg-slate-700/60 text-slate-100 border border-slate-600",
    good: "bg-emerald-500/15 text-emerald-300 border border-emerald-400/40",
    warn: "bg-amber-500/15 text-amber-200 border border-amber-400/40",
    info: "bg-sky-500/15 text-sky-200 border border-sky-400/40",
  };
  return `inline-flex items-center px-2 py-0.5 rounded text-[11px] font-medium tracking-wide uppercase ${tones[tone]}`;
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

function newId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * A long block of text that collapses past COLLAPSE_CHAR_LIMIT chars
 * with a "Show more / less" toggle so the opening turn never wallpapers
 * the screen.
 */
function CollapsibleText({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  if (!text) return null;
  const tooLong = text.length > COLLAPSE_CHAR_LIMIT;
  const shown = !tooLong || open ? text : text.slice(0, COLLAPSE_CHAR_LIMIT) + "…";
  return (
    <div>
      <div className="text-sm text-slate-200 whitespace-pre-wrap leading-relaxed">
        {shown}
      </div>
      {tooLong && (
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="mt-1 text-[11px] uppercase tracking-wider text-sky-400 hover:text-sky-300"
        >
          {open ? "Show less" : "Show more"}
        </button>
      )}
    </div>
  );
}

/**
 * Citation chip — collapsed by default to a one-line "title · #idx ·
 * score" pill; click to expand and reveal the full snippet text.
 */
function CitationChip({ snippet }: { snippet: RagSnippet }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="rounded-md border border-slate-700/70 bg-slate-950/60">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center justify-between gap-2 px-3 py-2 text-left hover:bg-slate-900/60 rounded-md"
        aria-expanded={open}
      >
        <span className="text-xs font-medium text-slate-200 truncate">
          {snippet.documentTitle}
        </span>
        <span className="text-[10px] uppercase tracking-wider text-slate-500 shrink-0">
          #{snippet.chunkIndex} · {snippet.score.toFixed(3)}
          <span className="ml-2 text-slate-600">{open ? "▾" : "▸"}</span>
        </span>
      </button>
      {open && (
        <div className="px-3 pb-3 text-xs text-slate-400 whitespace-pre-wrap leading-relaxed font-mono">
          {snippet.content}
        </div>
      )}
    </div>
  );
}

/**
 * Structured opening-turn card. Three sections — **You**, **Your
 * situation**, **From your library** — so the operator can see at a
 * glance what context the assistant is grounded in. Long sections
 * collapse; library snippets render as expandable citation chips.
 */
function OperatorContextCard({ data }: { data: ContextExchangeResponse }) {
  const { user, profile, contextBlock, primer, launchIntent, presetName } =
    data;

  const youLines: string[] = [];
  if (profile.rank) youLines.push(`**Rank:** ${profile.rank}`);
  if (profile.dutyTitle) youLines.push(`**Duty:** ${profile.dutyTitle}`);
  if (profile.unit) youLines.push(`**Unit:** ${profile.unit}`);
  if (profile.branch) youLines.push(`**Branch:** ${profile.branch}`);
  const youSummary = youLines.length
    ? youLines.join(" · ").replace(/\*\*/g, "")
    : "Profile is not filled in yet.";

  const situationParts: string[] = [];
  if (contextBlock.intent)
    situationParts.push(`Intent — ${contextBlock.intent}`);
  if (contextBlock.environment)
    situationParts.push(`Environment — ${contextBlock.environment}`);
  if (contextBlock.constraints)
    situationParts.push(`Constraints — ${contextBlock.constraints}`);
  if (contextBlock.risk) situationParts.push(`Risk — ${contextBlock.risk}`);
  if (contextBlock.experience)
    situationParts.push(`Experience — ${contextBlock.experience}`);
  if (contextBlock.doctrine)
    situationParts.push(`Doctrine — ${contextBlock.doctrine}`);
  const situationText = situationParts.join("\n\n");
  const cbConfirmed = Boolean(contextBlock.confirmedAt);

  return (
    <div className="space-y-4">
      <div className="text-sm text-slate-300 leading-relaxed">
        Mission Chat is live for{" "}
        <span className="font-semibold text-slate-100">{user.displayName}</span>
        . You're grounded against the{" "}
        <span className="font-semibold text-sky-300">{presetName}</span> preset.
        Ask anything below — I'll pull fresh library snippets for every
        question.
      </div>

      {/* Section: You */}
      <section>
        <div className="text-[11px] uppercase tracking-[0.18em] text-sky-400 font-semibold mb-1.5">
          You
        </div>
        <div className="rounded-md border border-slate-800 bg-slate-950/40 px-3 py-2 text-sm text-slate-200">
          {youSummary}
        </div>
      </section>

      {/* Section: Your situation */}
      <section>
        <div className="flex items-center gap-2 mb-1.5">
          <span className="text-[11px] uppercase tracking-[0.18em] text-sky-400 font-semibold">
            Your situation
          </span>
          <span
            className={badgeClass(cbConfirmed ? "good" : "warn")}
            title={
              cbConfirmed
                ? "Context Block confirmed for this preset"
                : "Context Block not yet confirmed"
            }
          >
            {cbConfirmed ? "Context Confirmed" : "Context Unconfirmed"}
          </span>
        </div>
        {situationText ? (
          <div className="rounded-md border border-slate-800 bg-slate-950/40 px-3 py-2">
            <CollapsibleText text={situationText} />
          </div>
        ) : (
          <div className="rounded-md border border-slate-800 bg-slate-950/40 px-3 py-2 text-sm text-slate-500 italic">
            6-element Context Block hasn't been filled in yet.
          </div>
        )}
        {launchIntent?.trim() && (
          <div className="mt-2">
            <div className="text-[10px] uppercase tracking-wider text-slate-500 mb-1">
              You said you'd ask
            </div>
            <button
              type="button"
              className="text-left text-sm text-slate-200 italic px-3 py-2 rounded-md border border-sky-500/30 bg-sky-500/5 w-full hover:bg-sky-500/10"
              title="Pre-filled into the input below — edit or send as-is."
            >
              "{launchIntent.trim()}"
            </button>
          </div>
        )}
      </section>

      {/* Section: From your library */}
      <section>
        <div className="text-[11px] uppercase tracking-[0.18em] text-sky-400 font-semibold mb-1.5">
          From your library
        </div>
        {primer.snippets.length === 0 ? (
          <div className="rounded-md border border-slate-800 bg-slate-950/40 px-3 py-2 text-sm text-slate-500 italic">
            No library snippets were attached at launch. I'll fetch fresh
            snippets for each question you send.
          </div>
        ) : (
          <div className="space-y-1.5">
            {primer.snippets.map((s) => (
              <CitationChip key={s.chunkId} snippet={s} />
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

function FollowupSnippetList({ snippets }: { snippets: RagSnippet[] }) {
  if (!snippets.length) return null;
  return (
    <details className="mt-3 group">
      <summary className="cursor-pointer text-[11px] uppercase tracking-wider text-slate-500 hover:text-slate-300 select-none">
        Library snippets used ({snippets.length})
      </summary>
      <div className="mt-2 space-y-1.5">
        {snippets.map((s) => (
          <CitationChip key={s.chunkId} snippet={s} />
        ))}
      </div>
    </details>
  );
}

function MessageBubble({
  msg,
  onRetry,
}: {
  msg: ChatMessage;
  onRetry: (assistantId: string) => void;
}) {
  if (msg.role === "user") {
    return (
      <div className="flex justify-end">
        <div className="max-w-[80%] rounded-2xl rounded-tr-sm bg-sky-500/15 border border-sky-500/30 px-4 py-3 text-sm text-slate-100 whitespace-pre-wrap leading-relaxed">
          {msg.content}
        </div>
      </div>
    );
  }
  return (
    <div className="flex justify-start">
      <div className="max-w-[85%] w-full rounded-2xl rounded-tl-sm bg-slate-900/60 border border-slate-700/70 px-4 py-3">
        <div className="text-[11px] uppercase tracking-wider text-slate-500 mb-1.5">
          Mission Chat
        </div>

        {msg.payload?.kind === "operator-context" ? (
          <OperatorContextCard data={msg.payload.data} />
        ) : msg.error ? (
          <div className="space-y-2">
            <div className="text-sm text-rose-300 whitespace-pre-wrap leading-relaxed">
              {msg.content
                ? `${msg.content}\n\n— ${msg.error}`
                : `Reply failed: ${msg.error}`}
            </div>
            {msg.parentUserId && (
              <button
                type="button"
                onClick={() => onRetry(msg.id)}
                className="inline-flex items-center gap-1.5 px-3 py-1 rounded-md bg-rose-500/15 hover:bg-rose-500/25 text-rose-200 border border-rose-400/40 text-xs font-medium"
              >
                ↻ Retry
              </button>
            )}
          </div>
        ) : (
          <div className="text-sm text-slate-100 whitespace-pre-wrap leading-relaxed">
            {msg.content || (
              <span className="inline-flex items-center gap-1 text-slate-500">
                <span className="w-1.5 h-1.5 rounded-full bg-slate-500 animate-pulse" />
                <span className="w-1.5 h-1.5 rounded-full bg-slate-500 animate-pulse [animation-delay:120ms]" />
                <span className="w-1.5 h-1.5 rounded-full bg-slate-500 animate-pulse [animation-delay:240ms]" />
              </span>
            )}
            {msg.pending && msg.content && (
              <span className="ml-1 inline-block w-2 h-4 align-middle bg-slate-400 animate-pulse" />
            )}
          </div>
        )}

        {msg.snippets && <FollowupSnippetList snippets={msg.snippets} />}
      </div>
    </div>
  );
}

interface StreamFrame {
  type: "text" | "snippets" | "done" | "error";
  delta?: string;
  snippets?: RagSnippet[];
  message?: string;
}

async function* streamFrames(
  response: Response,
): AsyncGenerator<StreamFrame, void, unknown> {
  if (!response.body) {
    throw new Error("Stream has no body");
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      if (!line) continue;
      try {
        yield JSON.parse(line) as StreamFrame;
      } catch {
        // Skip malformed lines defensively.
      }
    }
  }
  buffer += decoder.decode();
  const tail = buffer.trim();
  if (tail) {
    try {
      yield JSON.parse(tail) as StreamFrame;
    } catch {
      /* ignore */
    }
  }
}

function MissionChatPage() {
  const [state, setState] = useState<ExchangeState>({ status: "loading" });
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const abortRef = useRef<AbortController | null>(null);

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

        // The opening turn is a structured "operator context" card, not
        // a generic greeting — see OperatorContextCard. We render it as
        // a special assistant message with payload.kind === "operator-
        // context". Keeping it inside the chat stream means it scrolls
        // with the conversation and stays visible as the user scrolls
        // back to remind themselves what the assistant was primed with.
        setMessages([
          {
            id: newId(),
            role: "assistant",
            content: "",
            payload: { kind: "operator-context", data },
          },
        ]);

        // Pre-fill the input with the launch intent so the operator can
        // press Send to ask exactly what they typed at launch.
        if (data.launchIntent?.trim()) {
          setInput(data.launchIntent.trim());
        }
      })
      .catch((err: unknown) => {
        const message =
          err instanceof Error ? err.message : "Token exchange failed";
        setState({ status: "error", message });
      });
  }, []);

  // Auto-scroll to bottom whenever messages change.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
  }, [messages]);

  // Cancel any in-flight stream on unmount.
  useEffect(() => {
    return () => abortRef.current?.abort();
  }, []);

  const sessionToken =
    state.status === "ready" ? state.data.sessionToken : null;

  /**
   * Stream a reply for a given assistant placeholder. The history we
   * send to the server is everything BEFORE the placeholder that has a
   * resolved, error-free body — so retries don't leak partial content
   * from a prior failed attempt and the structured opening-turn payload
   * (which has empty content) is correctly excluded.
   */
  async function streamReplyFor(assistantId: string) {
    if (!sessionToken) return;

    const controller = new AbortController();
    abortRef.current = controller;
    setSending(true);

    // Build the wire history from current state at the moment we send.
    let wireHistory: { role: "user" | "assistant"; content: string }[] = [];
    setMessages((prev) => {
      const idx = prev.findIndex((m) => m.id === assistantId);
      if (idx === -1) return prev;
      wireHistory = prev
        .slice(0, idx)
        .filter(
          (m) =>
            !m.pending &&
            !m.error &&
            !m.payload &&
            m.content.trim().length > 0,
        )
        .map((m) => ({ role: m.role, content: m.content }));
      // Reset the placeholder to "pending, no error, no partial body".
      return prev.map((m) =>
        m.id === assistantId
          ? { ...m, content: "", error: undefined, pending: true }
          : m,
      );
    });

    try {
      const response = await fetch("/api/tools/mission-chat/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sessionToken,
          messages: wireHistory,
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        let errMsg = `Server returned ${response.status}`;
        try {
          const body = (await response.json()) as { error?: string };
          if (body?.error) errMsg = body.error;
        } catch {
          /* ignore */
        }
        throw new Error(errMsg);
      }

      let sawError: string | null = null;
      let sawDone = false;
      for await (const frame of streamFrames(response)) {
        if (frame.type === "snippets" && frame.snippets) {
          const snippets = frame.snippets;
          setMessages((prev) =>
            prev.map((m) => (m.id === assistantId ? { ...m, snippets } : m)),
          );
        } else if (frame.type === "text" && frame.delta) {
          const delta = frame.delta;
          setMessages((prev) =>
            prev.map((m) =>
              m.id === assistantId
                ? { ...m, content: m.content + delta }
                : m,
            ),
          );
        } else if (frame.type === "error") {
          sawError = frame.message || "Stream error";
        } else if (frame.type === "done") {
          sawDone = true;
        }
      }

      if (sawError) {
        throw new Error(sawError);
      }
      // The server emits an explicit `done` sentinel as the last frame.
      // If we reach EOF without seeing it, the connection was cut mid-
      // stream (proxy timeout, network drop, server crash, etc.) and any
      // text we already rendered is partial. Surface this as a retryable
      // error rather than silently treating the partial answer as
      // complete — the user can hit Retry to replay the same turn.
      if (!sawDone) {
        throw new Error(
          "Connection dropped before the reply finished — partial response.",
        );
      }

      setMessages((prev) =>
        prev.map((m) =>
          m.id === assistantId ? { ...m, pending: false } : m,
        ),
      );
    } catch (err) {
      if (controller.signal.aborted) {
        return;
      }
      const message =
        err instanceof Error ? err.message : "Reply failed unexpectedly";
      setMessages((prev) =>
        prev.map((m) =>
          m.id === assistantId
            ? { ...m, pending: false, error: message }
            : m,
        ),
      );
    } finally {
      if (abortRef.current === controller) abortRef.current = null;
      setSending(false);
    }
  }

  async function handleSend(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = input.trim();
    if (!trimmed || !sessionToken || sending) return;

    const userId = newId();
    const assistantId = newId();
    setMessages((prev) => [
      ...prev,
      { id: userId, role: "user", content: trimmed },
      {
        id: assistantId,
        role: "assistant",
        content: "",
        pending: true,
        parentUserId: userId,
      },
    ]);
    setInput("");

    await streamReplyFor(assistantId);
  }

  /**
   * Inline retry for a failed assistant message — replays only that
   * failed turn while preserving the rest of the conversation history.
   */
  function handleRetry(assistantId: string) {
    if (sending) return;
    void streamReplyFor(assistantId);
  }

  function handleClear() {
    if (state.status !== "ready") return;
    if (sending) {
      abortRef.current?.abort();
      setSending(false);
    }
    setMessages([
      {
        id: newId(),
        role: "assistant",
        content: "",
        payload: { kind: "operator-context", data: state.data },
      },
    ]);
    setInput("");
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
            Mission Chat
          </div>
          <p className="text-slate-400 leading-relaxed">
            This tool opens a streaming chat primed with your operator profile,
            your 6-element Context Block, and the snippets you approved at
            launch. Launch it from the marketplace catalog so the marketplace
            can mint a one-time launch token for you.
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

  const { tool, user, profile, primer, sessionExpiresAt, presetName } =
    state.data;

  const profileSummaryParts: string[] = [];
  if (profile.rank) profileSummaryParts.push(profile.rank);
  if (profile.dutyTitle) profileSummaryParts.push(profile.dutyTitle);
  if (profile.unit) profileSummaryParts.push(profile.unit);
  const profileSummary = profileSummaryParts.join(" · ");

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 flex flex-col">
      <div
        role="status"
        aria-label="Classification banner"
        className="w-full bg-green-500 text-black font-bold text-center text-sm tracking-widest uppercase py-1.5 border-b border-green-700"
      >
        UNCLASSIFIED (DEMO)
      </div>
      <header className="border-b border-slate-800 bg-slate-900/40 backdrop-blur sticky top-0 z-10">
        <div className="max-w-5xl mx-auto px-6 py-4 flex items-center justify-between gap-4">
          <div className="space-y-1 min-w-0">
            <div className="flex items-center gap-3 flex-wrap">
              <span className="text-[11px] uppercase tracking-[0.2em] text-sky-400 font-semibold">
                Demo Tool
              </span>
              <span className="text-slate-600">·</span>
              <span className="text-sm text-slate-400 truncate">
                {tool.vendor}
              </span>
              <span className="text-slate-600">·</span>
              <span
                className="text-xs text-slate-300 inline-flex items-center gap-1"
                title="Active mission preset"
              >
                <span className="text-[10px] uppercase tracking-wider text-slate-500">
                  Preset:
                </span>
                <span className="font-medium text-sky-300">{presetName}</span>
              </span>
            </div>
            <div className="flex items-center gap-3">
              <h1 className="text-2xl font-semibold tracking-tight">
                {tool.name}
              </h1>
              <span className={badgeClass(atoTone(tool.atoStatus))}>
                {atoLabel(tool.atoStatus)}
              </span>
            </div>
          </div>
          <a
            href="/"
            className="text-sm text-slate-400 hover:text-slate-100 shrink-0"
          >
            ← Back to marketplace
          </a>
        </div>
      </header>

      <div className="max-w-5xl w-full mx-auto px-6 pt-6 shrink-0">
        <div className="rounded-xl border border-slate-800 bg-slate-900/40 px-5 py-4 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
          <div className="text-slate-200 font-medium">{user.displayName}</div>
          <div className="text-slate-500">·</div>
          <div className="text-slate-400">
            {profileSummary || "Profile incomplete"}
          </div>
          <div className="text-slate-500">·</div>
          <div className="text-slate-400">
            {profile.completenessPct}% profile complete
          </div>
          <div className="text-slate-500">·</div>
          <div className="text-slate-400">
            {primer.snippets.length} primer snippet
            {primer.snippets.length === 1 ? "" : "s"}
          </div>
          <div className="ml-auto text-xs text-slate-500">
            Session expires {new Date(sessionExpiresAt).toLocaleTimeString()}
          </div>
        </div>
      </div>

      <main className="flex-1 max-w-5xl w-full mx-auto px-6 py-6 flex flex-col min-h-0">
        <div
          ref={scrollRef}
          className="flex-1 overflow-y-auto space-y-4 pb-4 pr-1"
          aria-live="polite"
        >
          {messages.map((m) => (
            <MessageBubble key={m.id} msg={m} onRetry={handleRetry} />
          ))}
        </div>

        <form
          onSubmit={handleSend}
          className="mt-2 rounded-xl border border-slate-800 bg-slate-900/60 p-3"
        >
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                void handleSend(e as unknown as React.FormEvent);
              }
            }}
            rows={3}
            placeholder="Ask about your mission, doctrine, SOPs, or anything else — Enter to send, Shift+Enter for newline."
            className="w-full bg-transparent text-slate-100 placeholder-slate-600 focus:outline-none resize-none px-2 py-1 text-sm leading-relaxed"
            disabled={sending}
          />
          <div className="flex items-center justify-between gap-3 mt-2 px-1">
            <div className="text-xs text-slate-500">
              History lives in this browser tab only — refresh to start over.
            </div>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={handleClear}
                className="px-3 py-1.5 rounded-md bg-slate-800 hover:bg-slate-700 text-slate-300 text-sm border border-slate-700"
              >
                Clear
              </button>
              <button
                type="submit"
                disabled={!input.trim() || sending}
                className="px-4 py-1.5 rounded-md bg-sky-500 hover:bg-sky-400 disabled:bg-slate-800 disabled:text-slate-600 text-slate-900 font-medium text-sm"
              >
                {sending ? "Streaming…" : "Send"}
              </button>
            </div>
          </div>
        </form>
      </main>
    </div>
  );
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <MissionChatPage />
    </QueryClientProvider>
  );
}

export default App;
