import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useCreateLaunchAffirmation,
  getGetLaunchAffirmationQueryKey,
  type ContextBlockState,
  type MissionPreset,
  type LaunchNeedsAffirmation,
} from "@workspace/api-client-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";

export interface AffirmationPrompt {
  presetId: string;
  contextBlockVersion: number;
  preset: MissionPreset;
  contextBlock: ContextBlockState;
}

interface Props {
  /**
   * When non-null, the dialog is open and renders the supplied preset +
   * context-block snapshot. Both the launch endpoint (409) and the affirm
   * endpoint (409 on mismatch) return this same shape, so the dialog can
   * recover from a stale-version conflict by simply replacing this prop
   * with the fresh payload from the server.
   */
  prompt: AffirmationPrompt | null;
  onClose: () => void;
  /** Fired after a successful affirmation so the caller can retry the launch. */
  onAffirmed: () => void;
}

/**
 * Launch-time context confirmation modal (Task #45).
 *
 * Renders the active mission preset summary alongside the user's six
 * context-block elements and asks the operator to affirm the block is
 * still current before any tool launch. The affirmation is sent to the
 * server keyed on (presetId, contextBlockVersion); on success the parent
 * retries the launch. If the user's context block changed between the
 * gate check and the affirm POST (rare but possible), the server returns
 * a fresh 409 which we swap in-place so the modal re-renders against the
 * new snapshot without closing.
 */
export function LaunchAffirmationDialog({
  prompt,
  onClose,
  onAffirmed,
}: Props) {
  const queryClient = useQueryClient();
  const affirmMutation = useCreateLaunchAffirmation();

  // Local mirror of the prompt so we can replace it in-place when the
  // server returns a 409 with a fresher snapshot. We can't just call
  // onClose+reopen because the parent's gate check is asynchronous.
  const [current, setCurrent] = useState<AffirmationPrompt | null>(prompt);
  const [confirmed, setConfirmed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // Sync external prompt changes (new launch attempt for a different tool,
  // or close from parent). Reset the checkbox + error so the operator
  // can't accidentally inherit a stale "already checked" state.
  if (prompt !== current) {
    setCurrent(prompt);
    setConfirmed(false);
    setError(null);
  }

  const handleAffirm = async () => {
    if (!current) return;
    setSubmitting(true);
    setError(null);
    try {
      await affirmMutation.mutateAsync({
        data: {
          presetId: current.presetId,
          contextBlockVersion: current.contextBlockVersion,
        },
      });
      // Refresh the cached affirmation status so the catalog page's
      // indicator flips immediately to "preset confirmed for this session".
      queryClient.invalidateQueries({
        queryKey: getGetLaunchAffirmationQueryKey(),
      });
      onAffirmed();
    } catch (err) {
      // The affirm endpoint returns the same 409 shape as the gate when
      // the user's preset/CB version drifted under us. Swap the prompt in
      // place so the modal shows the new context without closing.
      const stale = extractStalePayload(err);
      if (stale) {
        setCurrent(stale);
        setConfirmed(false);
        setError(
          "Your context block changed since you opened this dialog. Please review the updated content and re-confirm.",
        );
      } else {
        setError(
          err instanceof Error ? err.message : "Could not record affirmation.",
        );
      }
    } finally {
      setSubmitting(false);
    }
  };

  const open = !!current;
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Confirm your context before launching</DialogTitle>
          <DialogDescription>
            Tools see this snapshot of your active profile preset. Confirm it
            still reflects today's mission, environment, and constraints
            before we mint a launch token.
          </DialogDescription>
        </DialogHeader>

        {current && (
          <div className="space-y-5">
            <section>
              <SectionLabel title="Active mission preset" />
              <div className="mt-2 rounded-md border border-border bg-card px-4 py-3">
                <div className="text-sm font-medium text-foreground">
                  {current.preset.name}
                </div>
                {current.preset.description && (
                  <div className="text-xs text-muted-foreground mt-1">
                    {current.preset.description}
                  </div>
                )}
                <div className="text-[10px] font-mono uppercase tracking-wider text-muted-foreground mt-2">
                  Context block v{current.contextBlockVersion}
                </div>
              </div>
            </section>

            {current.contextBlock.bypassed && (
              <div
                role="alert"
                className="rounded-md border border-amber-500/50 bg-amber-500/10 p-3 text-xs text-amber-200"
              >
                <div className="font-semibold uppercase tracking-wider text-[10px] text-amber-300 mb-1">
                  Lower-assurance context
                </div>
                This context block was confirmed under the 10/12 review
                threshold. Tools you launch will see a flag indicating the
                block was operator-bypassed; proceed only if that level of
                assurance is acceptable for the work ahead.
              </div>
            )}

            <section>
              <SectionLabel title="Six-element context block" />
              <ContextBlockGrid cb={current.contextBlock} />
            </section>

            {error && (
              <div className="rounded border border-rose-500/40 bg-rose-500/5 p-3 text-sm text-rose-300">
                {error}
              </div>
            )}

            <label className="flex items-start gap-3 rounded-md border border-border bg-card px-4 py-3 cursor-pointer">
              <input
                type="checkbox"
                checked={confirmed}
                onChange={(e) => setConfirmed(e.target.checked)}
                className="mt-0.5 h-4 w-4 rounded border-border bg-background text-primary focus:ring-primary"
              />
              <span className="text-sm text-foreground">
                I confirm this preset and context block are current and apply
                to the work I'm about to launch.
              </span>
            </label>

            <div className="flex items-center justify-end gap-2 pt-2 border-t border-border">
              <button
                type="button"
                onClick={onClose}
                disabled={submitting}
                className="h-9 px-4 rounded-md border border-border text-sm hover:bg-accent/50 disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleAffirm}
                disabled={!confirmed || submitting}
                className="h-9 px-4 rounded-md bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 disabled:opacity-50"
              >
                {submitting ? "Confirming…" : "Confirm and continue"}
              </button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

function SectionLabel({ title }: { title: string }) {
  return (
    <div className="text-[10px] font-mono uppercase tracking-wider text-muted-foreground font-semibold">
      {title}
    </div>
  );
}

function ContextBlockGrid({ cb }: { cb: ContextBlockState }) {
  const elements: Array<{ label: string; value: string | null }> = [
    { label: "Doctrine", value: cb.doctrine },
    { label: "Intent", value: cb.intent },
    { label: "Environment", value: cb.environment },
    { label: "Constraints", value: cb.constraints },
    { label: "Risk", value: cb.risk },
    { label: "Experience", value: cb.experience },
  ];
  return (
    <ul className="mt-2 grid gap-2 sm:grid-cols-2">
      {elements.map((el) => (
        <li
          key={el.label}
          className="rounded-md border border-border bg-card px-3 py-2"
        >
          <div className="text-[10px] font-mono uppercase tracking-wider text-muted-foreground">
            {el.label}
          </div>
          <div
            className={`mt-1 text-xs whitespace-pre-wrap leading-relaxed ${
              el.value ? "text-foreground/90" : "italic text-muted-foreground"
            }`}
          >
            {el.value || "(empty)"}
          </div>
        </li>
      ))}
    </ul>
  );
}

// The generated client throws a fetch-style error when the response is
// not 2xx; the parsed body is attached as `error.cause` (orval default).
// We pull the structured 409 payload back out so the dialog can self-heal
// when preset / CB version drift under us between open and confirm.
function extractStalePayload(err: unknown): AffirmationPrompt | null {
  if (!err || typeof err !== "object") return null;
  const candidate =
    ("cause" in err ? (err as { cause?: unknown }).cause : null) ??
    ("response" in err
      ? (err as { response?: { data?: unknown } }).response?.data
      : null) ??
    err;
  if (
    candidate &&
    typeof candidate === "object" &&
    (candidate as LaunchNeedsAffirmation).code === "needs_affirmation"
  ) {
    const body = candidate as LaunchNeedsAffirmation;
    return {
      presetId: body.presetId,
      contextBlockVersion: body.contextBlockVersion,
      preset: body.preset,
      contextBlock: body.contextBlock,
    };
  }
  return null;
}
