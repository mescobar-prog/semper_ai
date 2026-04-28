import { useEffect, useMemo, useState } from "react";
import { Link } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import {
  useGetMyProfile,
  useEvaluateContextBlock,
  useConfirmContextBlock,
  getGetMyProfileQueryKey,
} from "@workspace/api-client-react";
import type {
  ContextBlockEvaluation,
  ContextBlockFields,
  ContextBlockState,
} from "@workspace/api-client-react";
import { PageContainer, ErrorBox, Pill } from "@/lib/format";

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
          Tools may not be launched until the Semantic NLP Evaluator scores
          your Context Block at <span className="font-mono">10/12</span> or
          higher and confirms no OPSEC violations. The confirmed block ships
          with every tool launch.
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
                <label className="block">
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
                  <textarea
                    value={value}
                    onChange={(e) =>
                      setFields((prev) => ({
                        ...prev,
                        [el.key]: e.target.value,
                      }))
                    }
                    rows={4}
                    placeholder="Enter operational detail…"
                    className="w-full px-3 py-2 rounded-md bg-background border border-border text-sm focus:border-primary focus:outline-none font-mono"
                  />
                </label>
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
