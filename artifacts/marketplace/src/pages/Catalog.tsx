import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import {
  useGetMyProfile,
  useEvaluateContextBlock,
  useConfirmContextBlock,
  useListDocuments,
  useUploadTextDocument,
  requestUploadUrl,
  getGetMyProfileQueryKey,
  getGetLaunchAffirmationQueryKey,
  getListDocumentsQueryKey,
  getGetLibraryStatsQueryKey,
} from "@workspace/api-client-react";
import type {
  ContextBlockEvaluation,
  ContextBlockFields,
  ContextBlockState,
  DocumentSummary,
} from "@workspace/api-client-react";
import { parseAutoSource } from "@workspace/mil-data";
import { PageContainer, ErrorBox, Pill, formatBytes } from "@/lib/format";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  ExportMenu,
  ImportControl,
  ImportMessageBanner,
  contextBlockToMarkdown,
  parseContextBlockImport,
  type ImportMessage,
} from "@/lib/profileIo";

// ---------- Doctrine picker — text-region helpers --------------------------
//
// The Doctrine & Orders textarea is split into two regions:
//   1. an auto-managed reference region at the top, one short reference
//      line per ticked library doc, followed by
//   2. a `--- Orders ---` divider, followed by
//   3. the operator's free-form orders.
//
// Each reference line is just `- <doc title>` — no IDs, no markers, just
// the human-readable title. Checkbox state is derived by scanning those
// lines and matching their title against the operator's library, which
// keeps the checkboxes and the textarea in sync — a manual edit that
// deletes a reference line also un-ticks its checkbox automatically.

const ORDERS_DIVIDER = "--- Orders ---";
const DOCTRINE_SNIPPET_MAX_BYTES = 25 * 1024 * 1024;
const DOCTRINE_ACCEPTED_EXT = ".pdf,.docx,.md,.markdown,.txt";

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function findDividerIndex(content: string): number {
  return content.indexOf(ORDERS_DIVIDER);
}

function getSnippetRegion(content: string): string {
  const idx = findDividerIndex(content);
  return idx === -1 ? "" : content.slice(0, idx);
}

function getOrdersRegion(content: string): string {
  const idx = findDividerIndex(content);
  if (idx === -1) return content;
  return content.slice(idx + ORDERS_DIVIDER.length).replace(/^\n/, "");
}

function joinRegions(snippetRegion: string, ordersRegion: string): string {
  // Trim whitespace from both ends of the reference region so the divider
  // sits tight against the last reference line and we never end up with a
  // stray blank line above the first reference. Only insert the divider
  // when there are reference lines — a brand-new operator with zero ticks
  // should see a plain textarea, no stray divider.
  const trimmed = snippetRegion.trim();
  if (!trimmed) return ordersRegion;
  return `${trimmed}\n\n${ORDERS_DIVIDER}\n${ordersRegion}`;
}

// A managed reference line is just `- <doc title>` — clean, ID-free text.
// We extract whatever sits after the leading `- ` on each line of the
// reference region and treat it as a title; the picker then looks each
// title up in the operator's library to derive the matching doc id and
// drive checkbox state.
const REFERENCE_LINE_RE = /^-\s+(.+?)\s*$/gm;

function parseReferenceTitles(content: string): string[] {
  const region = getSnippetRegion(content);
  const titles: string[] = [];
  REFERENCE_LINE_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = REFERENCE_LINE_RE.exec(region))) {
    titles.push(m[1]);
  }
  return titles;
}

function parseCheckedIds(
  content: string,
  docs: readonly DocumentSummary[],
): Set<string> {
  const titles = new Set(parseReferenceTitles(content));
  const ids = new Set<string>();
  for (const doc of docs) {
    if (titles.has(doc.title)) ids.add(doc.id);
  }
  return ids;
}

function buildBlock(doc: DocumentSummary): string {
  return `- ${doc.title}`;
}

function addBlock(content: string, doc: DocumentSummary): string {
  // Skip if a managed line for this exact title already exists.
  if (parseReferenceTitles(content).includes(doc.title)) return content;
  // Strip trailing whitespace from the existing reference region so two
  // ticks in a row produce adjacent lines instead of a blank line between.
  const snippetRegion = getSnippetRegion(content).replace(/\s+$/, "");
  const ordersRegion = getOrdersRegion(content);
  const sep = snippetRegion ? "\n" : "";
  const nextSnippets = `${snippetRegion}${sep}${buildBlock(doc)}\n`;
  return joinRegions(nextSnippets, ordersRegion);
}

function removeBlock(content: string, doc: DocumentSummary): string {
  const snippetRegion = getSnippetRegion(content);
  const ordersRegion = getOrdersRegion(content);
  // Remove only a line whose text matches `- <this exact title>`, so a
  // similarly-named doc in the operator's library can never accidentally
  // get its line stripped when an unrelated doc is unticked.
  const re = new RegExp(
    `^-\\s+${escapeRegExp(doc.title)}\\s*(?:\\r?\\n|$)`,
    "gm",
  );
  const next = snippetRegion.replace(re, "");
  return joinRegions(next, ordersRegion);
}

function sourceLabel(doc: DocumentSummary): string {
  if (!doc.autoSource) return "manual upload";
  const parsed = parseAutoSource(doc.autoSource);
  if (!parsed) return `auto: ${doc.autoSource}`;
  return `auto: ${parsed.branchCode}:${parsed.identifier}`;
}

function inferDoctrineMimeType(filename: string, declared: string): string {
  if (declared && declared !== "application/octet-stream") return declared;
  const ext = filename.toLowerCase().split(".").pop() ?? "";
  if (ext === "pdf") return "application/pdf";
  if (ext === "docx")
    return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
  if (ext === "md" || ext === "markdown") return "text/markdown";
  return "text/plain";
}

const ELEMENTS: Array<{
  key: keyof ContextBlockFields;
  label: string;
  hint: string;
}> = [
  {
    key: "doctrine",
    label: "1. Doctrine & Orders",
    hint: "Cite the specific open-source doctrine (e.g. MCDP-4) or unit SOPs that govern this task.",
  },
  {
    key: "intent",
    label: "2. Commander's Intent",
    hint: "What is the commander trying to achieve? End-state, key tasks, acceptable risk.",
  },
  {
    key: "environment",
    label: "3. Environment",
    hint: "Operational environment: terrain, units, timeline, dependencies, current posture.",
  },
  {
    key: "constraints",
    label: "4. Constraints & Limitations",
    hint: "Logistical, legal, or technical constraints the LLM must respect.",
  },
  {
    key: "risk",
    label: "5. Risk",
    hint: "Who acts on this output, and what is the consequence if the LLM hallucinates?",
  },
  {
    key: "experience",
    label: "6. Experience & Judgment",
    hint: "Specific human experiential knowledge or unit history the AI cannot infer.",
  },
];

const EMPTY_FIELDS: ContextBlockFields = {
  doctrine: "",
  intent: "",
  environment: "",
  constraints: "",
  risk: "",
  experience: "",
};

function fieldsFromState(cb: ContextBlockState | undefined): ContextBlockFields {
  if (!cb) return EMPTY_FIELDS;
  return {
    doctrine: cb.doctrine ?? "",
    intent: cb.intent ?? "",
    environment: cb.environment ?? "",
    constraints: cb.constraints ?? "",
    risk: cb.risk ?? "",
    experience: cb.experience ?? "",
  };
}

export function Catalog() {
  const queryClient = useQueryClient();
  const { data: profileEnvelope, isLoading } = useGetMyProfile();
  const profile = profileEnvelope?.profile;
  const cb = profileEnvelope?.contextBlock;

  const [fields, setFields] = useState<ContextBlockFields>(EMPTY_FIELDS);
  const [hydratedFor, setHydratedFor] = useState<string | null>(null);
  const [evaluation, setEvaluation] = useState<ContextBlockEvaluation | null>(
    null,
  );
  // Snapshot of the fields that produced the current `evaluation`, used to
  // decide whether the displayed score is stale relative to current edits.
  const [evaluatedSnapshot, setEvaluatedSnapshot] =
    useState<ContextBlockFields | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Hydrate the form from server state once per profile load.
  useEffect(() => {
    if (cb && hydratedFor !== profile?.userId) {
      const hydrated = fieldsFromState(cb);
      setFields(hydrated);
      setEvaluation(cb.lastEvaluation ?? null);
      // If the server has a stored evaluation, treat the hydrated fields as
      // the snapshot it was scored against — they were the confirmed values.
      setEvaluatedSnapshot(cb.lastEvaluation ? hydrated : null);
      setHydratedFor(profile?.userId ?? null);
    }
  }, [cb, profile?.userId, hydratedFor]);

  const evaluateMutation = useEvaluateContextBlock();
  const confirmMutation = useConfirmContextBlock();

  const allFilled = useMemo(
    () =>
      ELEMENTS.every((e) => (fields[e.key] ?? "").trim().length > 0),
    [fields],
  );

  // Stale = the user has edited any field since the last evaluation we hold.
  const evaluationStale = useMemo(() => {
    if (!evaluation || !evaluatedSnapshot) return false;
    return ELEMENTS.some(
      (e) => (fields[e.key] ?? "") !== (evaluatedSnapshot[e.key] ?? ""),
    );
  }, [fields, evaluation, evaluatedSnapshot]);

  const onEvaluate = async () => {
    setError(null);
    const snapshot = { ...fields };
    try {
      const result = await evaluateMutation.mutateAsync({ data: snapshot });
      setEvaluation(result);
      setEvaluatedSnapshot(snapshot);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Evaluator failed. Try again.",
      );
    }
  };

  // Confirms with optional `bypass: true` for the sub-threshold path
  // (Task #99). The bypass-dialog flow calls this with bypass=true after
  // the operator acknowledges the warning; the normal in-threshold path
  // calls it without `bypass` and the server enforces the threshold.
  const submitConfirm = async (opts: { bypass?: boolean } = {}) => {
    setError(null);
    const snapshot = { ...fields };
    try {
      const result = await confirmMutation.mutateAsync({
        data: { ...snapshot, ...(opts.bypass ? { bypass: true } : {}) },
      });
      setEvaluation(result.evaluation);
      setEvaluatedSnapshot(snapshot);
      queryClient.invalidateQueries({ queryKey: getGetMyProfileQueryKey() });
      // Confirming bumps the context-block version on the server, which
      // invalidates any cached launch affirmation (Task #45). Refetch so
      // the marketplace re-prompts the modal on the next launch.
      queryClient.invalidateQueries({
        queryKey: getGetLaunchAffirmationQueryKey(),
      });
      return true;
    } catch (err) {
      // Surface server-side rejection (NO-GO / OPSEC) which arrives as 422
      // with { error, evaluation }.
      const anyErr = err as {
        message?: string;
        response?: { data?: { error?: string; evaluation?: ContextBlockEvaluation } };
      };
      const data = anyErr.response?.data;
      if (data?.evaluation) setEvaluation(data.evaluation);
      setError(
        data?.error ??
          anyErr.message ??
          "Could not confirm Context Block.",
      );
      return false;
    }
  };

  // Sub-threshold (NO-GO with no OPSEC) bypass dialog state. The Confirm
  // Context Block button opens this dialog instead of being a no-op when
  // the latest evaluation is below 10/12 with no OPSEC flag.
  const [bypassDialogOpen, setBypassDialogOpen] = useState(false);

  const isGo = evaluation?.status === "GO" && !evaluation.opsecFlag;
  // OPSEC failures remain a hard block — no bypass is offered.
  const canBypass =
    !!evaluation &&
    !evaluation.opsecFlag &&
    !isGo &&
    !evaluationStale &&
    allFilled;

  const onConfirm = async () => {
    if (canBypass) {
      setBypassDialogOpen(true);
      return;
    }
    await submitConfirm();
  };

  const onConfirmBypass = async () => {
    const ok = await submitConfirm({ bypass: true });
    if (ok) setBypassDialogOpen(false);
  };

  const evaluating = evaluateMutation.isPending;
  const confirming = confirmMutation.isPending;
  // Confirm is enabled when the operator has either a clean GO score, OR
  // a sub-threshold (non-OPSEC) score that they can choose to bypass.
  const canConfirm =
    (isGo || canBypass) && !evaluationStale && allFilled && !confirming;

  const [importMessage, setImportMessage] = useState<ImportMessage | null>(
    null,
  );

  const exportContextBlock = useCallback(
    (format: "md" | "json") => {
      const date = new Date().toISOString().slice(0, 10);
      // Use the live editor `fields` for the six values so unsaved edits are
      // captured. The metadata block (confirmedAt / lastEvaluation / version)
      // reflects the persisted server state — those only update on confirm.
      let content: string;
      let mime: string;
      let ext: string;
      if (format === "md") {
        content = contextBlockToMarkdown(fields, cb ?? null);
        mime = "text/markdown;charset=utf-8";
        ext = "md";
      } else {
        const payload = {
          contextBlock: {
            ...fields,
            confirmedAt: cb?.confirmedAt ?? null,
            version: cb?.version ?? null,
            lastEvaluation: cb?.lastEvaluation ?? null,
          },
        };
        content = JSON.stringify(payload, null, 2);
        mime = "application/json;charset=utf-8";
        ext = "json";
      }
      const blob = new Blob([content], { type: mime });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `context-block-${date}.${ext}`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    },
    [fields, cb],
  );

  const importContextBlock = useCallback(
    async (file: File) => {
      setImportMessage(null);
      const isJson =
        file.type === "application/json" ||
        file.name.toLowerCase().endsWith(".json");
      if (!isJson) {
        setImportMessage({
          kind: "error",
          text: "Context Block import expects a .json file. Other file types are not supported.",
        });
        return;
      }
      let text: string;
      try {
        text = await file.text();
      } catch {
        setImportMessage({
          kind: "error",
          text: "Could not read the selected file.",
        });
        return;
      }
      let json: unknown;
      try {
        json = JSON.parse(text);
      } catch {
        setImportMessage({
          kind: "error",
          text: "File is not valid JSON.",
        });
        return;
      }
      const parsed = parseContextBlockImport(json);
      if (!parsed.ok) {
        setImportMessage({ kind: "error", text: parsed.error });
        return;
      }
      // Load the six fields into the editor as unsaved edits. We deliberately
      // leave `evaluation` and `evaluatedSnapshot` untouched so the existing
      // staleness detector flags the imported values as "Changed —
      // re-evaluate". The operator must Evaluate + Confirm to commit.
      setFields(parsed.fields);
      setError(null);
      setImportMessage({
        kind: "notice",
        text: parsed.hasProfile
          ? "Context Block fields loaded into the editor. The file also contained an operator profile — import that on the Operator Profile page. Evaluate and Confirm to commit."
          : "Context Block fields loaded into the editor. Evaluate and Confirm to commit.",
      });
    },
    [],
  );

  return (
    <PageContainer>
      <div className="mb-8 flex items-end justify-between gap-6">
        <div>
          <div className="text-[10px] uppercase tracking-[0.25em] text-primary font-mono font-semibold mb-2">
            Catalog · Verification Gate
          </div>
          <h1 className="text-3xl font-semibold tracking-tight">
            6-Element Context Block
          </h1>
          <p className="text-sm text-muted-foreground mt-1 max-w-3xl">
            Tools may not be launched until the Evaluator Agent scores your
            Context Block at <span className="font-mono">10/12</span> or higher
            and confirms no OPSEC violations. The confirmed block ships with
            every tool launch.
          </p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <ExportMenu onExport={exportContextBlock} />
          <ImportControl onFile={importContextBlock} />
        </div>
      </div>

      <ImportMessageBanner
        message={importMessage}
        onDismiss={() => setImportMessage(null)}
      />

      <div className="grid lg:grid-cols-[1fr_360px] gap-6">
        <div className="space-y-4">
          {/* When the operator has a confirmed Context Block AND hasn't
              edited any field, surface a clear "go straight to tools"
              affordance — no re-evaluation needed. */}
          {cb?.confirmedAt && !evaluationStale && (
            <div className="bg-primary/10 border border-primary/40 rounded-md p-4 flex items-center justify-between gap-3 flex-wrap">
              <div>
                <div className="text-sm font-semibold text-primary flex items-center gap-2 flex-wrap">
                  Context Block confirmed — no changes pending
                  {cb?.bypassed && (
                    <Pill tone="warn">Bypassed (under 10/12)</Pill>
                  )}
                </div>
                <p className="text-xs text-muted-foreground mt-0.5">
                  {cb?.bypassed
                    ? "Your block was confirmed under the 10/12 threshold. Tools will see a lower-assurance notice when you launch."
                    : "Your confirmed block ships with every launch. Proceed to the tool list, or edit any element below to re-evaluate."}
                </p>
              </div>
              <Link
                href="/catalog/browse"
                className="shrink-0 px-4 py-2 rounded-md bg-primary text-primary-foreground text-sm font-semibold hover:bg-primary/90 transition-colors"
              >
                Continue to tools →
              </Link>
            </div>
          )}

          {ELEMENTS.map((el) => {
            const value = fields[el.key] ?? "";
            const isEmpty = value.trim().length === 0;
            const baseline = evaluatedSnapshot?.[el.key] ?? "";
            const isEditedSinceEval =
              !!evaluation && !!evaluatedSnapshot && value !== baseline;
            const setValue = (
              updater: string | ((prev: string) => string),
            ) =>
              setFields((prev) => ({
                ...prev,
                [el.key]:
                  typeof updater === "function"
                    ? (updater as (p: string) => string)(prev[el.key] ?? "")
                    : updater,
              }));
            return (
              <div
                key={el.key}
                className={`bg-card border rounded-md p-4 transition-colors ${
                  isEmpty
                    ? "border-amber-500/40"
                    : isEditedSinceEval
                      ? "border-amber-500/30"
                      : "border-border"
                }`}
              >
                <div className="flex items-baseline justify-between gap-3 mb-1">
                  <span className="text-sm font-semibold flex items-center gap-2">
                    {el.label}
                    {isEmpty && <Pill tone="warn">Needs update</Pill>}
                    {!isEmpty && isEditedSinceEval && (
                      <Pill tone="warn">Changed — re-evaluate</Pill>
                    )}
                  </span>
                  <span className="text-[10px] font-mono uppercase tracking-wider text-muted-foreground">
                    {value.length} chars
                  </span>
                </div>
                <p className="text-xs text-muted-foreground mb-2">
                  {el.hint}
                </p>
                {el.key === "doctrine" && (
                  <DoctrinePicker value={value} setValue={setValue} />
                )}
                <textarea
                  data-testid={`textarea-${el.key}`}
                  value={value}
                  onChange={(e) =>
                    setFields((prev) => ({
                      ...prev,
                      [el.key]: e.target.value,
                    }))
                  }
                  rows={el.key === "doctrine" ? 8 : 4}
                  placeholder="Enter operational detail…"
                  className="w-full px-3 py-2 rounded-md bg-background border border-border text-sm focus:border-primary focus:outline-none font-mono"
                />
              </div>
            );
          })}

          <div className="flex flex-wrap gap-3 pt-2">
            <button
              type="button"
              onClick={onEvaluate}
              disabled={!allFilled || evaluating}
              className="px-4 py-2 rounded-md bg-secondary text-secondary-foreground text-sm font-medium disabled:opacity-50 hover:bg-secondary/80 transition-colors"
            >
              {evaluating ? "Scoring…" : "Evaluate"}
            </button>
            <button
              type="button"
              onClick={onConfirm}
              disabled={!canConfirm}
              data-testid="button-confirm-context-block"
              title={
                canBypass
                  ? "Score is below 10/12 — confirming will require an explicit bypass acknowledgment."
                  : undefined
              }
              className="px-4 py-2 rounded-md bg-primary text-primary-foreground text-sm font-medium disabled:opacity-50 hover:bg-primary/90 transition-colors"
            >
              {confirming ? "Confirming…" : "Confirm Context Block"}
            </button>
            <Link
              href="/catalog/browse"
              className="ml-auto px-4 py-2 rounded-md border border-border text-sm font-mono uppercase tracking-wider hover:border-primary/50 transition-colors"
            >
              Browse Catalog →
            </Link>
          </div>
          {error && <ErrorBox>{error}</ErrorBox>}
        </div>

        <aside className="space-y-4">
          <ConfirmationCard cb={cb} loading={isLoading} />
          <EvaluationCard
            evaluation={evaluation}
            stale={evaluationStale}
            allFilled={allFilled}
          />
        </aside>
      </div>

      <BypassConfirmDialog
        open={bypassDialogOpen}
        evaluation={evaluation}
        submitting={confirming}
        onCancel={() => setBypassDialogOpen(false)}
        onConfirm={onConfirmBypass}
      />
    </PageContainer>
  );
}

// Labels used in the bypass dialog to surface which of the four scoring
// criteria fell short. These are the criteria the evaluator scores (1..3
// each, total /12) — distinct from the six context-block elements the
// operator fills out.
const CRITERIA: Array<{
  key: keyof ContextBlockEvaluation["scores"];
  label: string;
}> = [
  { key: "doctrine", label: "Doctrine & Orders" },
  { key: "environment", label: "Environment & Commander's Intent" },
  { key: "constraints", label: "Constraints, Limitations & Risk" },
  { key: "experience", label: "Experience & Judgment" },
];

function BypassConfirmDialog({
  open,
  evaluation,
  submitting,
  onCancel,
  onConfirm,
}: {
  open: boolean;
  evaluation: ContextBlockEvaluation | null;
  submitting: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const [acknowledged, setAcknowledged] = useState(false);
  // Reset the acknowledgment checkbox each time the dialog opens so the
  // operator can't accidentally inherit a prior "already checked" state.
  if (!open && acknowledged) {
    setAcknowledged(false);
  }

  const scores = evaluation?.scores;
  const shortfalls = scores
    ? CRITERIA.filter((c) => (scores[c.key] ?? 0) < 3)
    : [];
  // The evaluator returns "None" when no flags fired; treat that as empty.
  const flagText = (() => {
    const raw = (evaluation?.flags ?? "").trim();
    if (!raw || raw.toLowerCase() === "none") return null;
    return raw;
  })();

  return (
    <Dialog open={open} onOpenChange={(o) => !o && !submitting && onCancel()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Confirm under threshold?</DialogTitle>
          <DialogDescription>
            This Context Block scored{" "}
            <span className="font-mono">
              {evaluation?.totalScore ?? "?"}/12
            </span>
            , below the 10/12 review threshold. You can confirm anyway, but
            the row will be persisted with a bypass flag and surfaced in the
            launch affirmation modal and admin audit.
          </DialogDescription>
        </DialogHeader>

        {scores && (
          <div className="rounded-md border border-border bg-card p-3">
            <div className="text-[10px] font-mono uppercase tracking-wider text-muted-foreground mb-2">
              Per-criterion scores
            </div>
            <ul className="space-y-1.5 text-xs">
              {CRITERIA.map((c) => {
                const s = scores[c.key] ?? 0;
                const short = s < 3;
                return (
                  <li
                    key={c.key}
                    data-testid={`bypass-criterion-${c.key}`}
                    className="flex items-center justify-between gap-3"
                  >
                    <span
                      className={
                        short
                          ? "text-amber-300 font-medium"
                          : "text-foreground/90"
                      }
                    >
                      {c.label}
                      {short && (
                        <span className="ml-2 text-[10px] uppercase tracking-wider text-amber-300/80 font-mono">
                          shortfall
                        </span>
                      )}
                    </span>
                    <span
                      className={`font-mono ${
                        short ? "text-amber-300" : "text-emerald-400"
                      }`}
                    >
                      {s}/3
                    </span>
                  </li>
                );
              })}
            </ul>
            {shortfalls.length === 0 && (
              <p className="mt-2 text-[11px] text-muted-foreground">
                All four criteria scored 3/3, but the total is still being
                reported below 10/12 — re-evaluate after editing if this looks
                wrong.
              </p>
            )}
          </div>
        )}

        {flagText && (
          <div
            data-testid="bypass-flags"
            className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-200"
          >
            <div className="text-[10px] font-mono uppercase tracking-wider text-amber-300/80 mb-1">
              Evaluator flags
            </div>
            {flagText}
          </div>
        )}

        <div className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-200">
          OPSEC violations cannot be bypassed. This option is only available
          when the block is sub-threshold but OPSEC-clean.
        </div>

        <label className="flex items-start gap-3 rounded-md border border-border bg-card px-3 py-2 cursor-pointer">
          <input
            type="checkbox"
            data-testid="checkbox-bypass-acknowledge"
            checked={acknowledged}
            onChange={(e) => setAcknowledged(e.target.checked)}
            className="mt-0.5 h-4 w-4 rounded border-border bg-background text-primary focus:ring-primary"
          />
          <span className="text-sm">
            I understand the score is below 10/12 and accept the lower
            assurance for downstream tool launches.
          </span>
        </label>

        <div className="flex items-center justify-end gap-2 pt-2 border-t border-border">
          <button
            type="button"
            onClick={onCancel}
            disabled={submitting}
            className="h-9 px-4 rounded-md border border-border text-sm hover:bg-accent/50 disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={!acknowledged || submitting}
            data-testid="button-confirm-bypass"
            className="h-9 px-4 rounded-md bg-amber-600 text-white text-sm font-medium hover:bg-amber-600/90 disabled:opacity-50"
          >
            {submitting ? "Confirming…" : "Confirm anyway"}
          </button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function ConfirmationCard({
  cb,
  loading,
}: {
  cb: ContextBlockState | undefined;
  loading: boolean;
}) {
  if (loading) {
    return (
      <div className="bg-card border border-border rounded-md p-4 animate-pulse h-32" />
    );
  }
  const confirmedAt = cb?.confirmedAt ? new Date(cb.confirmedAt) : null;
  return (
    <div className="bg-card border border-border rounded-md p-4">
      <div className="text-[10px] font-mono uppercase tracking-wider text-muted-foreground mb-2">
        Confirmation Status
      </div>
      {confirmedAt ? (
        <>
          <div className="flex items-center gap-2 mb-1 flex-wrap">
            <Pill tone="good">Confirmed</Pill>
            {cb?.lastEvaluation && (
              <span className="text-xs font-mono">
                {cb.lastEvaluation.totalScore}/12
              </span>
            )}
            {cb?.bypassed && <Pill tone="warn">Bypassed</Pill>}
          </div>
          <p className="text-xs text-muted-foreground">
            Last confirmed{" "}
            <span className="font-mono">
              {confirmedAt.toLocaleString()}
            </span>
            .{" "}
            {cb?.bypassed
              ? "Confirmed under the 10/12 threshold — tools see a lower-assurance flag."
              : "This block ships in every tool launch."}
          </p>
        </>
      ) : (
        <>
          <Pill tone="warn">Not confirmed</Pill>
          <p className="text-xs text-muted-foreground mt-2">
            Tool launches will note that no Context Block is on file until you
            confirm one here.
          </p>
        </>
      )}
    </div>
  );
}

function EvaluationCard({
  evaluation,
  stale,
  allFilled,
}: {
  evaluation: ContextBlockEvaluation | null;
  stale: boolean;
  allFilled: boolean;
}) {
  if (!evaluation) {
    return (
      <div className="bg-card border border-border rounded-md p-4">
        <div className="text-[10px] font-mono uppercase tracking-wider text-muted-foreground mb-2">
          Latest Evaluation
        </div>
        <p className="text-xs text-muted-foreground">
          {allFilled
            ? "Press Evaluate to score this Context Block."
            : "Fill in all six elements, then Evaluate."}
        </p>
      </div>
    );
  }
  const isGo = evaluation.status === "GO" && !evaluation.opsecFlag;
  return (
    <div className="bg-card border border-border rounded-md p-4">
      <div className="text-[10px] font-mono uppercase tracking-wider text-muted-foreground mb-2">
        Latest Evaluation
      </div>
      <div className="flex items-center gap-2 mb-3">
        {isGo ? (
          <Pill tone="good">GO</Pill>
        ) : (
          <Pill tone="destructive">NO-GO</Pill>
        )}
        <span className="text-xl font-mono font-semibold">
          {evaluation.totalScore}
          <span className="text-sm text-muted-foreground">/12</span>
        </span>
        {stale && <Pill tone="warn">Edits not re-scored</Pill>}
      </div>
      <ul className="text-xs space-y-1.5 font-mono mb-3">
        <li className="flex justify-between">
          <span className="text-muted-foreground">Doctrine & Orders</span>
          <span>{evaluation.scores.doctrine}/3</span>
        </li>
        <li className="flex justify-between">
          <span className="text-muted-foreground">Env & Intent</span>
          <span>{evaluation.scores.environment}/3</span>
        </li>
        <li className="flex justify-between">
          <span className="text-muted-foreground">
            Constraints & Risk
          </span>
          <span>{evaluation.scores.constraints}/3</span>
        </li>
        <li className="flex justify-between">
          <span className="text-muted-foreground">Experience</span>
          <span>{evaluation.scores.experience}/3</span>
        </li>
      </ul>
      {evaluation.opsecFlag && (
        <div className="rounded-md border border-red-500/40 bg-red-500/10 p-2 text-xs mb-2">
          <div className="font-semibold text-red-300">OPSEC fail-safe</div>
          <p className="text-muted-foreground mt-1">
            Total score forced to 0. Remove any CUI, PII, or classified
            references and re-evaluate.
          </p>
        </div>
      )}
      <p className="text-xs text-muted-foreground">
        <span className="font-mono uppercase tracking-wider">Flags:</span>{" "}
        {evaluation.flags || "None"}
      </p>
    </div>
  );
}

// ---------- Doctrine picker UI --------------------------------------------

type UploadStage = "idle" | "requesting-url" | "uploading" | "registering";

function DoctrinePicker({
  value,
  setValue,
}: {
  value: string;
  setValue: (updater: string | ((prev: string) => string)) => void;
}) {
  const queryClient = useQueryClient();

  // Reuse the same polling pattern the Library page uses so we see status
  // flip from "uploaded" → "processing" → "ready"/"failed" without a
  // manual refresh — important when the operator uploads a new doc inline
  // and needs the picker to auto-tick it once it's ready.
  const { data: docs, isLoading } = useListDocuments(undefined, {
    query: {
      queryKey: getListDocumentsQueryKey(),
      refetchInterval: (q) => {
        const list = q.state.data as DocumentSummary[] | undefined;
        if (!list) return false;
        return list.some(
          (d) => d.status === "uploaded" || d.status === "processing",
        )
          ? 1500
          : false;
      },
    },
  });

  const uploadMutation = useUploadTextDocument();
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [open, setOpen] = useState(false);
  const [uploadStage, setUploadStage] = useState<UploadStage>("idle");
  const [uploadProgress, setUploadProgress] = useState(0);
  const [uploadError, setUploadError] = useState<string | null>(null);
  // IDs of docs the operator just uploaded inline. As soon as one of them
  // flips to "ready" we add it as a reference line. This lives outside the
  // textbox content so we don't have to encode "pending" state in the
  // textarea itself.
  const [pendingAutoTickIds, setPendingAutoTickIds] = useState<string[]>([]);

  // Keep the dropdown stable but bounded — the typical operator has 5–20
  // docs (foundational + MOS + a few uploads). Sort ready first, processing
  // next, failed last; within each group, newest first.
  const sortedDocs = useMemo<DocumentSummary[]>(() => {
    if (!docs) return [];
    const rank: Record<string, number> = {
      ready: 0,
      processing: 1,
      uploaded: 1,
      failed: 2,
    };
    return [...docs].sort((a, b) => {
      const ra = rank[a.status] ?? 3;
      const rb = rank[b.status] ?? 3;
      if (ra !== rb) return ra - rb;
      return (
        new Date(b.uploadedAt).getTime() - new Date(a.uploadedAt).getTime()
      );
    });
  }, [docs]);

  const checkedIds = useMemo(
    () => parseCheckedIds(value, sortedDocs),
    [value, sortedDocs],
  );

  const tickedCount = useMemo(() => {
    // Count every managed reference line so a stale title (e.g. a doc that
    // was deleted upstream and no longer matches anything in the library)
    // still shows up in the summary line — that way the operator can see
    // there's something they may want to clean up.
    const titles = parseReferenceTitles(value);
    return titles.length;
  }, [value]);

  // Auto-tick freshly-uploaded docs the moment they reach "ready". Drop
  // ids that ended up "failed" so we don't spin forever waiting on them.
  useEffect(() => {
    if (!docs || pendingAutoTickIds.length === 0) return;

    const readyDocs: DocumentSummary[] = [];
    const stillPending: string[] = [];
    for (const id of pendingAutoTickIds) {
      const doc = docs.find((d) => d.id === id);
      if (!doc) continue; // doc disappeared — drop it
      if (doc.status === "ready") readyDocs.push(doc);
      else if (doc.status === "uploaded" || doc.status === "processing")
        stillPending.push(id);
      // failed → drop (nothing to tick)
    }

    if (stillPending.length !== pendingAutoTickIds.length) {
      setPendingAutoTickIds(stillPending);
    }

    if (readyDocs.length === 0) return;

    setValue((prev) => {
      let next = prev;
      for (const doc of readyDocs) next = addBlock(next, doc);
      return next;
    });
  }, [docs, pendingAutoTickIds, setValue]);

  const toggleDoc = useCallback(
    (doc: DocumentSummary, currentlyChecked: boolean) => {
      if (currentlyChecked) {
        setValue((prev) => removeBlock(prev, doc));
        return;
      }
      if (doc.status !== "ready") return;
      setValue((prev) => addBlock(prev, doc));
    },
    [setValue],
  );

  // Two-step storage upload — same flow the Library page uses (presigned
  // URL → PUT to GCS → register). Kept inline so the operator doesn't have
  // to context-switch to the Library page just to add a doc.
  const onPickFile = useCallback(
    async (file: File) => {
      setUploadError(null);
      if (file.size > DOCTRINE_SNIPPET_MAX_BYTES) {
        setUploadError(
          `File is ${formatBytes(file.size)} — limit is ${formatBytes(
            DOCTRINE_SNIPPET_MAX_BYTES,
          )}.`,
        );
        return;
      }
      try {
        setUploadStage("requesting-url");
        const mimeType = inferDoctrineMimeType(file.name, file.type);
        const { uploadURL, objectPath } = await requestUploadUrl({
          name: file.name,
          size: file.size,
          contentType: mimeType,
        });

        setUploadStage("uploading");
        setUploadProgress(0);
        await new Promise<void>((resolve, reject) => {
          const xhr = new XMLHttpRequest();
          xhr.open("PUT", uploadURL, true);
          xhr.setRequestHeader("Content-Type", mimeType);
          xhr.upload.onprogress = (e) => {
            if (e.lengthComputable) {
              setUploadProgress(Math.round((e.loaded / e.total) * 100));
            }
          };
          xhr.onload = () => {
            if (xhr.status >= 200 && xhr.status < 300) {
              setUploadProgress(100);
              resolve();
            } else {
              reject(
                new Error(
                  `Upload to storage failed (${xhr.status} ${
                    xhr.statusText || ""
                  })`,
                ),
              );
            }
          };
          xhr.onerror = () =>
            reject(new Error("Network error while uploading the file."));
          xhr.send(file);
        });

        setUploadStage("registering");
        const created = await uploadMutation.mutateAsync({
          data: {
            title: file.name.replace(/\.[^.]+$/, ""),
            sourceFilename: file.name,
            mimeType,
            storageObjectPath: objectPath,
            sizeBytes: file.size,
          },
        });

        setUploadStage("idle");
        setUploadProgress(0);
        // Mark the new doc for auto-tick once it's ready, then refresh the
        // list so the polling effect picks it up.
        setPendingAutoTickIds((prev) => [...prev, created.id]);
        queryClient.invalidateQueries({
          queryKey: getListDocumentsQueryKey(),
        });
        queryClient.invalidateQueries({
          queryKey: getGetLibraryStatsQueryKey(),
        });
        if (fileInputRef.current) fileInputRef.current.value = "";
      } catch (err) {
        setUploadError(err instanceof Error ? err.message : "Upload failed");
        setUploadStage("idle");
        setUploadProgress(0);
      }
    },
    [queryClient, uploadMutation],
  );

  const uploadingNow =
    uploadStage === "requesting-url" ||
    uploadStage === "uploading" ||
    uploadStage === "registering";

  const summaryLine = (() => {
    if (isLoading) return "Loading library…";
    if (sortedDocs.length === 0)
      return "No doctrine in your library yet — upload one below.";
    if (tickedCount === 0)
      return `${sortedDocs.length} doc${
        sortedDocs.length === 1 ? "" : "s"
      } available`;
    return `${tickedCount} of ${sortedDocs.length} ticked`;
  })();

  return (
    <div
      className="mb-3 rounded-md border border-border bg-background"
      data-testid="doctrine-picker"
    >
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center justify-between gap-3 px-3 py-2 text-left"
        data-testid="doctrine-picker-toggle"
      >
        <span className="text-xs font-mono uppercase tracking-wider text-muted-foreground">
          Pick from your library
        </span>
        <span className="flex items-center gap-2">
          <span className="text-xs font-mono">{summaryLine}</span>
          <span className="text-muted-foreground text-xs">
            {open ? "▲" : "▼"}
          </span>
        </span>
      </button>

      {open && (
        <div className="border-t border-border px-3 py-3 space-y-3">
          {sortedDocs.length === 0 && !isLoading && (
            <div className="text-xs text-muted-foreground italic">
              No doctrine in your library yet. Use the button below to
              upload a file, or add doctrine from the Library page.
            </div>
          )}

          {sortedDocs.length > 0 && (
            <ul
              className="max-h-56 overflow-y-auto divide-y divide-border/60 rounded border border-border/60"
              data-testid="doctrine-picker-list"
            >
              {sortedDocs.map((doc) => {
                const checked = checkedIds.has(doc.id);
                const isReady = doc.status === "ready";
                const disabled = !isReady && !checked;
                return (
                  <li
                    key={doc.id}
                    className={`flex items-start gap-3 px-3 py-2 text-xs ${
                      disabled && !checked ? "opacity-60" : ""
                    }`}
                    data-testid={`doctrine-picker-row-${doc.id}`}
                  >
                    <input
                      type="checkbox"
                      className="mt-0.5 h-4 w-4 accent-primary"
                      checked={checked}
                      disabled={disabled}
                      onChange={() => toggleDoc(doc, checked)}
                      data-testid={`doctrine-picker-checkbox-${doc.id}`}
                      aria-label={`Tick ${doc.title}`}
                    />
                    <div className="min-w-0 flex-1">
                      <div className="font-medium text-foreground truncate">
                        {doc.title}
                      </div>
                      <div className="mt-0.5 flex flex-wrap items-center gap-2 text-[10px] font-mono uppercase tracking-wider text-muted-foreground">
                        <span>{sourceLabel(doc)}</span>
                        {!isReady && (
                          <span className="text-amber-300">
                            {doc.status === "failed"
                              ? "failed"
                              : doc.status === "processing"
                                ? "extracting…"
                                : "queued"}
                          </span>
                        )}
                      </div>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}

          <div className="flex flex-wrap items-center gap-3 pt-1 border-t border-border/50">
            <input
              ref={fileInputRef}
              type="file"
              accept={DOCTRINE_ACCEPTED_EXT}
              className="hidden"
              data-testid="doctrine-picker-file-input"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) void onPickFile(f);
              }}
            />
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              disabled={uploadingNow}
              className="px-3 py-1.5 rounded bg-primary/10 text-primary text-[11px] font-mono uppercase tracking-wider border border-primary/40 hover:bg-primary/20 disabled:opacity-50"
              data-testid="doctrine-picker-upload-btn"
            >
              {uploadingNow
                ? uploadStage === "uploading"
                  ? `Uploading… ${uploadProgress}%`
                  : uploadStage === "requesting-url"
                    ? "Requesting URL…"
                    : "Registering…"
                : "Upload doctrine file"}
            </button>
            <span className="text-[10px] text-muted-foreground font-mono">
              PDF, DOCX, MD, TXT — max{" "}
              {formatBytes(DOCTRINE_SNIPPET_MAX_BYTES)}
            </span>
            {pendingAutoTickIds.length > 0 && (
              <span className="text-[10px] text-primary font-mono">
                Waiting for {pendingAutoTickIds.length} new doc
                {pendingAutoTickIds.length === 1 ? "" : "s"} to finish
                processing…
              </span>
            )}
          </div>
          {uploadError && <ErrorBox>{uploadError}</ErrorBox>}
        </div>
      )}
    </div>
  );
}
