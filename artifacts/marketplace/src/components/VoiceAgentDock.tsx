import { useEffect, useMemo, useRef, useState } from "react";
import { useLocation } from "wouter";
import {
  ConversationProvider,
  useConversation,
} from "@elevenlabs/react";
import type { ClientTools } from "@elevenlabs/react";
import { useCreateVoiceAgentSession } from "@workspace/api-client-react";
import {
  runVoiceTool,
  setVoiceNav,
} from "@/lib/voiceBridge";

/**
 * The set of client tools the agent can call. Names must match the
 * tool definitions sent to ElevenLabs in `agentCreatePayload()` on the
 * server. Implementations forward to the bridge so individual pages
 * (Profile, Catalog, CatalogBrowse, CatalogDetail) own the actual logic.
 */
const TOOL_NAMES = [
  "getCurrentRoute",
  "navigate",
  "getProfileState",
  "setProfileField",
  "getContextBlockState",
  "setContextBlockElement",
  "clickEvaluate",
  "clickConfirmContextBlock",
  "goToCatalogBrowse",
  "findTool",
  "openTool",
  "clickLaunchWithMyContext",
] as const;

function buildClientTools(): ClientTools {
  const tools: ClientTools = {};
  for (const name of TOOL_NAMES) {
    tools[name] = async (params) => runVoiceTool(name, params ?? {});
  }
  return tools;
}

/**
 * The actual mic UI. Must live inside <ConversationProvider> so the
 * useConversation hook has its context.
 */
function VoiceAgentDockInner() {
  const [location, setLocation] = useLocation();

  // Bridge needs access to the live wouter location + setter so non-React
  // code (the bridge) can navigate. Re-register every render so the
  // closure always sees the latest location string.
  useEffect(() => {
    return setVoiceNav({
      getCurrentRoute: () => location,
      navigate: (to: string) => setLocation(to),
    });
  }, [location, setLocation]);

  const clientTools = useMemo(buildClientTools, []);

  const conversation = useConversation({
    clientTools,
    onError: (err: unknown) => {
      const msg =
        err instanceof Error
          ? err.message
          : ((err as { message?: string })?.message ?? String(err));
      setLocalError(msg ?? "Voice agent error");
    },
  });

  const sessionMutation = useCreateVoiceAgentSession();
  const [localError, setLocalError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  // Track whether we already kicked off a startSession this click so we
  // don't double-fire if the user spam-clicks the mic.
  const startingRef = useRef(false);

  const status = conversation.status;
  const isLive = status === "connected";
  const isConnecting = status === "connecting" || sessionMutation.isPending;

  const start = async () => {
    if (startingRef.current || isLive || isConnecting) return;
    startingRef.current = true;
    setLocalError(null);
    try {
      // Feature-detect mediaDevices before touching it. Older browsers
      // (or non-secure contexts like plain http://) won't expose it and
      // would otherwise throw an opaque "Cannot read properties of
      // undefined" error inside the SDK.
      if (
        typeof navigator === "undefined" ||
        !navigator.mediaDevices ||
        typeof navigator.mediaDevices.getUserMedia !== "function"
      ) {
        setLocalError(
          "This browser does not support microphone access. Use a recent Chrome, Edge, or Safari over HTTPS.",
        );
        setOpen(true);
        return;
      }
      // Mic permission must be granted before opening the WebSocket — the
      // SDK will throw a less-helpful "NotAllowedError" otherwise. We
      // immediately stop every track on the preflight stream so we don't
      // leave a second mic-capture pipeline alive alongside the one the
      // SDK opens for the actual session.
      const preflight = await navigator.mediaDevices.getUserMedia({ audio: true });
      preflight.getTracks().forEach((t) => t.stop());
      const session = await sessionMutation.mutateAsync();
      // Await so any SDK startup error (bad signed URL, WebSocket
      // refusal, etc.) surfaces in this try/catch instead of being lost
      // to an unhandled rejection.
      await conversation.startSession({ signedUrl: session.signedUrl });
      setOpen(true);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("Permission denied") || msg.includes("NotAllowedError")) {
        setLocalError("Microphone permission denied. Enable it in your browser settings.");
      } else if (
        msg.includes("NotFoundError") ||
        msg.includes("Requested device not found")
      ) {
        setLocalError("No microphone detected. Plug one in and try again.");
      } else {
        setLocalError(msg);
      }
      setOpen(true);
    } finally {
      startingRef.current = false;
    }
  };

  const stop = () => {
    try {
      conversation.endSession();
    } catch {
      /* no-op */
    }
  };

  // Show the panel as soon as we connect; collapse if we drop back to
  // disconnected so the user can re-engage with one click.
  useEffect(() => {
    if (isLive) setOpen(true);
    if (status === "disconnected") setOpen(false);
  }, [isLive, status]);

  return (
    <div
      className="fixed bottom-6 right-6 z-[100] flex flex-col items-end gap-2"
      data-testid="voice-agent-dock"
    >
      {open && (isLive || isConnecting || localError) && (
        <div
          role="status"
          aria-live="polite"
          className="max-w-xs rounded-lg border border-border bg-card text-card-foreground shadow-lg p-3 text-xs space-y-2"
        >
          <div className="flex items-center gap-2">
            <span
              className={`inline-block w-2 h-2 rounded-full ${
                isLive
                  ? conversation.isSpeaking
                    ? "bg-amber-400 animate-pulse"
                    : "bg-emerald-400"
                  : isConnecting
                    ? "bg-amber-400 animate-pulse"
                    : "bg-rose-400"
              }`}
            />
            <span className="font-mono uppercase tracking-wider text-[10px] text-muted-foreground">
              {isLive
                ? conversation.isSpeaking
                  ? "Drill instructor speaking…"
                  : conversation.isListening
                    ? "Listening"
                    : "On the line"
                : isConnecting
                  ? "Connecting…"
                  : "Voice agent"}
            </span>
          </div>
          {localError && (
            <div className="text-rose-400 leading-snug">{localError}</div>
          )}
          {isLive && !localError && (
            <div className="text-muted-foreground leading-snug">
              Speak your orders. Say "go to the profile", "evaluate", or name
              a tool.
            </div>
          )}
          {isLive && (
            <button
              type="button"
              onClick={stop}
              data-testid="voice-agent-end"
              className="w-full rounded-md border border-border px-2 py-1.5 text-[11px] font-mono uppercase tracking-wider hover:border-rose-400/50 hover:text-rose-300 transition-colors"
            >
              End conversation
            </button>
          )}
        </div>
      )}
      <button
        type="button"
        onClick={isLive ? stop : start}
        disabled={isConnecting}
        aria-label={isLive ? "End voice agent" : "Start voice agent"}
        aria-pressed={isLive}
        data-testid="voice-agent-toggle"
        className={`h-14 w-14 rounded-full shadow-lg flex items-center justify-center transition-colors border-2 disabled:opacity-60 ${
          isLive
            ? "bg-rose-500 border-rose-300 text-white hover:bg-rose-600"
            : isConnecting
              ? "bg-amber-500 border-amber-300 text-black"
              : "bg-primary border-primary/40 text-primary-foreground hover:bg-primary/90"
        }`}
      >
        <MicIcon active={isLive} />
      </button>
    </div>
  );
}

function MicIcon({ active }: { active: boolean }) {
  return (
    <svg
      width="22"
      height="22"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="9" y="2" width="6" height="13" rx="3" />
      <path d="M5 11a7 7 0 0 0 14 0" />
      <path d="M12 18v4" />
      <path d="M9 22h6" />
      {active && (
        <circle cx="20" cy="4" r="2" fill="currentColor" stroke="none" />
      )}
    </svg>
  );
}

/**
 * Public entry point. Wraps the inner dock in a ConversationProvider so
 * useConversation has its required context. Mounted from `<Layout>` so
 * the mic appears on every authenticated page.
 */
export function VoiceAgentDock() {
  return (
    <ConversationProvider>
      <VoiceAgentDockInner />
    </ConversationProvider>
  );
}
