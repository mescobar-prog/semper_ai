import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import {
  useGetMyProfile,
  useEvaluateContextBlock,
  useConfirmContextBlock,
  useListDocuments,
  useUploadTextDocument,
  getDocumentSnippet,
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
  DocumentSnippet,
  DocumentSummary,
} from "@workspace/api-client-react";
import { parseAutoSource } from "@workspace/mil-data";
import { PageContainer, ErrorBox, Pill, formatBytes } from "@/lib/format";

// ---------- Doctrine picker — text-region helpers --------------------------
//
// The Doctrine & Orders textarea is now split into two regions:
//   1. an auto-managed snippet region at the top, one delimited block per
//      ticked library doc, followed by
//   2. a `--- Orders ---` divider, followed by
//   3. the operator's free-form orders.
//
// Blocks are wrapped in `<<< doc:<id> >>> … <<< /doc >>>` markers so the
// picker can add/remove a single doc's snippet without disturbing the
// operator's free-form text or any other doc's snippet. The markers are
// visible (not hidden) so the operator can see exactly what will ship to
// the tool.
//
// Selection state in the UI is derived from the textarea content (by
// scanning for `<<< doc:id >>>` markers in the snippet region), which means
// the checkboxes and the textarea can never disagree — a manual edit that
// removes a block also un-ticks its checkbox automatically.

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
  // Strip trailing whitespace from the snippet region so the divider sits
  // tight against the last block, and only insert the divider when there
  // are snippet blocks. A brand-new operator with zero ticks should see a
  // plain textarea — no stray marker text.
  const trimmed = snippetRegion.replace(/\s+$/, "");
  if (!trimmed) return ordersRegion;
  return `${trimmed}\n\n${ORDERS_DIVIDER}\n${ordersRegion}`;
}

function parseCheckedIds(content: string): Set<string> {
  const region = getSnippetRegion(content);
  const ids = new Set<string>();
  const re = /<<<\s*doc:([^\s>]+)\s*>>>[\s\S]*?<<<\s*\/doc\s*>>>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(region))) {
    ids.add(m[1]);
  }
  return ids;
}

function buildBlock(doc: DocumentSummary, snippet: DocumentSnippet): string {
  const truncationMarker = snippet.truncated ? "\n…" : "";
  return `<<< doc:${doc.id} >>>\n[${doc.title}]\n${snippet.snippet}${truncationMarker}\n<<< /doc >>>`;
}

function addBlock(
  content: string,
  doc: DocumentSummary,
  snippet: DocumentSnippet,
): string {
  if (parseCheckedIds(content).has(doc.id)) return content;
  const snippetRegion = getSnippetRegion(content);
  const ordersRegion = getOrdersRegion(content);
  const sep = snippetRegion && !snippetRegion.endsWith("\n\n") ? "\n\n" : "";
  const nextSnippets = `${snippetRegion}${sep}${buildBlock(doc, snippet)}\n\n`;
  return joinRegions(nextSnippets, ordersRegion);
}

function removeBlock(content: string, docId: string): string {
  const snippetRegion = getSnippetRegion(content);
  const ordersRegion = getOrdersRegion(content);
  const re = new RegExp(
    `<<<\\s*doc:${escapeRegExp(docId)}\\s*>>>[\\s\\S]*?<<<\\s*\\/doc\\s*>>>\\s*`,
    "g",
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

  const onConfirm = async () => {
    setError(null);
    const snapshot = { ...fields };
    try {
      const result = await confirmMutation.mutateAsync({ data: snapshot });
      setEvaluation(result.evaluation);
      setEvaluatedSnapshot(snapshot);
      queryClient.invalidateQueries({ queryKey: getGetMyProfileQueryKey() });
      // Confirming bumps the context-block version on the server, which
      // invalidates any cached launch affirmation (Task #45). Refetch so
      // the marketplace re-prompts the modal on the next launch.
      queryClient.invalidateQueries({
        queryKey: getGetLaunchAffirmationQueryKey(),
      });
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
    }
  };

  const evaluating = evaluateMutation.isPending;
  const confirming = confirmMutation.isPending;
  const isGo = evaluation?.status === "GO" && !evaluation.opsecFlag;
  const canConfirm = isGo && !evaluationStale && allFilled && !confirming;

  return (
    <PageContainer>
      <div className="mb-8">
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

      <div className="grid lg:grid-cols-[1fr_360px] gap-6">
        <div className="space-y-4">
          {/* When the operator has a confirmed Context Block AND hasn't
              edited any field, surface a clear "go straight to tools"
              affordance — no re-evaluation needed. */}
          {cb?.confirmedAt && !evaluationStale && (
            <div className="bg-primary/10 border border-primary/40 rounded-md p-4 flex items-center justify-between gap-3 flex-wrap">
              <div>
                <div className="text-sm font-semibold text-primary">
                  Context Block confirmed — no changes pending
                </div>
                <p className="text-xs text-muted-foreground mt-0.5">
                  Your confirmed block ships with every launch. Proceed to
                  the tool list, or edit any element below to re-evaluate.
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
    </PageContainer>
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
          <div className="flex items-center gap-2 mb-1">
            <Pill tone="good">Confirmed</Pill>
            {cb?.lastEvaluation && (
              <span className="text-xs font-mono">
                {cb.lastEvaluation.totalScore}/12
              </span>
            )}
          </div>
          <p className="text-xs text-muted-foreground">
            Last confirmed{" "}
            <span className="font-mono">
              {confirmedAt.toLocaleString()}
            </span>
            . This block ships in every tool launch.
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
  const [snippetError, setSnippetError] = useState<string | null>(null);
  // IDs of docs the operator just uploaded inline. As soon as one of them
  // flips to "ready" we fetch its snippet and tick it. This lives outside
  // the textbox content so we don't have to encode "pending" state in the
  // textarea itself.
  const [pendingAutoTickIds, setPendingAutoTickIds] = useState<string[]>([]);
  // While we're fetching a snippet for a manual tick, optimistically lock
  // out repeat clicks on that doc.
  const [fetchingIds, setFetchingIds] = useState<Set<string>>(new Set());

  const checkedIds = useMemo(() => parseCheckedIds(value), [value]);

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

  const tickedCount = useMemo(
    () =>
      sortedDocs.filter((d) => checkedIds.has(d.id)).length +
      // Count ids in the textbox that aren't in the library (e.g. a doc
      // that was deleted upstream) so the summary line is honest.
      Array.from(checkedIds).filter(
        (id) => !sortedDocs.some((d) => d.id === id),
      ).length,
    [sortedDocs, checkedIds],
  );

  // Auto-tick freshly-uploaded docs the moment they reach "ready". Drop
  // ids that ended up "failed" so we don't spin forever waiting on them.
  useEffect(() => {
    if (!docs || pendingAutoTickIds.length === 0) return;

    const readyIds: string[] = [];
    const stillPending: string[] = [];
    for (const id of pendingAutoTickIds) {
      const doc = docs.find((d) => d.id === id);
      if (!doc) continue; // doc disappeared — drop it
      if (doc.status === "ready") readyIds.push(id);
      else if (doc.status === "uploaded" || doc.status === "processing")
        stillPending.push(id);
      // failed → drop (nothing to tick)
    }

    if (readyIds.length === 0) {
      if (stillPending.length !== pendingAutoTickIds.length) {
        setPendingAutoTickIds(stillPending);
      }
      return;
    }

    // Optimistically remove the ids we're about to tick so this effect
    // doesn't re-fire on the next docs refresh while the snippet fetch is
    // in flight.
    setPendingAutoTickIds(stillPending);

    void Promise.all(
      readyIds.map(async (id) => {
        const doc = docs.find((d) => d.id === id);
        if (!doc) return null;
        try {
          const snip = await getDocumentSnippet(id);
          return { doc, snip };
        } catch (err) {
          setSnippetError(
            err instanceof Error
              ? err.message
              : "Failed to fetch a snippet for the newly uploaded doc.",
          );
          return null;
        }
      }),
    ).then((results) => {
      const wins = results.filter(
        (r): r is { doc: DocumentSummary; snip: DocumentSnippet } => !!r,
      );
      if (wins.length === 0) return;
      setValue((prev) => {
        let next = prev;
        for (const r of wins) next = addBlock(next, r.doc, r.snip);
        return next;
      });
    });
  }, [docs, pendingAutoTickIds, setValue]);

  const toggleDoc = useCallback(
    async (doc: DocumentSummary, currentlyChecked: boolean) => {
      setSnippetError(null);
      if (currentlyChecked) {
        setValue((prev) => removeBlock(prev, doc.id));
        return;
      }
      if (doc.status !== "ready") return;
      setFetchingIds((prev) => {
        const next = new Set(prev);
        next.add(doc.id);
        return next;
      });
      try {
        const snip = await getDocumentSnippet(doc.id);
        setValue((prev) => addBlock(prev, doc, snip));
      } catch (err) {
        setSnippetError(
          err instanceof Error
            ? err.message
            : "Failed to fetch doctrine snippet.",
        );
      } finally {
        setFetchingIds((prev) => {
          const next = new Set(prev);
          next.delete(doc.id);
          return next;
        });
      }
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
                const isFetching = fetchingIds.has(doc.id);
                const disabled = (!isReady && !checked) || isFetching;
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
                      onChange={() => void toggleDoc(doc, checked)}
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
                        {isFetching && (
                          <span className="text-primary">loading…</span>
                        )}
                      </div>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}

          {snippetError && <ErrorBox>{snippetError}</ErrorBox>}

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
