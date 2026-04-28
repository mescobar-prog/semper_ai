import { useEffect, useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  previewLaunchContext,
  useLaunchTool,
  getListRecentLaunchesQueryKey,
  getGetDashboardSummaryQueryKey,
  getGetMyProfileQueryKey,
  useUpdateMyProfile,
  type LaunchInitiateResponse,
  type LaunchPreviewResponse,
  type RagSnippet,
} from "@workspace/api-client-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";

export interface LaunchTrigger {
  toolId: string;
  toolName: string;
}

interface Props {
  trigger: LaunchTrigger | null;
  onClose: () => void;
  /**
   * Called after a successful mint. The full LaunchInitiateResponse is passed
   * so callers can route cloud vs. local-install flows. The dialog only opens
   * the launchUrl in a new tab for cloud-hosted tools; for local_install the
   * caller is responsible for the install/handoff UI.
   */
  onLaunched: (
    result: LaunchInitiateResponse & { toolName: string },
  ) => void;
  /** When true (or undefined), open the preview UI. When false, mint immediately. */
  showPreview?: boolean;
}

/**
 * Pre-launch context preview & redaction dialog.
 *
 * Flow:
 *  1. When `trigger` is set, fetch the candidate payload (`/launch-preview`).
 *  2. The user toggles individual profile fields and snippets, optionally
 *     adds a freeform note.
 *  3. "Launch now" calls `/launch` with the explicit allowlist; the server
 *     persists the redaction on the launch row and mints a token.
 *  4. The opened tool only sees what the user approved.
 */
export function LaunchPreviewDialog({
  trigger,
  onClose,
  onLaunched,
  showPreview = true,
}: Props) {
  const queryClient = useQueryClient();
  const launchMutation = useLaunchTool();
  const updateProfile = useUpdateMyProfile();

  const [preview, setPreview] = useState<LaunchPreviewResponse | null>(null);
  const [loadingPreview, setLoadingPreview] = useState(false);
  const [refreshingPreview, setRefreshingPreview] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);

  const [excludedFields, setExcludedFields] = useState<Set<string>>(new Set());
  const [excludedSnippets, setExcludedSnippets] = useState<Set<string>>(
    new Set(),
  );
  // Task #106: a single consolidated "Additional detail" box. The
  // operator's mission situation comes from their Context Block; this
  // text is mixed in as a per-launch nudge to RAG and forwarded to
  // the receiving tool. Debounced typing re-runs the preview RAG.
  const [additionalDetail, setAdditionalDetail] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [savingPreference, setSavingPreference] = useState(false);

  // Reset state whenever a new trigger arrives.
  useEffect(() => {
    if (!trigger) return;
    setPreview(null);
    setPreviewError(null);
    setSubmitError(null);
    setExcludedFields(new Set());
    setExcludedSnippets(new Set());
    setAdditionalDetail("");
  }, [trigger?.toolId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Initial fetch of the candidate payload OR direct mint depending on
  // showPreview. We don't include `additionalDetail` in the dep list
  // because the detail-driven re-fetches are handled in a separate
  // debounced effect below — this effect only fires once per
  // (toolId, showPreview).
  useEffect(() => {
    if (!trigger) return;
    let cancelled = false;
    (async () => {
      if (!showPreview) {
        // Direct launch — call /launch with no allowlist (server includes everything).
        try {
          setSubmitting(true);
          setSubmitError(null);
          const resp = await launchMutation.mutateAsync({
            toolId: trigger.toolId,
            data: {},
          });
          if (cancelled) return;
          if (resp.hostingType !== "local_install") {
            window.open(resp.launchUrl, "_blank", "noopener,noreferrer");
          }
          onLaunched({ ...resp, toolName: trigger.toolName });
          queryClient.invalidateQueries({
            queryKey: getListRecentLaunchesQueryKey(),
          });
          queryClient.invalidateQueries({
            queryKey: getGetDashboardSummaryQueryKey(),
          });
          onClose();
        } catch (e) {
          if (cancelled) return;
          setSubmitError(
            e instanceof Error ? e.message : "Launch failed",
          );
        } finally {
          if (!cancelled) setSubmitting(false);
        }
        return;
      }
      try {
        setLoadingPreview(true);
        const data = await previewLaunchContext(trigger.toolId, {
          additionalDetail: null,
        });
        if (cancelled) return;
        setPreview(data);
      } catch (e) {
        if (cancelled) return;
        setPreviewError(
          e instanceof Error ? e.message : "Could not load preview",
        );
      } finally {
        if (!cancelled) setLoadingPreview(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [trigger?.toolId, showPreview]); // eslint-disable-line react-hooks/exhaustive-deps

  // Debounced additionalDetail → re-fetch preview. We wait ~500ms
  // after the operator stops typing so we don't spam the LLM-backed
  // query generator on every keystroke. Skips while the initial
  // fetch is still running and only fires when the trimmed text
  // actually differs from what the last preview ran with.
  useEffect(() => {
    if (!trigger || !showPreview) return;
    if (loadingPreview) return;
    const trimmed = additionalDetail.trim();
    const lastDetail = preview?.additionalDetail ?? "";
    if (trimmed === lastDetail) return;
    let cancelled = false;
    const timer = window.setTimeout(async () => {
      try {
        setRefreshingPreview(true);
        const data = await previewLaunchContext(trigger.toolId, {
          additionalDetail: trimmed.length > 0 ? trimmed : null,
        });
        if (cancelled) return;
        setPreview(data);
        // Reset snippet exclusions — the candidate set just changed so
        // the operator's previous ticks don't apply to the new chunks.
        setExcludedSnippets(new Set());
      } catch (e) {
        if (cancelled) return;
        setPreviewError(
          e instanceof Error ? e.message : "Could not refresh preview",
        );
      } finally {
        if (!cancelled) setRefreshingPreview(false);
      }
    }, 500);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [additionalDetail, trigger?.toolId, showPreview, loadingPreview, preview?.additionalDetail]); // eslint-disable-line react-hooks/exhaustive-deps

  const fieldsWithValues = useMemo(
    () => preview?.profileFields.filter((f) => f.hasValue) ?? [],
    [preview],
  );
  const includedFieldCount = useMemo(
    () => fieldsWithValues.filter((f) => !excludedFields.has(f.key)).length,
    [fieldsWithValues, excludedFields],
  );
  const includedSnippetCount = useMemo(
    () =>
      (preview?.candidateSnippets ?? []).filter(
        (s) => !excludedSnippets.has(s.chunkId),
      ).length,
    [preview, excludedSnippets],
  );

  const toggleField = (key: string) => {
    setExcludedFields((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };
  const toggleSnippet = (id: string) => {
    setExcludedSnippets((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const handleLaunch = async () => {
    if (!trigger || !preview) return;
    setSubmitting(true);
    setSubmitError(null);
    try {
      const selectedFieldKeys = fieldsWithValues
        .filter((f) => !excludedFields.has(f.key))
        .map((f) => f.key);
      const selectedSnippetIds = preview.candidateSnippets
        .filter((s) => !excludedSnippets.has(s.chunkId))
        .map((s) => s.chunkId);
      // Task #106: forward the operator's "Additional detail" text so
      // the launch row persists it and the receiving tool sees it via
      // context-exchange.
      const trimmedDetail = additionalDetail.trim();
      const resp = await launchMutation.mutateAsync({
        toolId: trigger.toolId,
        data: {
          selectedFieldKeys,
          selectedSnippetIds,
          additionalDetail: trimmedDetail.length > 0 ? trimmedDetail : null,
        },
      });
      if (resp.hostingType !== "local_install") {
        window.open(resp.launchUrl, "_blank", "noopener,noreferrer");
      }
      onLaunched({ ...resp, toolName: trigger.toolName });
      queryClient.invalidateQueries({
        queryKey: getListRecentLaunchesQueryKey(),
      });
      queryClient.invalidateQueries({
        queryKey: getGetDashboardSummaryQueryKey(),
      });
      onClose();
    } catch (e) {
      setSubmitError(e instanceof Error ? e.message : "Launch failed");
    } finally {
      setSubmitting(false);
    }
  };

  // "Always launch directly from now on" preference toggle.
  const setLaunchPref = async (pref: "preview" | "direct") => {
    setSavingPreference(true);
    try {
      await updateProfile.mutateAsync({ data: { launchPreference: pref } });
      queryClient.invalidateQueries({ queryKey: getGetMyProfileQueryKey() });
    } finally {
      setSavingPreference(false);
    }
  };

  const open = !!trigger;
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-3xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>
            Review what {trigger?.toolName ?? "this tool"} will receive
          </DialogTitle>
          <DialogDescription>
            Toggle off anything you don't want this tool to see. Only what's
            checked is sent.
          </DialogDescription>
        </DialogHeader>

        {!showPreview && (
          <div className="text-sm text-muted-foreground py-6">
            {submitError ? (
              <div className="rounded border border-rose-500/40 bg-rose-500/5 p-3 text-rose-300">
                {submitError}
              </div>
            ) : (
              <>Launching {trigger?.toolName}…</>
            )}
          </div>
        )}

        {showPreview && loadingPreview && (
          <div className="text-sm text-muted-foreground py-6">
            Computing what we'd send…
          </div>
        )}

        {showPreview && previewError && (
          <div className="rounded border border-rose-500/40 bg-rose-500/5 p-3 text-sm text-rose-300">
            {previewError}
          </div>
        )}

        {showPreview && preview && (
          <div className="space-y-6">
            <section>
              <SectionLabel
                title="Operator profile"
                hint={`${includedFieldCount} of ${fieldsWithValues.length} fields`}
              />
              {fieldsWithValues.length === 0 ? (
                <p className="text-xs text-muted-foreground mt-2">
                  No profile fields filled in yet — nothing to share.
                </p>
              ) : (
                <ul className="mt-2 divide-y divide-border border border-border rounded-md">
                  {fieldsWithValues.map((f) => {
                    const excluded = excludedFields.has(f.key);
                    return (
                      <li
                        key={f.key}
                        className="flex items-start gap-3 px-4 py-3"
                      >
                        <input
                          id={`field-${f.key}`}
                          type="checkbox"
                          checked={!excluded}
                          onChange={() => toggleField(f.key)}
                          className="mt-1 h-4 w-4 rounded border-border bg-background text-primary focus:ring-primary"
                        />
                        <label
                          htmlFor={`field-${f.key}`}
                          className="flex-1 cursor-pointer"
                        >
                          <div className="text-[10px] font-mono uppercase tracking-wider text-muted-foreground">
                            {f.label}
                          </div>
                          <div
                            className={`text-sm mt-0.5 break-words ${
                              excluded
                                ? "line-through text-muted-foreground"
                                : "text-foreground"
                            }`}
                          >
                            {f.value}
                          </div>
                        </label>
                      </li>
                    );
                  })}
                </ul>
              )}
            </section>

            <section>
              <SectionLabel
                title="Library snippets"
                hint={`${includedSnippetCount} of ${preview.candidateSnippets.length} selected`}
              />
              <div className="mt-1 text-[11px] text-muted-foreground">
                {preview.scopedToSelectedDoctrine ? (
                  <>
                    Scoped to your selected doctrine (
                    {preview.selectedDoctrineDocIds.length}{" "}
                    {preview.selectedDoctrineDocIds.length === 1
                      ? "doc"
                      : "docs"}
                    ).
                  </>
                ) : preview.selectedDoctrineDocIds.length > 0 ? (
                  <>
                    Your selected doctrine isn't in this preset's library —
                    falling back to the full preset scope.
                  </>
                ) : (
                  <>
                    No doctrine ticked — searching the full preset library.
                    Tick docs in your Context Block to narrow the search.
                  </>
                )}
              </div>
              {preview.candidateSnippets.length === 0 ? (
                <p className="text-xs text-muted-foreground mt-2">
                  Your library produced no relevant snippets for this tool.
                </p>
              ) : (
                <ul className="mt-2 space-y-2">
                  {preview.candidateSnippets.map((s) => (
                    <SnippetRow
                      key={s.chunkId}
                      snippet={s}
                      excluded={excludedSnippets.has(s.chunkId)}
                      onToggle={() => toggleSnippet(s.chunkId)}
                    />
                  ))}
                </ul>
              )}
              {preview.queries.length > 0 && (
                <details className="mt-2 text-xs text-muted-foreground">
                  <summary className="cursor-pointer hover:text-foreground">
                    {preview.queries.length} search queries used
                  </summary>
                  <ul className="mt-2 ml-4 list-disc space-y-1">
                    {preview.queries.map((q, i) => (
                      <li key={i} className="font-mono">
                        {q}
                      </li>
                    ))}
                  </ul>
                </details>
              )}
            </section>

            <section>
              <SectionLabel title="Additional detail (optional)" />
              <textarea
                value={additionalDetail}
                onChange={(e) => setAdditionalDetail(e.target.value)}
                rows={3}
                placeholder="Anything specific to this launch you want the tool to know — refines the snippets we pull and is forwarded along…"
                className="mt-2 w-full rounded-md border border-border bg-background px-3 py-2 text-sm placeholder:text-muted-foreground focus:border-primary focus:outline-none"
              />
              <p className="mt-1 text-[11px] text-muted-foreground">
                {refreshingPreview
                  ? "Refreshing snippets for your detail…"
                  : additionalDetail.trim()
                    ? "We'll mix this with your Context Block to refine the search."
                    : "Optional. We'll search using your profile and the last five Context Block elements (Doctrine & Orders excluded)."}
              </p>
            </section>

            {submitError && (
              <div className="rounded border border-rose-500/40 bg-rose-500/5 p-3 text-sm text-rose-300">
                {submitError}
              </div>
            )}

            <div className="flex items-center justify-between gap-3 pt-2 border-t border-border">
              <label className="flex items-center gap-2 text-xs text-muted-foreground cursor-pointer">
                <input
                  type="checkbox"
                  checked={preview.launchPreference === "direct"}
                  disabled={savingPreference}
                  onChange={(e) =>
                    setLaunchPref(e.target.checked ? "direct" : "preview")
                  }
                  className="h-3.5 w-3.5 rounded border-border bg-background text-primary"
                />
                Skip this preview next time
              </label>
              <div className="flex gap-2">
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
                  onClick={handleLaunch}
                  disabled={submitting}
                  className="h-9 px-4 rounded-md bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 disabled:opacity-50"
                >
                  {submitting ? "Launching…" : "Launch now"}
                </button>
              </div>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

function SectionLabel({ title, hint }: { title: string; hint?: string }) {
  return (
    <div className="flex items-end justify-between">
      <div className="text-[10px] font-mono uppercase tracking-wider text-muted-foreground font-semibold">
        {title}
      </div>
      {hint && (
        <div className="text-[10px] font-mono text-muted-foreground tabular-nums">
          {hint}
        </div>
      )}
    </div>
  );
}

function SnippetRow({
  snippet,
  excluded,
  onToggle,
}: {
  snippet: RagSnippet;
  excluded: boolean;
  onToggle: () => void;
}) {
  return (
    <li
      className={`border rounded-md p-3 transition-colors ${
        excluded ? "border-border bg-muted/20" : "border-border bg-card"
      }`}
    >
      <label className="flex items-start gap-3 cursor-pointer">
        <input
          type="checkbox"
          checked={!excluded}
          onChange={onToggle}
          className="mt-1 h-4 w-4 rounded border-border bg-background text-primary focus:ring-primary"
        />
        <div className="flex-1 min-w-0">
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-2 min-w-0">
              <div className="text-xs font-medium text-foreground truncate">
                {snippet.documentTitle}
              </div>
              {/* Task #88: badge showing whether this snippet came from
                  the operator's selected doctrine (intent-led, scoped)
                  or fell back to the wider preset library. */}
              {snippet.fromSelectedDoctrine ? (
                <span className="shrink-0 rounded-sm border border-emerald-500/40 bg-emerald-500/10 px-1.5 py-0.5 text-[9px] font-mono uppercase tracking-wider text-emerald-300">
                  selected doctrine
                </span>
              ) : (
                <span className="shrink-0 rounded-sm border border-border bg-muted/30 px-1.5 py-0.5 text-[9px] font-mono uppercase tracking-wider text-muted-foreground">
                  fallback
                </span>
              )}
            </div>
            <div className="text-[10px] font-mono text-muted-foreground tabular-nums shrink-0">
              chunk #{snippet.chunkIndex}
            </div>
          </div>
          <div
            className={`mt-1 text-xs whitespace-pre-wrap leading-relaxed line-clamp-4 ${
              excluded ? "text-muted-foreground" : "text-foreground/80"
            }`}
          >
            {snippet.content}
          </div>
        </div>
      </label>
    </li>
  );
}
