import { Link, useLocation } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import {
  useListMySubmissions,
  useWithdrawMySubmission,
  getListMySubmissionsQueryKey,
  getAdminListSubmissionsQueryKey,
  getListToolsQueryKey,
} from "@workspace/api-client-react";
import type { SubmissionSummary } from "@workspace/api-client-react";
import { PageContainer, Pill, EmptyState, ErrorBox } from "@/lib/format";

function statusTone(
  s: string,
): "good" | "info" | "warn" | "neutral" | "destructive" {
  if (s === "approved") return "good";
  if (s === "pending") return "info";
  if (s === "changes_requested") return "warn";
  if (s === "rejected") return "destructive";
  return "neutral";
}

function statusLabel(s: string): string {
  if (s === "changes_requested") return "Changes requested";
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export function MySubmissions() {
  const [, setLocation] = useLocation();
  const queryClient = useQueryClient();
  const { data, isLoading, error } = useListMySubmissions();
  const withdraw = useWithdrawMySubmission();

  const onWithdraw = async (s: SubmissionSummary) => {
    if (
      !confirm(
        `Withdraw "${s.name}"? It will no longer be visible to admin reviewers.`,
      )
    )
      return;
    await withdraw.mutateAsync({ id: s.id });
    queryClient.invalidateQueries({
      queryKey: getListMySubmissionsQueryKey(),
    });
    queryClient.invalidateQueries({
      queryKey: getAdminListSubmissionsQueryKey(),
    });
    queryClient.invalidateQueries({ queryKey: getListToolsQueryKey() });
  };

  return (
    <PageContainer>
      <div className="mb-8 flex items-end justify-between gap-6">
        <div>
          <div className="text-[10px] uppercase tracking-[0.25em] text-primary font-mono font-semibold mb-2">
            Vendor · My submissions
          </div>
          <h1 className="text-3xl font-semibold tracking-tight">
            My tool submissions
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            Track tools you've submitted to the platform and address any
            reviewer feedback.
          </p>
        </div>
        <button
          onClick={() => setLocation("/submissions/new")}
          className="h-10 px-5 rounded-md bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90"
        >
          Submit a tool
        </button>
      </div>

      {error && <ErrorBox>{(error as Error).message}</ErrorBox>}

      {isLoading ? (
        <div className="space-y-2">
          {Array.from({ length: 3 }).map((_, i) => (
            <div
              key={i}
              className="bg-card border border-border rounded-md h-20 animate-pulse"
            />
          ))}
        </div>
      ) : !data || data.length === 0 ? (
        <EmptyState
          title="You haven't submitted any tools yet"
          description="Submit a tool to be reviewed by a platform admin. Approved tools appear in the public catalog."
        />
      ) : (
        <div className="space-y-3">
          {data.map((s) => (
            <SubmissionCard
              key={s.id}
              s={s}
              onWithdraw={() => onWithdraw(s)}
              withdrawing={withdraw.isPending}
            />
          ))}
        </div>
      )}
    </PageContainer>
  );
}

function SubmissionCard({
  s,
  onWithdraw,
  withdrawing,
}: {
  s: SubmissionSummary;
  onWithdraw: () => void;
  withdrawing: boolean;
}) {
  const editable =
    s.submissionStatus === "pending" ||
    s.submissionStatus === "changes_requested";
  const showReason =
    (s.submissionStatus === "changes_requested" ||
      s.submissionStatus === "rejected") &&
    s.reviewComment;

  return (
    <div className="bg-card border border-border rounded-md p-5">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 mb-1">
            <Pill tone={statusTone(s.submissionStatus)}>
              {statusLabel(s.submissionStatus)}
            </Pill>
            <span className="text-[10px] font-mono uppercase tracking-wider text-muted-foreground">
              {s.vendor}
            </span>
          </div>
          <div className="text-base font-semibold">{s.name}</div>
          <p className="text-sm text-muted-foreground mt-1 line-clamp-2">
            {s.shortDescription}
          </p>
          <div className="text-[11px] font-mono text-muted-foreground mt-2">
            Last update {new Date(s.updatedAt).toLocaleString()}
            {s.submittedAt && (
              <>
                {" "}
                · Submitted {new Date(s.submittedAt).toLocaleDateString()}
              </>
            )}
          </div>
        </div>
        <div className="flex flex-col items-end gap-2 shrink-0">
          {s.submissionStatus === "approved" && (
            <Link
              href={`/catalog/${s.slug}`}
              className="text-xs text-primary hover:underline font-mono uppercase tracking-wider"
            >
              View in catalog →
            </Link>
          )}
          {editable && (
            <div className="flex gap-3">
              <Link
                href={`/submissions/${s.id}/edit`}
                className="text-xs text-primary hover:underline font-mono uppercase tracking-wider"
              >
                Edit
              </Link>
              <button
                onClick={onWithdraw}
                disabled={withdrawing}
                className="text-xs text-rose-400 hover:text-rose-300 font-mono uppercase tracking-wider disabled:opacity-50"
              >
                Withdraw
              </button>
            </div>
          )}
        </div>
      </div>
      {showReason && (
        <div
          className={`mt-4 rounded border p-3 text-xs whitespace-pre-wrap ${
            s.submissionStatus === "rejected"
              ? "border-rose-500/40 bg-rose-500/5 text-rose-200"
              : "border-amber-500/40 bg-amber-500/5 text-amber-100"
          }`}
        >
          <div className="font-mono uppercase tracking-wider text-[10px] mb-1 opacity-80">
            {s.submissionStatus === "rejected"
              ? "Rejection reason"
              : "Reviewer feedback"}
          </div>
          {s.reviewComment}
        </div>
      )}
    </div>
  );
}
