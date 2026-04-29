import { useEffect, useMemo, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  previewLaunchContext,
  useLaunchTool,
  useCreateLaunchAffirmation,
  getListRecentLaunchesQueryKey,
  getGetDashboardSummaryQueryKey,
  getGetMyProfileQueryKey,
  getGetLaunchAffirmationQueryKey,
  useUpdateMyProfile,
  type ContextBlockState,
  type LaunchInitiateResponse,
  type LaunchNeedsAffirmation,
  type LaunchPreviewResponse,
  type MissionPreset,
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
  /**
   * When true (or undefined), open the preview UI. When false, mint immediately.
   * The parent should only set this to false when the operator's saved preference
   * is "direct" AND a valid affirmation already exists — otherwise the server
   * will refuse the mint with a 409.
   */
  showPreview?: boolean;
  /**
   * Snapshot of the active mission preset. Rendered read-only at the top of
   * the consolidated dialog and (together with `contextBlockSnapshot.version`)
   * used as the affirmation key.
   */
  presetSnapshot: MissionPreset | null;
  /**
   * Snapshot of the user's six-element Context Block. Rendered read-only at
   * the top of the consolidated dialog. The `version` field also keys the
   * affirmation request.
   */
  contextBlockSnapshot: ContextBlockState | null;
  /**
   * Whether the operator has a server-recorded, unexpired affirmation that
   * matches the active preset and current Context Block version. When false
   * the dialog will record one before minting the launch.
   */
  hasValidAffirmation: boolean;
  /**
   * "launch" (default) — primary button affirms (if needed) then mints the
   *  launch and opens the tool.
   * "reaffirm" — primary button records a fresh affirmation and closes
   *  without minting a launch. The same review content is shown.
   */
  mode?: "launch" | "reaffirm";
}

/**
 * Consolidated pre-launch review & affirmation dialog (Task #125).
 *
 * Shows, in one scrollable view:
 *   - the active mission preset summary + the six-element Context Block
 *     (read-only — same content the old affirmation modal showed),
 *   - the operator profile fields with per-row redaction,
 *   - the RAG library snippets with per-row redaction,
 *   - the "Additional detail" textarea (debounced snippet refresh).
 *
 * A single acknowledgement checkbox covers both the "context is current"
 * and "items checked are what I want sent" intents. Clicking the primary
 * button records the affirmation (if one isn't already valid) and then
 * mints the launch in sequence. Stale-snapshot 409s from either endpoint
 * swap the snapshot in-place and reset the acknowledgement.
 */
export function LaunchPreviewDialog({
  trigger,
  onClose,
  onLaunched,
  showPreview = true,
  presetSnapshot,
  contextBlockSnapshot,
  hasValidAffirmation,
  mode = "launch",
}: Props) {
  const queryClient = useQueryClient();
  const launchMutation = useLaunchTool();
  const affirmMutation = useCreateLaunchAffirmation();
  const updateProfile = useUpdateMyProfile();

  // Stash the unstable identities from useMutation / parent props in
  // refs so the launch effect's dep array can be narrowed to truly
  // launch-defining inputs. Without this, the effect re-fires every
  // time the mutation transitions through pending → success states,
  // which can re-mint a launch token for the same trigger.
  const launchMutationRef = useRef(launchMutation);
  launchMutationRef.current = launchMutation;
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const onLaunchedRef = useRef(onLaunched);
  onLaunchedRef.current = onLaunched;

  // Refs hold the snapshot/affirmation props so we can capture them at
  // the moment a trigger fires without forcing the reset effect to
  // re-run every time the parent rerenders.
  const presetSnapshotRef = useRef(presetSnapshot);
  presetSnapshotRef.current = presetSnapshot;
  const contextBlockSnapshotRef = useRef(contextBlockSnapshot);
  contextBlockSnapshotRef.current = contextBlockSnapshot;
  const hasValidAffirmationRef = useRef(hasValidAffirmation);
  hasValidAffirmationRef.current = hasValidAffirmation;
  // The parent recomputes `showPreview` from launchPreference + affirmation
  // status, both of which can change while the dialog is open (e.g. when
  // the operator toggles "Skip this preview next time" inside this dialog
  // and the profile re-fetches). We capture the prop's value at the moment
  // a trigger arrives and latch it for the rest of that dialog session;
  // otherwise the body would flip from review→"Launching…" mid-interaction
  // and orphan the user with no controls.
  const showPreviewRef = useRef(showPreview);
  showPreviewRef.current = showPreview;

  // Guards against re-entry of the trigger effect for the same trigger
  // identity. Even with narrowed deps, React's StrictMode (and HMR)
  // can re-run the effect; we want to mint a token at most once per
  // trigger object the parent hands us.
  const handledTriggerRef = useRef<LaunchTrigger | null>(null);

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
  const [preferenceError, setPreferenceError] = useState<string | null>(null);
  // Locally track the operator's launch-preference choice so the toggle
  // reflects the click immediately even before the profile re-fetch
  // resolves. Initialized from the preview response when it arrives.
  const [launchPrefOverride, setLaunchPrefOverride] =
    useState<"preview" | "direct" | null>(null);
  // Latched copy of the `showPreview` prop captured at trigger time so
  // mid-session preference flips don't tear down the in-progress UI.
  // `null` means "no trigger yet" — render falls back to the live prop
  // (which will be ignored anyway because `open` is false).
  const [latchedShowPreview, setLatchedShowPreview] = useState<boolean | null>(
    null,
  );

  // Local mirror of the preset + CB snapshot. We can't keep using the
  // props directly because a 409 from either /launches/affirmation or
  // /tools/:id/launch will hand us a fresher snapshot we need to swap
  // in-place without closing.
  const [snapshotPreset, setSnapshotPreset] = useState<MissionPreset | null>(
    presetSnapshot,
  );
  const [snapshotContextBlock, setSnapshotContextBlock] =
    useState<ContextBlockState | null>(contextBlockSnapshot);
  // Mirror of the affirmation status. Starts at the prop's value but
  // flips to true after a successful affirm POST and to false after a
  // 409-driven snapshot swap. Once true within a session, the dialog
  // won't redundantly affirm again before minting.
  const [affirmationValid, setAffirmationValid] =
    useState(hasValidAffirmation);
  // Acknowledgement checkbox state (the only gate on the primary button
  // when the preview UI is shown).
  const [acknowledged, setAcknowledged] = useState(false);
  // Surfaced inline when a 409 caused us to swap the snapshot in place.
  const [staleNotice, setStaleNotice] = useState<string | null>(null);

  // Reset state whenever a new trigger arrives. We depend on the
  // `trigger` object identity (not just `toolId`) so that two
  // back-to-back launches of the *same* tool — which produce two
  // distinct trigger objects with the same toolId — both reset the
  // dialog. The previous `[trigger?.toolId]` dep skipped the second
  // launch and reused stale exclusion state.
  useEffect(() => {
    if (!trigger) {
      // Once the dialog is closed, allow the same trigger object to
      // run through again on a future reopen. (In practice the parent
      // mints a fresh object, but resetting here keeps the guard from
      // becoming a footgun.)
      handledTriggerRef.current = null;
      setLatchedShowPreview(null);
      return;
    }
    setPreview(null);
    setPreviewError(null);
    setSubmitError(null);
    setExcludedFields(new Set());
    setExcludedSnippets(new Set());
    setAdditionalDetail("");
    setAcknowledged(false);
    setStaleNotice(null);
    setSnapshotPreset(presetSnapshotRef.current);
    setSnapshotContextBlock(contextBlockSnapshotRef.current);
    setAffirmationValid(hasValidAffirmationRef.current);
    setLaunchPrefOverride(null);
    setLatchedShowPreview(showPreviewRef.current);
  }, [trigger]);

  // Initial fetch of the candidate payload OR direct mint depending on
  // showPreview. Deps are narrowed to (trigger, showPreview, queryClient)
  // — all unstable callbacks (launchMutation, onClose, onLaunched) are
  // read from refs above so churn in the mutation's pending/success
  // state can't re-fire the launch side effect for the same trigger.
  // The handledTriggerRef guard provides belt-and-braces protection
  // against StrictMode / HMR double invocations.
  useEffect(() => {
    if (!trigger) return;
    if (handledTriggerRef.current === trigger) return;
    handledTriggerRef.current = trigger;
    // Capture showPreview at trigger time so a mid-session preference
    // toggle inside this dialog can't re-route an already-rendered
    // review screen into a direct mint mid-flight.
    const initialShowPreview = showPreviewRef.current;
    let cancelled = false;
    (async () => {
      if (!initialShowPreview) {
        // Direct launch — call /launch with no allowlist (server includes everything).
        // The parent only sets showPreview=false when a valid affirmation
        // already exists, so the server's gate should pass silently.
        try {
          setSubmitting(true);
          setSubmitError(null);
          const resp = await launchMutationRef.current.mutateAsync({
            toolId: trigger.toolId,
            data: {},
          });
          if (cancelled) return;
          if (resp.hostingType !== "local_install") {
            window.open(resp.launchUrl, "_blank", "noopener,noreferrer");
          }
          onLaunchedRef.current({ ...resp, toolName: trigger.toolName });
          queryClient.invalidateQueries({
            queryKey: getListRecentLaunchesQueryKey(),
          });
          queryClient.invalidateQueries({
            queryKey: getGetDashboardSummaryQueryKey(),
          });
          onCloseRef.current();
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
    // showPreview intentionally not in deps — see initialShowPreview above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [trigger, queryClient]);

  // Debounced additionalDetail → re-fetch preview. We wait ~500ms
  // after the operator stops typing so we don't spam the LLM-backed
  // query generator on every keystroke. Skips while the initial
  // fetch is still running and only fires when the trimmed text
  // actually differs from what the last preview ran with.
  useEffect(() => {
    if (!trigger || !latchedShowPreview) return;
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
  }, [additionalDetail, trigger?.toolId, latchedShowPreview, loadingPreview, preview?.additionalDetail]); // eslint-disable-line react-hooks/exhaustive-deps

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

  const handlePrimary = async () => {
    if (!trigger || !preview) return;
    if (!snapshotPreset || !snapshotContextBlock) {
      setSubmitError(
        "Cannot continue without an active preset and Context Block.",
      );
      return;
    }
    setSubmitting(true);
    setSubmitError(null);
    setStaleNotice(null);
    try {
      // Step (a): record an affirmation if one isn't already valid.
      // Reaffirm mode always records a fresh one (extending the TTL).
      if (!affirmationValid || mode === "reaffirm") {
        try {
          await affirmMutation.mutateAsync({
            data: {
              presetId: snapshotPreset.id,
              contextBlockVersion: snapshotContextBlock.version,
            },
          });
          // Refresh the cached affirmation status so the catalog page's
          // indicator flips immediately to "preset confirmed for this
          // session".
          queryClient.invalidateQueries({
            queryKey: getGetLaunchAffirmationQueryKey(),
          });
          setAffirmationValid(true);
        } catch (err) {
          const stale = extractStalePayload(err);
          if (stale) {
            setSnapshotPreset(stale.preset);
            setSnapshotContextBlock(stale.contextBlock);
            setAffirmationValid(false);
            setAcknowledged(false);
            setStaleNotice(
              "Your context block changed since you opened this dialog. Please review the updated content and re-confirm.",
            );
            return;
          }
          throw err;
        }
      }

      if (mode === "reaffirm") {
        // Re-affirm-only mode: we just recorded the fresh affirmation,
        // close without minting a launch.
        onClose();
        return;
      }

      // Step (b): mint the launch with the operator's redaction allowlist.
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
      try {
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
      } catch (err) {
        const stale = extractStalePayload(err);
        if (stale) {
          // Rare race: the CB drifted between our affirm and our launch.
          // Swap the snapshot in place and ask the operator to re-affirm.
          setSnapshotPreset(stale.preset);
          setSnapshotContextBlock(stale.contextBlock);
          setAffirmationValid(false);
          setAcknowledged(false);
          setStaleNotice(
            "Your context block changed since you opened this dialog. Please review the updated content and re-confirm.",
          );
          return;
        }
        throw err;
      }
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : "Launch failed");
    } finally {
      setSubmitting(false);
    }
  };

  // "Always launch directly from now on" preference toggle. We update
  // the local override immediately so the checkbox reflects the click
  // before the network round-trip resolves; if the save fails we roll
  // back to whatever the preview/profile said.
  const setLaunchPref = async (pref: "preview" | "direct") => {
    const prior = launchPrefOverride;
    setLaunchPrefOverride(pref);
    setSavingPreference(true);
    setPreferenceError(null);
    try {
      await updateProfile.mutateAsync({ data: { launchPreference: pref } });
      queryClient.invalidateQueries({ queryKey: getGetMyProfileQueryKey() });
    } catch (err) {
      setLaunchPrefOverride(prior);
      setPreferenceError(
        err instanceof Error
          ? err.message
          : "Could not save your launch preference. Please try again.",
      );
    } finally {
      setSavingPreference(false);
    }
  };

  const open = !!trigger;
  const isReaffirm = mode === "reaffirm";
  const primaryLabel = isReaffirm
    ? submitting
      ? "Confirming…"
      : "Confirm context"
    : submitting
      ? "Launching…"
      : "Launch now";
  const dialogTitle = isReaffirm
    ? `Re-confirm what ${trigger?.toolName ?? "this tool"} would receive`
    : `Review what ${trigger?.toolName ?? "this tool"} will receive`;
  const dialogDescription = isReaffirm
    ? "Refresh your launch-time affirmation against the active preset and Context Block. Nothing is sent to the tool."
    : "Confirm your active preset and Context Block, then toggle off anything you don't want this tool to see.";

  // Use the latched copy of showPreview so the body doesn't tear down
  // mid-session if the parent's launchPreference / affirmation flips.
  // Falls back to the live prop only before the first trigger has been
  // captured (when `open` is false anyway).
  const effectiveShowPreview = latchedShowPreview ?? showPreview;

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-3xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{dialogTitle}</DialogTitle>
          <DialogDescription>{dialogDescription}</DialogDescription>
        </DialogHeader>

        {!effectiveShowPreview && (
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

        {effectiveShowPreview && loadingPreview && (
          <div className="text-sm text-muted-foreground py-6">
            Computing what we'd send…
          </div>
        )}

        {effectiveShowPreview && previewError && (
          <div className="rounded border border-rose-500/40 bg-rose-500/5 p-3 text-sm text-rose-300">
            {previewError}
          </div>
        )}

        {effectiveShowPreview && preview && (
          <div className="space-y-6">
            {snapshotPreset && snapshotContextBlock && (
              <ContextSnapshotSection
                preset={snapshotPreset}
                contextBlock={snapshotContextBlock}
              />
            )}

            {staleNotice && (
              <div
                role="alert"
                className="rounded-md border border-amber-500/50 bg-amber-500/10 p-3 text-xs text-amber-200"
              >
                {staleNotice}
              </div>
            )}

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

            <label className="flex items-start gap-3 rounded-md border border-border bg-card px-4 py-3 cursor-pointer">
              <input
                type="checkbox"
                data-testid="launch-acknowledge-checkbox"
                checked={acknowledged}
                onChange={(e) => setAcknowledged(e.target.checked)}
                className="mt-0.5 h-4 w-4 rounded border-border bg-background text-primary focus:ring-primary"
              />
              <span className="text-sm text-foreground">
                I confirm this preset and Context Block are current and that
                the items checked above are what I want this tool to receive.
              </span>
            </label>

            <div className="flex items-center justify-between gap-3 pt-2 border-t border-border">
              {isReaffirm ? (
                <span className="text-xs text-muted-foreground">
                  Recording a fresh affirmation only — no launch will fire.
                </span>
              ) : (
                <div className="flex flex-col gap-1">
                  <label className="flex items-center gap-2 text-xs text-muted-foreground cursor-pointer">
                    <input
                      type="checkbox"
                      data-testid="launch-skip-preview-toggle"
                      checked={
                        (launchPrefOverride ?? preview.launchPreference) ===
                        "direct"
                      }
                      disabled={savingPreference}
                      onChange={(e) =>
                        void setLaunchPref(
                          e.target.checked ? "direct" : "preview",
                        )
                      }
                      className="h-3.5 w-3.5 rounded border-border bg-background text-primary"
                    />
                    Skip this preview next time
                  </label>
                  {preferenceError && (
                    <span
                      data-testid="launch-preference-error"
                      className="text-[11px] text-rose-300"
                    >
                      {preferenceError}
                    </span>
                  )}
                </div>
              )}
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
                  data-testid={
                    isReaffirm
                      ? "launch-confirm-context-button"
                      : "launch-now-button"
                  }
                  onClick={handlePrimary}
                  disabled={submitting || !acknowledged}
                  className="h-9 px-4 rounded-md bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 disabled:opacity-50"
                >
                  {primaryLabel}
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

/**
 * Read-only mirror of what the legacy LaunchAffirmationDialog showed:
 * the active mission preset card, optional lower-assurance bypass
 * warning, and the six-element Context Block grid.
 */
function ContextSnapshotSection({
  preset,
  contextBlock,
}: {
  preset: MissionPreset;
  contextBlock: ContextBlockState;
}) {
  return (
    <div className="space-y-4">
      <section>
        <SectionLabel title="Active mission preset" />
        <div className="mt-2 rounded-md border border-border bg-card px-4 py-3">
          <div className="text-sm font-medium text-foreground">
            {preset.name}
          </div>
          {preset.description && (
            <div className="text-xs text-muted-foreground mt-1">
              {preset.description}
            </div>
          )}
          <div className="text-[10px] font-mono uppercase tracking-wider text-muted-foreground mt-2">
            Context block v{contextBlock.version}
          </div>
        </div>
      </section>

      {contextBlock.bypassed && (
        <div
          role="alert"
          className="rounded-md border border-amber-500/50 bg-amber-500/10 p-3 text-xs text-amber-200"
        >
          <div className="font-semibold uppercase tracking-wider text-[10px] text-amber-300 mb-1">
            Lower-assurance context
          </div>
          This Context Block was confirmed under the 10/12 review threshold.
          Tools you launch will see a flag indicating the block was
          operator-bypassed; proceed only if that level of assurance is
          acceptable for the work ahead.
        </div>
      )}

      <section>
        <SectionLabel title="Six-element context block" />
        <ContextBlockGrid cb={contextBlock} />
      </section>
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
function extractStalePayload(err: unknown): {
  preset: MissionPreset;
  contextBlock: ContextBlockState;
} | null {
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
      preset: body.preset,
      contextBlock: body.contextBlock,
    };
  }
  return null;
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
