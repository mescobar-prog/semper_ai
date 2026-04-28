import { useEffect, useRef, useState } from "react";
import { useLocation } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import {
  useGetMyProfile,
  useAdminListTools,
  useCreateTool,
  useUpdateTool,
  useDeleteTool,
  useListCategories,
  useAdminListSubmissions,
  useReviewSubmission,
  useAdminListReviews,
  useAdminHideReview,
  useAdminUnhideReview,
  useAdminListGithubRepos,
  useAdminListContextBlockConfirmations,
  useDraftToolText,
  useSyncToolFromGithub,
  useInitInstallerUpload,
  useCompleteInstallerUpload,
  useAbortInstallerUpload,
  adminGetGithubRepoMetadata,
  getAdminListToolsQueryKey,
  getListToolsQueryKey,
  getAdminListGithubReposQueryKey,
  getAdminListSubmissionsQueryKey,
  getListMySubmissionsQueryKey,
  getAdminListReviewsQueryKey,
} from "@workspace/api-client-react";
import type {
  ToolUpsert,
  ToolDetail,
  SubmissionDetail,
  AdminToolReview,
  AdminContextBlockConfirmation,
  GithubRepoMetadata,
  GithubRepoSummary,
} from "@workspace/api-client-react";
import {
  PageContainer,
  ErrorBox,
  Pill,
  atoLabel,
  atoTone,
  EmptyState,
  StarBar,
  relativeTime,
} from "@/lib/format";

const IMPACT_LEVELS = ["IL2", "IL4", "IL5", "IL6"];
const ATO_STATUSES = [
  { value: "full_ato", label: "Full ATO" },
  { value: "ipa", label: "Interim Authority" },
  { value: "in_review", label: "In ATO Review" },
];
const DATA_CLASS = ["Unclassified", "CUI", "FOUO", "Secret"];

const EMPTY_TOOL: ToolUpsert = {
  slug: "",
  name: "",
  vendor: "",
  shortDescription: "",
  longDescription: "",
  purpose: "",
  ragQueryTemplates: [],
  categoryId: null,
  atoStatus: "in_review",
  impactLevels: [],
  dataClassification: "Unclassified",
  version: null,
  badges: [],
  homepageUrl: null,
  launchUrl: "/context-echo/",
  documentationUrl: null,
  logoUrl: null,
  isActive: true,
  hostingType: "cloud",
  installerUrl: null,
  installerObjectKey: null,
  installerFilename: null,
  installerSizeBytes: null,
  installerPlatform: null,
  installInstructions: null,
  localLaunchUrlPattern: null,
  gitRepoOwner: null,
  gitRepoName: null,
  gitDefaultBranch: null,
  gitLatestReleaseTag: null,
  gitLatestCommitSha: null,
  gitLicenseSpdx: null,
  gitStars: null,
};

export function Admin() {
  const { data: profileEnvelope, isLoading: profileLoading } =
    useGetMyProfile();
  const [, setLocation] = useLocation();
  const isAdmin = profileEnvelope?.profile.isAdmin === true;
  const viewMode = profileEnvelope?.profile.viewMode === "operator"
    ? "operator"
    : "admin";
  // An admin who has chosen Operator view should not see admin pages
  // even if they URL-type their way here. Bounce them to the dashboard
  // — they can flip back via the header switch whenever they like.
  const inOperatorView = isAdmin && viewMode === "operator";

  useEffect(() => {
    if (inOperatorView) {
      setLocation("/dashboard");
    }
  }, [inOperatorView, setLocation]);

  if (profileLoading) {
    return (
      <PageContainer>
        <div className="text-muted-foreground font-mono text-xs uppercase tracking-widest">
          Verifying credentials…
        </div>
      </PageContainer>
    );
  }

  if (inOperatorView) {
    return (
      <PageContainer>
        <EmptyState
          title="Operator view is on"
          description="You're an administrator, but Operator view hides admin pages. Use the Admin/Operator switch in the top-right header to return to Admin view."
        />
      </PageContainer>
    );
  }

  if (!isAdmin) {
    return (
      <PageContainer>
        <EmptyState
          title="Admin access required"
          description="This area is restricted to marketplace administrators. If you believe this is in error, contact your tenant admin."
        />
      </PageContainer>
    );
  }

  return <AdminInner />;
}

type AdminTab = "catalog" | "review" | "reviews" | "confirmations";

function AdminInner() {
  const [tab, setTab] = useState<AdminTab>("review");
  return (
    <PageContainer>
      <div className="mb-6">
        <div className="text-[10px] uppercase tracking-[0.25em] text-primary font-mono font-semibold mb-2">
          Admin
        </div>
        <h1 className="text-3xl font-semibold tracking-tight">
          Marketplace administration
        </h1>
        <p className="text-sm text-muted-foreground mt-1">
          Review vendor submissions, manage the published catalog, moderate
          user reviews, and audit Context Block confirmations.
        </p>
      </div>
      <div className="border-b border-border mb-6 flex gap-6 flex-wrap">
        <TabBtn active={tab === "review"} onClick={() => setTab("review")}>
          Submission queue
        </TabBtn>
        <TabBtn active={tab === "catalog"} onClick={() => setTab("catalog")}>
          Catalog management
        </TabBtn>
        <TabBtn active={tab === "reviews"} onClick={() => setTab("reviews")}>
          Review moderation
        </TabBtn>
        <TabBtn
          active={tab === "confirmations"}
          onClick={() => setTab("confirmations")}
        >
          Context Block audit
        </TabBtn>
      </div>
      {tab === "review" ? (
        <ReviewQueue />
      ) : tab === "catalog" ? (
        <CatalogManagement />
      ) : tab === "reviews" ? (
        <ReviewModerationSection />
      ) : (
        <ContextBlockAudit />
      )}
    </PageContainer>
  );
}

function TabBtn({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className={`pb-3 -mb-[1px] text-sm font-medium border-b-2 transition-colors ${
        active
          ? "border-primary text-primary"
          : "border-transparent text-muted-foreground hover:text-foreground"
      }`}
    >
      {children}
    </button>
  );
}

function ReviewQueue() {
  const queryClient = useQueryClient();
  const [statusFilter, setStatusFilter] = useState<string>("queue");
  const { data, isLoading, error } = useAdminListSubmissions();
  const review = useReviewSubmission();
  const [selected, setSelected] = useState<SubmissionDetail | null>(null);
  const [action, setAction] = useState<
    "approve" | "request_changes" | "reject" | null
  >(null);
  const [comment, setComment] = useState("");
  const [actionError, setActionError] = useState<string | null>(null);

  const filtered = (data ?? []).filter((s) => {
    if (statusFilter === "queue") {
      return (
        s.submissionStatus === "pending" ||
        s.submissionStatus === "changes_requested"
      );
    }
    if (statusFilter === "all") return true;
    return s.submissionStatus === statusFilter;
  });

  const closeAction = () => {
    setAction(null);
    setComment("");
    setActionError(null);
  };

  const submitReview = async () => {
    if (!selected || !action) return;
    if ((action === "request_changes" || action === "reject") && !comment.trim()) {
      setActionError("A comment is required for this action.");
      return;
    }
    setActionError(null);
    try {
      await review.mutateAsync({
        id: selected.id,
        data: {
          action,
          comment: comment.trim() || null,
        },
      });
      queryClient.invalidateQueries({
        queryKey: getAdminListSubmissionsQueryKey(),
      });
      queryClient.invalidateQueries({
        queryKey: getListMySubmissionsQueryKey(),
      });
      queryClient.invalidateQueries({ queryKey: getAdminListToolsQueryKey() });
      queryClient.invalidateQueries({ queryKey: getListToolsQueryKey() });
      closeAction();
      setSelected(null);
    } catch (err) {
      setActionError(
        err instanceof Error ? err.message : "Review action failed",
      );
    }
  };

  return (
    <>
      <div className="flex items-center justify-between mb-4">
        <div className="text-sm text-muted-foreground">
          {filtered.length} submission{filtered.length === 1 ? "" : "s"}{" "}
          {statusFilter === "queue" ? "awaiting review" : `(${statusFilter})`}
        </div>
        <select
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value)}
          className="px-3 py-1.5 rounded-md bg-background border border-border text-sm"
        >
          <option value="queue">Open queue (pending + changes requested)</option>
          <option value="pending">Pending only</option>
          <option value="changes_requested">Changes requested</option>
          <option value="approved">Approved</option>
          <option value="rejected">Rejected</option>
          <option value="withdrawn">Withdrawn</option>
          <option value="all">All</option>
        </select>
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
      ) : filtered.length === 0 ? (
        <EmptyState
          title="No submissions in this view"
          description="Vendor submissions will appear here when they need review."
        />
      ) : (
        <div className="space-y-3">
          {filtered.map((s) => (
            <button
              key={s.id}
              onClick={() => setSelected(s)}
              className={`w-full text-left bg-card border rounded-md p-4 hover:border-primary/50 transition-colors ${
                selected?.id === s.id
                  ? "border-primary"
                  : "border-border"
              }`}
            >
              <div className="flex items-center gap-2 mb-1">
                <Pill tone={submissionTone(s.submissionStatus)}>
                  {submissionLabel(s.submissionStatus)}
                </Pill>
                <span className="text-[10px] font-mono uppercase tracking-wider text-muted-foreground">
                  {s.vendor}
                </span>
                {s.submitterDisplayName && (
                  <span className="text-[10px] font-mono text-muted-foreground">
                    · by {s.submitterDisplayName}
                  </span>
                )}
              </div>
              <div className="font-semibold">{s.name}</div>
              <p className="text-xs text-muted-foreground mt-1 line-clamp-1">
                {s.shortDescription}
              </p>
              <div className="text-[11px] font-mono text-muted-foreground mt-2">
                {s.submittedAt &&
                  `Submitted ${new Date(s.submittedAt).toLocaleString()}`}
              </div>
            </button>
          ))}
        </div>
      )}

      {selected && (
        <SubmissionDetailPanel
          submission={selected}
          onClose={() => {
            setSelected(null);
            closeAction();
          }}
          onAction={(a) => {
            setAction(a);
            setComment("");
            setActionError(null);
          }}
          action={action}
          comment={comment}
          setComment={setComment}
          actionError={actionError}
          submitting={review.isPending}
          onSubmitReview={submitReview}
          onCancelAction={closeAction}
        />
      )}
    </>
  );
}

function submissionTone(
  s: string,
): "good" | "info" | "warn" | "neutral" | "destructive" {
  if (s === "approved") return "good";
  if (s === "pending") return "info";
  if (s === "changes_requested") return "warn";
  if (s === "rejected") return "destructive";
  return "neutral";
}

function submissionLabel(s: string): string {
  if (s === "changes_requested") return "Changes requested";
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function SubmissionDetailPanel({
  submission,
  onClose,
  onAction,
  action,
  comment,
  setComment,
  actionError,
  submitting,
  onSubmitReview,
  onCancelAction,
}: {
  submission: SubmissionDetail;
  onClose: () => void;
  onAction: (a: "approve" | "request_changes" | "reject") => void;
  action: "approve" | "request_changes" | "reject" | null;
  comment: string;
  setComment: (s: string) => void;
  actionError: string | null;
  submitting: boolean;
  onSubmitReview: () => void;
  onCancelAction: () => void;
}) {
  const lockedFromActions =
    submission.submissionStatus === "approved" ||
    submission.submissionStatus === "rejected" ||
    submission.submissionStatus === "withdrawn";

  return (
    <div className="fixed inset-0 z-50 flex items-stretch justify-end bg-black/50">
      <div className="w-full max-w-2xl bg-card border-l border-border overflow-y-auto">
        <div className="sticky top-0 bg-card border-b border-border px-6 py-4 flex items-center justify-between">
          <div className="min-w-0">
            <div className="text-[10px] uppercase tracking-wider font-mono text-muted-foreground">
              Submission · {submission.vendor}
            </div>
            <div className="text-lg font-semibold truncate">
              {submission.name}
            </div>
          </div>
          <button
            onClick={onClose}
            className="text-sm text-muted-foreground hover:text-foreground px-2"
          >
            Close
          </button>
        </div>
        <div className="p-6 space-y-6">
          <div className="flex flex-wrap gap-1.5">
            <Pill tone={submissionTone(submission.submissionStatus)}>
              {submissionLabel(submission.submissionStatus)}
            </Pill>
            <Pill tone={atoTone(submission.atoStatus)}>
              {atoLabel(submission.atoStatus)}
            </Pill>
            {submission.impactLevels.map((il) => (
              <Pill key={il}>{il}</Pill>
            ))}
            <Pill tone="neutral">{submission.dataClassification}</Pill>
          </div>
          <DetailRow label="Submitter">
            {submission.submitterDisplayName ?? "Unknown"}
          </DetailRow>
          {submission.contactEmail && (
            <DetailRow label="Contact">{submission.contactEmail}</DetailRow>
          )}
          <DetailRow label="Category">
            {submission.categoryName ?? "—"}
          </DetailRow>
          <DetailRow label="Slug">{submission.slug}</DetailRow>
          <DetailRow label="Launch URL">
            <a
              href={submission.launchUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="text-primary hover:underline break-all"
            >
              {submission.launchUrl}
            </a>
          </DetailRow>
          {submission.homepageUrl && (
            <DetailRow label="Homepage">
              <a
                href={submission.homepageUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="text-primary hover:underline break-all"
              >
                {submission.homepageUrl}
              </a>
            </DetailRow>
          )}
          {submission.documentationUrl && (
            <DetailRow label="Docs">
              <a
                href={submission.documentationUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="text-primary hover:underline break-all"
              >
                {submission.documentationUrl}
              </a>
            </DetailRow>
          )}
          <DetailRow label="Short description">
            {submission.shortDescription}
          </DetailRow>
          <DetailRow label="Long description">
            <div className="whitespace-pre-wrap text-sm leading-relaxed">
              {submission.longDescription}
            </div>
          </DetailRow>
          {submission.reviewComment && (
            <div className="rounded border border-border bg-background/50 p-3">
              <div className="text-[10px] uppercase tracking-wider font-mono text-muted-foreground mb-1">
                Last reviewer comment
              </div>
              <div className="text-sm whitespace-pre-wrap">
                {submission.reviewComment}
              </div>
            </div>
          )}

          {lockedFromActions ? (
            <div className="text-xs text-muted-foreground font-mono">
              This submission is locked (status:{" "}
              <span className="text-foreground">
                {submission.submissionStatus}
              </span>
              ) and no further review actions are available.
            </div>
          ) : action ? (
            <div className="border border-primary/40 rounded-md p-4 space-y-3 bg-background/50">
              <div className="text-[10px] uppercase tracking-wider font-mono text-primary font-semibold">
                {action === "approve"
                  ? "Approve and publish"
                  : action === "request_changes"
                    ? "Request changes"
                    : "Reject submission"}
              </div>
              <textarea
                rows={4}
                value={comment}
                onChange={(e) => setComment(e.target.value)}
                placeholder={
                  action === "approve"
                    ? "Optional note for the submitter"
                    : "Explain what needs to change (required)"
                }
                className="w-full px-3 py-2 rounded-md bg-background border border-border text-sm"
              />
              {actionError && <ErrorBox>{actionError}</ErrorBox>}
              <div className="flex justify-end gap-2">
                <button
                  onClick={onCancelAction}
                  className="h-9 px-3 rounded-md border border-border text-sm hover:bg-accent"
                >
                  Cancel
                </button>
                <button
                  onClick={onSubmitReview}
                  disabled={submitting}
                  className={`h-9 px-4 rounded-md text-sm font-medium disabled:opacity-50 ${
                    action === "reject"
                      ? "bg-rose-500 text-white hover:bg-rose-600"
                      : action === "request_changes"
                        ? "bg-amber-500 text-black hover:bg-amber-600"
                        : "bg-primary text-primary-foreground hover:bg-primary/90"
                  }`}
                >
                  {submitting
                    ? "Saving…"
                    : action === "approve"
                      ? "Approve & publish"
                      : action === "request_changes"
                        ? "Send back for changes"
                        : "Reject"}
                </button>
              </div>
            </div>
          ) : (
            <div className="flex flex-wrap justify-end gap-2 pt-2 border-t border-border">
              <button
                onClick={() => onAction("reject")}
                className="h-9 px-4 rounded-md border border-rose-500/50 text-rose-300 text-sm hover:bg-rose-500/10"
              >
                Reject
              </button>
              <button
                onClick={() => onAction("request_changes")}
                className="h-9 px-4 rounded-md border border-amber-500/50 text-amber-300 text-sm hover:bg-amber-500/10"
              >
                Request changes
              </button>
              <button
                onClick={() => onAction("approve")}
                className="h-9 px-4 rounded-md bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90"
              >
                Approve & publish
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function DetailRow({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wider font-mono text-muted-foreground mb-1">
        {label}
      </div>
      <div className="text-sm">{children}</div>
    </div>
  );
}

function CatalogManagement() {
  const queryClient = useQueryClient();
  const { data: tools, isLoading, error } = useAdminListTools();
  const { data: categories } = useListCategories();
  const createMutation = useCreateTool();
  const updateMutation = useUpdateTool();
  const deleteMutation = useDeleteTool();

  const [editing, setEditing] = useState<
    | { mode: "create"; data: ToolUpsert }
    | { mode: "edit"; id: string; data: ToolUpsert }
    | null
  >(null);
  const [formError, setFormError] = useState<string | null>(null);

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: getAdminListToolsQueryKey() });
    queryClient.invalidateQueries({ queryKey: getListToolsQueryKey() });
  };

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editing) return;
    setFormError(null);
    try {
      if (editing.mode === "create") {
        await createMutation.mutateAsync({ data: editing.data });
      } else {
        await updateMutation.mutateAsync({
          id: editing.id,
          data: editing.data,
        });
      }
      setEditing(null);
      invalidate();
    } catch (err) {
      setFormError(err instanceof Error ? err.message : "Save failed");
    }
  };

  const onDelete = async (id: string) => {
    if (!confirm("Delete this tool? This cannot be undone.")) return;
    await deleteMutation.mutateAsync({ id });
    invalidate();
  };

  const startEdit = (t: ToolDetail) => {
    setEditing({
      mode: "edit",
      id: t.id,
      data: {
        slug: t.slug,
        name: t.name,
        vendor: t.vendor,
        shortDescription: t.shortDescription,
        longDescription: t.longDescription,
        purpose: t.purpose ?? "",
        ragQueryTemplates: t.ragQueryTemplates ?? [],
        categoryId: t.categoryId,
        atoStatus: t.atoStatus,
        impactLevels: t.impactLevels,
        dataClassification: t.dataClassification,
        version: t.version,
        badges: t.badges,
        homepageUrl: t.homepageUrl,
        launchUrl: t.launchUrl,
        documentationUrl: t.documentationUrl,
        logoUrl: t.logoUrl,
        isActive: t.isActive,
        hostingType: t.hostingType ?? "cloud",
        installerUrl: t.installerUrl,
        installerObjectKey: t.installerObjectKey,
        installerFilename: t.installerFilename,
        installerSizeBytes: t.installerSizeBytes,
        installerPlatform: t.installerPlatform,
        installInstructions: t.installInstructions,
        localLaunchUrlPattern: t.localLaunchUrlPattern,
        gitRepoOwner: t.gitRepoOwner,
        gitRepoName: t.gitRepoName,
        gitDefaultBranch: t.gitDefaultBranch,
        gitLatestReleaseTag: t.gitLatestReleaseTag,
        gitLatestCommitSha: t.gitLatestCommitSha,
        gitLicenseSpdx: t.gitLicenseSpdx,
        gitStars: t.gitStars,
      },
    });
  };

  return (
    <>
      <div className="mb-6 flex items-end justify-between gap-6">
        <p className="text-sm text-muted-foreground">
          Create, update, and deactivate tools in the published catalog. Vendor
          submissions appear here only after approval.
        </p>
        <button
          onClick={() => setEditing({ mode: "create", data: EMPTY_TOOL })}
          className="h-10 px-5 rounded-md bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90"
        >
          Add tool
        </button>
      </div>

      {error && <ErrorBox>{(error as Error).message}</ErrorBox>}

      {editing && (
        <ToolForm
          data={editing.data}
          mode={editing.mode}
          editingId={editing.mode === "edit" ? editing.id : null}
          categories={categories ?? []}
          onChange={(data) =>
            setEditing(editing ? { ...editing, data } : null)
          }
          onCancel={() => {
            setEditing(null);
            setFormError(null);
          }}
          onSubmit={onSubmit}
          submitting={createMutation.isPending || updateMutation.isPending}
          formError={formError}
          onSynced={(t) => {
            // After a GitHub re-sync the server returns the canonical tool;
            // hydrate the form so admin sees the refreshed metadata before
            // saving (saving is still required to round-trip everything).
            setEditing({
              mode: "edit",
              id: t.id,
              data: {
                ...editing.data,
                gitDefaultBranch: t.gitDefaultBranch,
                gitLatestReleaseTag: t.gitLatestReleaseTag,
                gitLatestCommitSha: t.gitLatestCommitSha,
                gitLicenseSpdx: t.gitLicenseSpdx,
                gitStars: t.gitStars,
                homepageUrl: t.homepageUrl,
              },
            });
            invalidate();
          }}
        />
      )}

      {isLoading ? (
        <div className="space-y-2 mt-6">
          {Array.from({ length: 3 }).map((_, i) => (
            <div
              key={i}
              className="bg-card border border-border rounded-md h-16 animate-pulse"
            />
          ))}
        </div>
      ) : (
        <div className="bg-card border border-border rounded-md overflow-hidden mt-6">
          <table className="w-full text-sm">
            <thead className="bg-background/50 border-b border-border">
              <tr>
                <th className="text-left px-5 py-3 text-[10px] font-mono uppercase tracking-wider text-muted-foreground font-medium">
                  Tool
                </th>
                <th className="text-left px-5 py-3 text-[10px] font-mono uppercase tracking-wider text-muted-foreground font-medium">
                  ATO
                </th>
                <th className="text-left px-5 py-3 text-[10px] font-mono uppercase tracking-wider text-muted-foreground font-medium">
                  Impact
                </th>
                <th className="text-left px-5 py-3 text-[10px] font-mono uppercase tracking-wider text-muted-foreground font-medium">
                  Active
                </th>
                <th className="px-5 py-3"></th>
              </tr>
            </thead>
            <tbody>
              {tools?.map((t) => (
                <tr
                  key={t.id}
                  className="border-b border-border last:border-b-0"
                >
                  <td className="px-5 py-3">
                    <div className="font-medium">{t.name}</div>
                    <div className="text-[11px] text-muted-foreground font-mono">
                      {t.vendor} · {t.slug}
                    </div>
                  </td>
                  <td className="px-5 py-3">
                    <Pill tone={atoTone(t.atoStatus)}>
                      {atoLabel(t.atoStatus)}
                    </Pill>
                  </td>
                  <td className="px-5 py-3">
                    <div className="flex gap-1 flex-wrap">
                      {t.impactLevels.map((il) => (
                        <Pill key={il}>{il}</Pill>
                      ))}
                    </div>
                  </td>
                  <td className="px-5 py-3">
                    <Pill tone={t.isActive ? "good" : "neutral"}>
                      {t.isActive ? "active" : "inactive"}
                    </Pill>
                  </td>
                  <td className="px-5 py-3 text-right space-x-3">
                    <button
                      onClick={() => startEdit(t)}
                      className="text-xs text-primary hover:underline font-mono uppercase tracking-wider"
                    >
                      Edit
                    </button>
                    <button
                      onClick={() => onDelete(t.id)}
                      className="text-xs text-rose-400 hover:text-rose-300 font-mono uppercase tracking-wider"
                    >
                      Delete
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

function ToolForm({
  data,
  mode,
  editingId,
  categories,
  onChange,
  onCancel,
  onSubmit,
  submitting,
  formError,
  onSynced,
}: {
  data: ToolUpsert;
  mode: "create" | "edit";
  editingId: string | null;
  categories: Array<{ id: string; name: string }>;
  onChange: (next: ToolUpsert) => void;
  onCancel: () => void;
  onSubmit: (e: React.FormEvent) => void;
  submitting: boolean;
  formError: string | null;
  onSynced: (tool: ToolDetail) => void;
}) {
  const set = <K extends keyof ToolUpsert>(key: K, value: ToolUpsert[K]) =>
    onChange({ ...data, [key]: value });

  const toggleArr = (key: "impactLevels" | "badges", value: string) => {
    const arr = data[key] || [];
    onChange({
      ...data,
      [key]: arr.includes(value)
        ? arr.filter((v) => v !== value)
        : [...arr, value],
    });
  };

  // README is fetched once when the admin imports a repo and kept in local
  // state (not on the tool record) so it can be reused across the per-field
  // AI drafts without storing the entire markdown blob in the DB.
  const [importedReadme, setImportedReadme] = useState<string | null>(null);

  return (
    <form
      onSubmit={onSubmit}
      className="bg-card border border-primary/30 rounded-md p-5 mb-6 space-y-6"
    >
      <div className="flex items-center justify-between">
        <div className="text-[10px] uppercase tracking-wider text-primary font-mono font-semibold">
          {mode === "create" ? "Add new tool" : "Edit tool"}
        </div>
        <div className="text-[10px] uppercase tracking-wider text-muted-foreground font-mono">
          {data.hostingType === "local_install" ? "Runs locally" : "Cloud-hosted"}
        </div>
      </div>

      {/* ─── Source ────────────────────────────────────────────────────── */}
      <Section title="1. Source" subtitle="Optionally seed the tool from a GitHub repo. Skip to fill in manually.">
        <SourceSection
          data={data}
          onChange={onChange}
          editingId={editingId}
          onReadmeFetched={setImportedReadme}
          onSynced={onSynced}
        />
      </Section>

      {/* ─── Metadata ──────────────────────────────────────────────────── */}
      <Section title="2. Metadata">
        <div className="grid sm:grid-cols-2 gap-3">
          <Field label="Name">
            <input
              required
              value={data.name}
              onChange={(e) => set("name", e.target.value)}
              className={inputCls}
            />
          </Field>
          <Field label="Slug">
            <input
              required
              value={data.slug}
              onChange={(e) => set("slug", e.target.value)}
              placeholder="kebab-case-id"
              className={inputCls}
            />
          </Field>
          <Field label="Vendor">
            <input
              required
              value={data.vendor}
              onChange={(e) => set("vendor", e.target.value)}
              className={inputCls}
            />
          </Field>
          <Field label="Category">
            <select
              value={data.categoryId ?? ""}
              onChange={(e) => set("categoryId", e.target.value || null)}
              className={inputCls}
            >
              <option value="">— uncategorized —</option>
              {categories.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="ATO status">
            <select
              value={data.atoStatus}
              onChange={(e) => set("atoStatus", e.target.value)}
              className={inputCls}
            >
              {ATO_STATUSES.map((s) => (
                <option key={s.value} value={s.value}>
                  {s.label}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Data classification">
            <select
              value={data.dataClassification}
              onChange={(e) => set("dataClassification", e.target.value)}
              className={inputCls}
            >
              {DATA_CLASS.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Version (optional)">
            <input
              value={data.version ?? ""}
              onChange={(e) => set("version", e.target.value || null)}
              className={inputCls}
            />
          </Field>
          <Field label="Homepage URL">
            <input
              value={data.homepageUrl ?? ""}
              onChange={(e) => set("homepageUrl", e.target.value || null)}
              className={inputCls}
            />
          </Field>
          <Field label="Documentation URL">
            <input
              value={data.documentationUrl ?? ""}
              onChange={(e) =>
                set("documentationUrl", e.target.value || null)
              }
              className={inputCls}
            />
          </Field>
          <Field label="Logo URL">
            <input
              value={data.logoUrl ?? ""}
              onChange={(e) => set("logoUrl", e.target.value || null)}
              className={inputCls}
            />
          </Field>
        </div>
        <Field label="Impact levels">
          <div className="flex gap-2 flex-wrap">
            {IMPACT_LEVELS.map((il) => {
              const active = (data.impactLevels || []).includes(il);
              return (
                <button
                  type="button"
                  key={il}
                  onClick={() => toggleArr("impactLevels", il)}
                  className={`px-2 py-1 rounded border text-[11px] font-mono uppercase tracking-wider ${
                    active
                      ? "bg-primary/20 text-primary border-primary/50"
                      : "bg-background text-muted-foreground border-border hover:border-primary/30"
                  }`}
                >
                  {il}
                </button>
              );
            })}
          </div>
        </Field>
        <Field label="Badges (comma-separated)">
          <input
            value={(data.badges || []).join(", ")}
            onChange={(e) =>
              set(
                "badges",
                e.target.value
                  .split(",")
                  .map((s) => s.trim())
                  .filter(Boolean),
              )
            }
            placeholder="GovCloud, FedRAMP High"
            className={inputCls}
          />
        </Field>
        <DescriptionFields
          data={data}
          set={set}
          importedReadme={importedReadme}
        />
      </Section>

      {/* ─── Hosting ───────────────────────────────────────────────────── */}
      <Section
        title="3. Hosting"
        subtitle="How end users actually run this tool."
      >
        <HostingSection data={data} set={set} />
      </Section>

      {/* ─── Context & RAG ─────────────────────────────────────────────── */}
      <Section
        title="4. Context & RAG"
        subtitle="Used to fetch relevant snippets from the operator's personal library at launch."
      >
        <ContextSection
          data={data}
          set={set}
          importedReadme={importedReadme}
        />
      </Section>

      {/* ─── Publish ───────────────────────────────────────────────────── */}
      <Section title="5. Publish">
        <div className="flex items-center gap-2">
          <input
            id="isActive"
            type="checkbox"
            checked={data.isActive}
            onChange={(e) => set("isActive", e.target.checked)}
            className="w-4 h-4 accent-primary"
          />
          <label htmlFor="isActive" className="text-sm">
            Active in catalog (visible to end users)
          </label>
        </div>
      </Section>

      {formError && <ErrorBox>{formError}</ErrorBox>}
      <div className="flex justify-end gap-2 pt-3 border-t border-border">
        <button
          type="button"
          onClick={onCancel}
          className="h-9 px-4 rounded-md border border-border text-sm hover:bg-accent"
        >
          Cancel
        </button>
        <button
          type="submit"
          disabled={submitting}
          className="h-9 px-5 rounded-md bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 disabled:opacity-50"
        >
          {submitting ? "Saving…" : mode === "create" ? "Create" : "Save"}
        </button>
      </div>
    </form>
  );
}

// ─── Section helper ───────────────────────────────────────────────────────
function Section({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="space-y-3 pt-2 first:pt-0 border-t first:border-t-0 border-border">
      <div>
        <div className="text-sm font-semibold tracking-tight">{title}</div>
        {subtitle && (
          <div className="text-[11px] text-muted-foreground mt-0.5">
            {subtitle}
          </div>
        )}
      </div>
      <div className="space-y-3">{children}</div>
    </section>
  );
}

// ─── Source: GitHub picker + manual override ─────────────────────────────
function SourceSection({
  data,
  onChange,
  editingId,
  onReadmeFetched,
  onSynced,
}: {
  data: ToolUpsert;
  onChange: (next: ToolUpsert) => void;
  editingId: string | null;
  onReadmeFetched: (readme: string | null) => void;
  onSynced: (tool: ToolDetail) => void;
}) {
  const [pickerOpen, setPickerOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const reposParams = { search: debouncedSearch || undefined, page: 1 };
  const reposQuery = useAdminListGithubRepos(reposParams, {
    query: {
      enabled: pickerOpen,
      retry: false,
      queryKey: getAdminListGithubReposQueryKey(reposParams),
    },
  });
  const [importing, setImporting] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);
  const syncMutation = useSyncToolFromGithub();
  const [syncError, setSyncError] = useState<string | null>(null);

  // Tiny debounce: search ~ every 350ms after typing stops
  function onSearchChange(v: string) {
    setSearch(v);
    if ((onSearchChange as unknown as { _t?: number })._t) {
      clearTimeout((onSearchChange as unknown as { _t?: number })._t);
    }
    (onSearchChange as unknown as { _t?: number })._t = window.setTimeout(
      () => setDebouncedSearch(v.trim()),
      350,
    );
  }

  async function importRepo(r: GithubRepoSummary) {
    setImporting(true);
    setImportError(null);
    try {
      const meta: GithubRepoMetadata = await adminGetGithubRepoMetadata({
        owner: r.owner,
        repo: r.name,
      });
      onReadmeFetched(meta.readmeMarkdown);
      onChange({
        ...data,
        name: data.name || meta.name,
        vendor: data.vendor || meta.owner,
        slug:
          data.slug ||
          `${meta.owner}-${meta.name}`
            .toLowerCase()
            .replace(/[^a-z0-9-]+/g, "-"),
        shortDescription: data.shortDescription || (meta.description ?? ""),
        homepageUrl: data.homepageUrl ?? meta.homepageUrl ?? null,
        gitRepoOwner: meta.owner,
        gitRepoName: meta.name,
        gitDefaultBranch: meta.defaultBranch,
        gitLatestReleaseTag: meta.latestReleaseTag,
        gitLatestCommitSha: meta.latestCommitSha,
        gitLicenseSpdx: meta.licenseSpdx,
        gitStars: meta.stars,
      });
      setPickerOpen(false);
    } catch (err) {
      setImportError(err instanceof Error ? err.message : "Import failed");
    } finally {
      setImporting(false);
    }
  }

  async function resync() {
    if (!editingId) return;
    setSyncError(null);
    try {
      const updated = (await syncMutation.mutateAsync({
        id: editingId,
      })) as ToolDetail;
      // Refresh the README on demand so AI drafts remain current. Soft-fail:
      // the sync mutation already updated the persisted fields, so a README
      // miss isn't fatal to the round-trip.
      try {
        if (updated.gitRepoOwner && updated.gitRepoName) {
          const meta = await adminGetGithubRepoMetadata({
            owner: updated.gitRepoOwner,
            repo: updated.gitRepoName,
          });
          onReadmeFetched(meta.readmeMarkdown);
        }
      } catch {
        // intentionally suppressed
      }
      onSynced(updated);
    } catch (err) {
      setSyncError(err instanceof Error ? err.message : "Sync failed");
    }
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-2 items-center">
        {!pickerOpen && (
          <button
            type="button"
            onClick={() => setPickerOpen(true)}
            className="h-9 px-4 rounded-md border border-primary/40 text-primary text-sm hover:bg-primary/10"
          >
            {data.gitRepoOwner ? "Switch GitHub repo" : "Import from GitHub"}
          </button>
        )}
        {data.gitRepoOwner && data.gitRepoName && (
          <>
            <a
              href={`https://github.com/${data.gitRepoOwner}/${data.gitRepoName}`}
              target="_blank"
              rel="noreferrer"
              className="text-xs font-mono text-primary hover:underline"
            >
              {data.gitRepoOwner}/{data.gitRepoName}
            </a>
            {data.gitLatestReleaseTag && (
              <span className="text-[10px] text-muted-foreground font-mono">
                release {data.gitLatestReleaseTag}
              </span>
            )}
            {typeof data.gitStars === "number" && (
              <span className="text-[10px] text-muted-foreground font-mono">
                ★ {data.gitStars}
              </span>
            )}
            {editingId && (
              <button
                type="button"
                onClick={resync}
                disabled={syncMutation.isPending}
                className="h-8 px-3 rounded-md border border-border text-xs hover:bg-accent disabled:opacity-50"
              >
                {syncMutation.isPending ? "Re-syncing…" : "Re-sync from GitHub"}
              </button>
            )}
            <button
              type="button"
              onClick={() => {
                onChange({
                  ...data,
                  gitRepoOwner: null,
                  gitRepoName: null,
                  gitDefaultBranch: null,
                  gitLatestReleaseTag: null,
                  gitLatestCommitSha: null,
                  gitLicenseSpdx: null,
                  gitStars: null,
                });
                onReadmeFetched(null);
              }}
              className="h-8 px-3 rounded-md border border-border text-xs text-rose-400 hover:bg-accent"
            >
              Unlink
            </button>
          </>
        )}
      </div>
      {syncError && <ErrorBox>{syncError}</ErrorBox>}
      {pickerOpen && (
        <div className="bg-background/40 border border-border rounded-md p-3 space-y-2">
          <div className="flex gap-2 items-center">
            <input
              autoFocus
              type="text"
              placeholder="Search repos…"
              value={search}
              onChange={(e) => onSearchChange(e.target.value)}
              className={inputCls}
            />
            <button
              type="button"
              onClick={() => setPickerOpen(false)}
              className="h-9 px-3 rounded-md border border-border text-xs"
            >
              Close
            </button>
          </div>
          {reposQuery.isLoading && (
            <div className="text-xs text-muted-foreground font-mono">
              Loading repos…
            </div>
          )}
          {reposQuery.error && (
            <ErrorBox>
              {(reposQuery.error as Error).message ||
                "Could not reach GitHub. Is the integration connected?"}
            </ErrorBox>
          )}
          {reposQuery.data && reposQuery.data.length === 0 && (
            <div className="text-xs text-muted-foreground font-mono">
              No repos found.
            </div>
          )}
          {reposQuery.data && reposQuery.data.length > 0 && (
            <ul className="max-h-72 overflow-y-auto divide-y divide-border">
              {reposQuery.data.map((r) => (
                <li
                  key={r.fullName}
                  className="py-2 flex items-center justify-between gap-3"
                >
                  <div className="min-w-0">
                    <div className="text-sm font-mono truncate">
                      {r.fullName}
                      {r.private && (
                        <span className="ml-2 text-[10px] uppercase text-amber-400">
                          private
                        </span>
                      )}
                    </div>
                    {r.description && (
                      <div className="text-[11px] text-muted-foreground truncate">
                        {r.description}
                      </div>
                    )}
                  </div>
                  <button
                    type="button"
                    disabled={importing}
                    onClick={() => importRepo(r)}
                    className="h-8 px-3 rounded-md bg-primary/20 text-primary text-xs hover:bg-primary/30 disabled:opacity-50"
                  >
                    Import
                  </button>
                </li>
              ))}
            </ul>
          )}
          {importError && <ErrorBox>{importError}</ErrorBox>}
        </div>
      )}
    </div>
  );
}

// ─── Description fields with per-field AI draft buttons ──────────────────
function DescriptionFields({
  data,
  set,
  importedReadme,
}: {
  data: ToolUpsert;
  set: <K extends keyof ToolUpsert>(key: K, value: ToolUpsert[K]) => void;
  importedReadme: string | null;
}) {
  const [openField, setOpenField] =
    useState<"shortDescription" | "longDescription" | null>(null);

  const sourceFor = (field: "shortDescription" | "longDescription") => ({
    name: data.name,
    vendor: data.vendor,
    homepageUrl: data.homepageUrl ?? undefined,
    githubReadme: importedReadme ?? undefined,
    existingText: data[field] || undefined,
  });

  return (
    <div className="space-y-3">
      <Field
        label="Short description"
        action={
          <DraftBtn
            busy={openField === "shortDescription"}
            onClick={() => setOpenField("shortDescription")}
          />
        }
      >
        <input
          required
          value={data.shortDescription}
          onChange={(e) => set("shortDescription", e.target.value)}
          className={inputCls}
        />
      </Field>
      <Field
        label="Long description"
        action={
          <DraftBtn
            busy={openField === "longDescription"}
            onClick={() => setOpenField("longDescription")}
          />
        }
      >
        <textarea
          required
          rows={4}
          value={data.longDescription}
          onChange={(e) => set("longDescription", e.target.value)}
          className={`${inputCls} font-mono`}
        />
      </Field>
      {openField && (
        <DraftPreviewDrawer
          field={openField}
          kind="text"
          fieldLabel={
            openField === "shortDescription"
              ? "Short description"
              : "Long description"
          }
          currentText={data[openField] ?? ""}
          sourceMaterial={sourceFor(openField)}
          onAccept={(text) => {
            set(openField, text);
            setOpenField(null);
          }}
          onAppend={(text) => {
            const existing = data[openField] ?? "";
            const joined = existing.trim()
              ? `${existing.trim()}\n\n${text}`
              : text;
            set(openField, joined);
            setOpenField(null);
          }}
          onClose={() => setOpenField(null)}
        />
      )}
    </div>
  );
}

// ─── Hosting section: cloud vs local_install ─────────────────────────────
// Maximum allowed installer-binary upload size. Mirrors the server-side
// constant `MAX_INSTALLER_UPLOAD_SIZE_BYTES` in
// artifacts/api-server/src/routes/admin.ts — keep in sync.
const MAX_INSTALLER_UPLOAD_SIZE_BYTES = 500 * 1024 * 1024; // 500 MB
const MAX_INSTALLER_UPLOAD_SIZE_MB = Math.floor(
  MAX_INSTALLER_UPLOAD_SIZE_BYTES / (1024 * 1024),
);

// Stable identifier for the picked file used to look up an in-progress
// upload session on the server. Same shape as the server expects.
function fileFingerprint(file: File): string {
  return `${file.name}|${file.size}|${file.lastModified}`;
}

// Slice the picked file. Returning a Blob lets `fetch` stream the chunk
// without materialising another ArrayBuffer copy.
function sliceFile(file: File, start: number, end: number): Blob {
  return file.slice(start, end);
}

interface ChunkResponse {
  bytesUploaded: number;
  sizeBytes: number;
  complete: boolean;
}

interface OffsetMismatchError {
  expectedOffset: number;
  bytesUploaded: number;
  error?: string;
}

// Push a single chunk to the server. Returns the new bytesUploaded after
// the chunk lands (which may differ from `offset + chunk.length` if the
// server resynced from GCS). Throws on network / non-recoverable errors;
// returns an "offsetMismatch" payload on 409 so the caller can resync.
async function pushInstallerChunk(
  uploadId: string,
  offset: number,
  chunk: Blob,
  signal: AbortSignal,
): Promise<
  | { kind: "ok"; data: ChunkResponse }
  | { kind: "offsetMismatch"; data: OffsetMismatchError }
> {
  const url = `/api/admin/tools/installer-upload/${encodeURIComponent(
    uploadId,
  )}/chunk?offset=${offset}`;
  const response = await fetch(url, {
    method: "PUT",
    body: chunk,
    headers: { "Content-Type": "application/octet-stream" },
    credentials: "include",
    signal,
  });
  if (response.status === 409) {
    const data = (await response.json().catch(() => ({}))) as
      | OffsetMismatchError
      | Record<string, unknown>;
    if (typeof (data as OffsetMismatchError).bytesUploaded === "number") {
      return { kind: "offsetMismatch", data: data as OffsetMismatchError };
    }
    throw new Error(
      typeof (data as { error?: string }).error === "string"
        ? (data as { error?: string }).error!
        : `Upload chunk rejected — server reported a conflict.`,
    );
  }
  if (!response.ok) {
    const data = (await response.json().catch(() => ({}))) as {
      error?: string;
    };
    throw new Error(data.error ?? `Upload chunk failed — please retry.`);
  }
  const data = (await response.json()) as ChunkResponse;
  return { kind: "ok", data };
}

function HostingSection({
  data,
  set,
}: {
  data: ToolUpsert;
  set: <K extends keyof ToolUpsert>(key: K, value: ToolUpsert[K]) => void;
}) {
  const isLocal = data.hostingType === "local_install";
  const initMutation = useInitInstallerUpload();
  const completeMutation = useCompleteInstallerUpload();
  const abortMutation = useAbortInstallerUpload();
  const [uploading, setUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [resumed, setResumed] = useState(false);
  const [activeUploadId, setActiveUploadId] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  async function uploadInstaller(file: File) {
    setUploadError(null);
    setResumed(false);

    if (file.size > MAX_INSTALLER_UPLOAD_SIZE_BYTES) {
      setUploadError(
        `File is ${(file.size / 1024 / 1024).toFixed(1)} MB. Maximum is ${MAX_INSTALLER_UPLOAD_SIZE_MB} MB.`,
      );
      return;
    }

    setUploading(true);
    setUploadProgress(0);
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    try {
      const contentType = file.type || "application/octet-stream";
      const session = await initMutation.mutateAsync({
        data: {
          filename: file.name,
          sizeBytes: file.size,
          contentType,
          fileFingerprint: fileFingerprint(file),
        },
      });

      setActiveUploadId(session.uploadId);
      let bytesUploaded = session.bytesUploaded;
      const chunkSize = session.chunkSize;
      const totalSize = session.sizeBytes;
      if (session.resumed && bytesUploaded > 0) {
        setResumed(true);
      }
      setUploadProgress(
        totalSize > 0 ? Math.round((bytesUploaded / totalSize) * 100) : 0,
      );

      // Already complete (a same-fingerprint upload finished previously
      // and the row was returned to us) — go straight to finalize.
      if (bytesUploaded < totalSize) {
        while (bytesUploaded < totalSize) {
          if (ctrl.signal.aborted) throw new DOMException("aborted", "AbortError");
          const end = Math.min(bytesUploaded + chunkSize, totalSize);
          const chunk = sliceFile(file, bytesUploaded, end);
          const result = await pushInstallerChunk(
            session.uploadId,
            bytesUploaded,
            chunk,
            ctrl.signal,
          );
          if (result.kind === "offsetMismatch") {
            // Server is ahead of us — re-sync and continue from the new
            // offset rather than re-sending the same chunk.
            bytesUploaded = result.data.bytesUploaded;
          } else {
            bytesUploaded = result.data.bytesUploaded;
          }
          setUploadProgress(
            totalSize > 0 ? Math.round((bytesUploaded / totalSize) * 100) : 100,
          );
        }
      }

      const finalized = await completeMutation.mutateAsync({
        uploadId: session.uploadId,
      });

      set("installerObjectKey", finalized.objectKey);
      set("installerFilename", finalized.filename);
      set("installerSizeBytes", finalized.sizeBytes);
      setActiveUploadId(null);
      // Surface the installer download URL back to admins via installerUrl
      // only when no external URL was set; the server prefers installerUrl
      // first, so we keep that override path open.
    } catch (err) {
      if ((err as DOMException)?.name === "AbortError") {
        setUploadError("Upload paused — pick the same file again to resume.");
      } else {
        const msg =
          err instanceof Error ? err.message : "Upload failed";
        // Surface the server's 413 message verbatim when present.
        const detail =
          (err as { response?: { data?: { error?: string } } } | null)?.response
            ?.data?.error;
        setUploadError(detail ?? msg);
      }
    } finally {
      setUploading(false);
      abortRef.current = null;
    }
  }

  function cancelUpload() {
    abortRef.current?.abort();
  }

  async function discardUpload() {
    cancelUpload();
    if (activeUploadId) {
      try {
        await abortMutation.mutateAsync({ uploadId: activeUploadId });
      } catch {
        // Best-effort — server-side row is harmless if it lingers.
      }
      setActiveUploadId(null);
    }
    setUploadProgress(0);
    setUploadError(null);
    setResumed(false);
  }

  return (
    <div className="space-y-3">
      <Field label="Hosting type">
        <div className="flex gap-2">
          <HostingPill
            active={!isLocal}
            label="Cloud-hosted"
            onClick={() => set("hostingType", "cloud")}
          />
          <HostingPill
            active={isLocal}
            label="Runs on operator's machine"
            onClick={() => set("hostingType", "local_install")}
          />
        </div>
      </Field>

      {!isLocal && (
        <Field label="Launch URL (token will be appended automatically)">
          <input
            required
            value={data.launchUrl}
            onChange={(e) => set("launchUrl", e.target.value)}
            placeholder="/context-echo/  or  https://tool.example.com/launch"
            className={inputCls}
          />
        </Field>
      )}

      {isLocal && (
        <>
          <Field label="Local launch URL pattern">
            <input
              value={data.localLaunchUrlPattern ?? ""}
              onChange={(e) =>
                set("localLaunchUrlPattern", e.target.value || null)
              }
              placeholder="myapp://launch?token={token}  or  http://127.0.0.1:7777/launch?token={token}"
              className={inputCls}
            />
            <div className="mt-1 text-[10px] font-mono text-muted-foreground">
              {"{token}"} will be substituted with a fresh single-use launch token. Required so the local app can exchange it for the operator's context.
            </div>
          </Field>
          <Field label="Launch URL (fallback shown to admin/QA)">
            <input
              required
              value={data.launchUrl}
              onChange={(e) => set("launchUrl", e.target.value)}
              placeholder="myapp://launch"
              className={inputCls}
            />
          </Field>
          <div className="grid sm:grid-cols-2 gap-3">
            <Field label="Installer platform">
              <select
                value={data.installerPlatform ?? ""}
                onChange={(e) =>
                  set("installerPlatform", e.target.value || null)
                }
                className={inputCls}
              >
                <option value="">— pick a platform —</option>
                <option value="windows">Windows (.exe / .msi)</option>
                <option value="macos">macOS (.dmg / .pkg)</option>
                <option value="linux">Linux (.deb / .AppImage)</option>
                <option value="cross-platform">Cross-platform</option>
              </select>
            </Field>
            <Field label="External installer URL (optional)">
              <input
                value={data.installerUrl ?? ""}
                onChange={(e) => set("installerUrl", e.target.value || null)}
                placeholder="https://releases.example.com/v1.2/installer.dmg"
                className={inputCls}
              />
            </Field>
          </div>
          <Field label="Installer file (uploaded to App Storage)">
            <div className="flex flex-wrap items-center gap-3">
              <input
                type="file"
                disabled={uploading}
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) uploadInstaller(f);
                  e.target.value = "";
                }}
                className="text-xs text-muted-foreground file:mr-3 file:rounded-md file:border-0 file:bg-primary/20 file:text-primary file:px-3 file:py-1.5 file:text-xs file:font-mono file:hover:bg-primary/30 disabled:opacity-60"
              />
              {uploading && (
                <div className="flex items-center gap-2 min-w-[160px]">
                  <div
                    className="relative h-2 w-32 overflow-hidden rounded-full bg-primary/20"
                    role="progressbar"
                    aria-valuenow={uploadProgress}
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-label="Installer upload progress"
                  >
                    <div
                      className="absolute inset-y-0 left-0 bg-primary transition-[width] duration-150 ease-out"
                      style={{ width: `${uploadProgress}%` }}
                    />
                  </div>
                  <span className="text-xs font-mono text-primary tabular-nums">
                    {uploadProgress}%
                  </span>
                  <button
                    type="button"
                    onClick={cancelUpload}
                    className="text-[11px] text-amber-400 hover:underline font-mono"
                  >
                    Pause
                  </button>
                </div>
              )}
              {resumed && uploading && (
                <span className="text-[11px] font-mono text-emerald-400">
                  Resuming from {uploadProgress}%
                </span>
              )}
              {!uploading && activeUploadId && uploadError && (
                <button
                  type="button"
                  onClick={discardUpload}
                  className="text-[11px] text-rose-400 hover:underline font-mono"
                >
                  Discard partial upload
                </button>
              )}
              {data.installerFilename && !uploading && (
                <span className="text-xs font-mono text-muted-foreground">
                  {data.installerFilename}
                  {data.installerSizeBytes
                    ? ` · ${(data.installerSizeBytes / 1024 / 1024).toFixed(1)} MB`
                    : ""}
                </span>
              )}
              {data.installerObjectKey && !uploading && (
                <button
                  type="button"
                  onClick={() => {
                    set("installerObjectKey", null);
                    set("installerFilename", null);
                    set("installerSizeBytes", null);
                  }}
                  className="text-[11px] text-rose-400 hover:underline font-mono"
                >
                  Remove
                </button>
              )}
            </div>
            <div className="mt-1 text-[10px] font-mono text-muted-foreground">
              Maximum {MAX_INSTALLER_UPLOAD_SIZE_MB} MB. Larger installers should be hosted externally and referenced via the URL field above.
            </div>
            {uploadError && (
              <div className="mt-2">
                <ErrorBox>{uploadError}</ErrorBox>
              </div>
            )}
          </Field>
          <Field label="Install instructions (Markdown plain text)">
            <textarea
              rows={4}
              value={data.installInstructions ?? ""}
              onChange={(e) =>
                set("installInstructions", e.target.value || null)
              }
              placeholder={"1. Download the installer\n2. Open it and follow the prompts\n3. Click Open with my context — your browser will hand off the launch token to the desktop app."}
              className={`${inputCls} font-mono`}
            />
          </Field>
        </>
      )}
    </div>
  );
}

function HostingPill({
  active,
  label,
  onClick,
}: {
  active: boolean;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`px-3 py-1.5 rounded border text-xs font-mono uppercase tracking-wider ${
        active
          ? "bg-primary/20 text-primary border-primary/50"
          : "bg-background text-muted-foreground border-border hover:border-primary/30"
      }`}
    >
      {label}
    </button>
  );
}

// ─── Context & RAG section ───────────────────────────────────────────────
function ContextSection({
  data,
  set,
  importedReadme,
}: {
  data: ToolUpsert;
  set: <K extends keyof ToolUpsert>(key: K, value: ToolUpsert[K]) => void;
  importedReadme: string | null;
}) {
  const [openField, setOpenField] =
    useState<"purpose" | "ragQueryTemplates" | null>(null);

  const sourceFor = (field: "purpose" | "ragQueryTemplates") => ({
    name: data.name,
    vendor: data.vendor,
    homepageUrl: data.homepageUrl ?? undefined,
    githubReadme: importedReadme ?? undefined,
    existingText:
      field === "purpose"
        ? data.purpose ?? undefined
        : (data.ragQueryTemplates ?? []).join("\n") || undefined,
  });

  return (
    <div className="space-y-3">
      <Field
        label="Tool purpose (fed to RAG query generator)"
        action={
          <DraftBtn
            busy={openField === "purpose"}
            onClick={() => setOpenField("purpose")}
          />
        }
      >
        <textarea
          rows={3}
          data-testid="textarea-purpose"
          value={data.purpose ?? ""}
          onChange={(e) => set("purpose", e.target.value)}
          placeholder="One sentence on what this tool actually does with the operator's context (e.g. 'Drafts NCOER bullets anchored to the operator's library of past evals and award citations.')."
          className={`${inputCls} font-mono`}
        />
      </Field>
      <Field
        label="RAG query templates (one per line; {curlies} = profile vars)"
        action={
          <DraftBtn
            busy={openField === "ragQueryTemplates"}
            onClick={() => setOpenField("ragQueryTemplates")}
          />
        }
      >
        <textarea
          rows={4}
          data-testid="textarea-rag-templates"
          value={(data.ragQueryTemplates ?? []).join("\n")}
          onChange={(e) =>
            set(
              "ragQueryTemplates",
              e.target.value
                .split("\n")
                .map((s) => s.trim())
                .filter(Boolean),
            )
          }
          placeholder={`{billets} OPORD\n{dutyTitle} commander's intent\n{unit} mission essential task`}
          className={`${inputCls} font-mono`}
        />
        <div className="mt-1.5 text-[10px] font-mono text-muted-foreground leading-relaxed">
          Available vars: {"{dutyTitle} {mosCode} {unit} {branch} {rank} {baseLocation} {command} {billets}"}.
          Templates with vars the operator hasn't filled in are skipped.
        </div>
      </Field>
      {openField === "purpose" && (
        <DraftPreviewDrawer
          field="purpose"
          kind="text"
          fieldLabel="Tool purpose"
          currentText={data.purpose ?? ""}
          sourceMaterial={sourceFor("purpose")}
          onAccept={(text) => {
            set("purpose", text);
            setOpenField(null);
          }}
          onAppend={(text) => {
            const existing = data.purpose ?? "";
            const joined = existing.trim()
              ? `${existing.trim()}\n\n${text}`
              : text;
            set("purpose", joined);
            setOpenField(null);
          }}
          onClose={() => setOpenField(null)}
        />
      )}
      {openField === "ragQueryTemplates" && (
        <DraftPreviewDrawer
          field="ragQueryTemplates"
          kind="list"
          fieldLabel="RAG query templates"
          currentList={data.ragQueryTemplates ?? []}
          sourceMaterial={sourceFor("ragQueryTemplates")}
          onAcceptList={(list) => {
            set("ragQueryTemplates", list);
            setOpenField(null);
          }}
          onAppendList={(list) => {
            const merged = [...(data.ragQueryTemplates ?? []), ...list];
            const seen = new Set<string>();
            const deduped: string[] = [];
            for (const q of merged) {
              const key = q.trim();
              if (!key || seen.has(key)) continue;
              seen.add(key);
              deduped.push(key);
            }
            set("ragQueryTemplates", deduped);
            setOpenField(null);
          }}
          onClose={() => setOpenField(null)}
        />
      )}
    </div>
  );
}

function DraftBtn({ busy, onClick }: { busy: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      data-testid="button-draft"
      className={`text-[10px] font-mono uppercase tracking-wider hover:underline ${
        busy ? "text-primary/70" : "text-primary"
      }`}
    >
      {busy ? "Preview open…" : "Generate with AI"}
    </button>
  );
}

// ─── Shared draft preview drawer ─────────────────────────────────────────
type DraftField =
  | "shortDescription"
  | "longDescription"
  | "purpose"
  | "ragQueryTemplates";

type DraftSourceMaterial = {
  name?: string;
  vendor?: string;
  homepageUrl?: string;
  githubReadme?: string;
  existingText?: string;
};

type DraftPreviewDrawerProps =
  | {
      field: Exclude<DraftField, "ragQueryTemplates">;
      kind: "text";
      fieldLabel: string;
      currentText: string;
      sourceMaterial: DraftSourceMaterial;
      onAccept: (text: string) => void;
      onAppend: (text: string) => void;
      onClose: () => void;
    }
  | {
      field: "ragQueryTemplates";
      kind: "list";
      fieldLabel: string;
      currentList: string[];
      sourceMaterial: DraftSourceMaterial;
      onAcceptList: (list: string[]) => void;
      onAppendList: (list: string[]) => void;
      onClose: () => void;
    };

function DraftPreviewDrawer(props: DraftPreviewDrawerProps) {
  const draftMutation = useDraftToolText();
  const [proposedText, setProposedText] = useState<string | null>(null);
  const [proposedList, setProposedList] = useState<string[] | null>(null);
  const [steering, setSteering] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const lastTriggerRef = useRef<HTMLElement | null>(null);

  // Capture the element that had focus before the drawer opened so we can
  // restore it on close — preserves keyboard flow in the surrounding form.
  useEffect(() => {
    lastTriggerRef.current = document.activeElement as HTMLElement | null;
    return () => {
      const el = lastTriggerRef.current;
      if (el && typeof el.focus === "function") {
        // Defer so the drawer is fully unmounted before refocus.
        setTimeout(() => el.focus(), 0);
      }
    };
  }, []);

  const runDraft = async (steeringNote?: string) => {
    setBusy(true);
    setError(null);
    try {
      const result = await draftMutation.mutateAsync({
        data: {
          field: props.field,
          sourceMaterial: props.sourceMaterial,
          ...(steeringNote && steeringNote.trim()
            ? { steering: steeringNote.trim() }
            : {}),
        },
      });
      if (props.kind === "text") {
        setProposedText(result.text ?? "");
        setProposedList(null);
      } else {
        setProposedList(result.list ?? []);
        setProposedText(null);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Draft failed");
    } finally {
      setBusy(false);
    }
  };

  // Trigger initial draft on mount.
  useEffect(() => {
    void runDraft();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleRegenerate = () => {
    void runDraft(steering);
  };

  const currentDisplay =
    props.kind === "text"
      ? props.currentText
      : (props.currentList ?? []).join("\n");
  const proposedDisplay =
    props.kind === "text"
      ? proposedText ?? ""
      : (proposedList ?? []).join("\n");

  const hasProposal =
    !busy &&
    !error &&
    (props.kind === "text"
      ? proposedText !== null && proposedText.trim().length > 0
      : proposedList !== null && proposedList.length > 0);

  const handleAccept = () => {
    if (props.kind === "text" && proposedText !== null) {
      props.onAccept(proposedText);
    } else if (props.kind === "list" && proposedList !== null) {
      props.onAcceptList(proposedList);
    }
  };

  const handleAppend = () => {
    if (props.kind === "text" && proposedText !== null) {
      props.onAppend(proposedText);
    } else if (props.kind === "list" && proposedList !== null) {
      props.onAppendList(proposedList);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-stretch justify-end bg-black/50"
      onClick={(e) => {
        if (e.target === e.currentTarget) props.onClose();
      }}
    >
      <div
        role="dialog"
        aria-label={`AI draft preview for ${props.fieldLabel}`}
        data-testid="draft-preview-drawer"
        className="w-full max-w-3xl bg-card border-l border-border overflow-y-auto"
      >
        <div className="sticky top-0 bg-card border-b border-border px-6 py-4 flex items-center justify-between">
          <div className="min-w-0">
            <div className="text-[10px] uppercase tracking-wider font-mono text-primary font-semibold">
              AI draft preview
            </div>
            <div className="text-lg font-semibold truncate">
              {props.fieldLabel}
            </div>
          </div>
          <button
            type="button"
            onClick={props.onClose}
            className="text-sm text-muted-foreground hover:text-foreground px-2"
          >
            Close
          </button>
        </div>

        <div className="p-6 space-y-5">
          <div className="grid md:grid-cols-2 gap-4">
            <div>
              <div className="text-[10px] uppercase tracking-wider font-mono text-muted-foreground mb-1.5">
                Current
                {props.kind === "list" && (
                  <span className="ml-2 normal-case tracking-normal text-muted-foreground/70">
                    ({props.currentList?.length ?? 0} entries)
                  </span>
                )}
              </div>
              <div
                data-testid="draft-current"
                className="rounded-md border border-border bg-background/40 p-3 text-sm whitespace-pre-wrap font-mono min-h-[8rem] max-h-72 overflow-y-auto"
              >
                {currentDisplay.trim() ? (
                  currentDisplay
                ) : (
                  <span className="text-muted-foreground italic">
                    (empty)
                  </span>
                )}
              </div>
            </div>
            <div>
              <div className="text-[10px] uppercase tracking-wider font-mono text-primary mb-1.5">
                Drafted
                {props.kind === "list" && proposedList && (
                  <span className="ml-2 normal-case tracking-normal text-muted-foreground/70">
                    ({proposedList.length} entries)
                  </span>
                )}
              </div>
              <div
                data-testid="draft-proposed"
                className="rounded-md border border-primary/40 bg-primary/5 p-3 text-sm whitespace-pre-wrap font-mono min-h-[8rem] max-h-72 overflow-y-auto"
              >
                {busy ? (
                  <span className="text-muted-foreground italic">
                    Drafting…
                  </span>
                ) : error ? (
                  <span className="text-rose-300">Draft failed.</span>
                ) : proposedDisplay.trim() ? (
                  proposedDisplay
                ) : (
                  <span className="text-muted-foreground italic">
                    Model returned no text. Try Regenerate with a steering
                    note.
                  </span>
                )}
              </div>
            </div>
          </div>

          {error && <ErrorBox>{error}</ErrorBox>}

          <div className="rounded-md border border-border bg-background/40 p-3 space-y-2">
            <label className="block text-[10px] uppercase tracking-wider font-mono text-muted-foreground">
              Steering note (optional, used on Regenerate)
            </label>
            <input
              data-testid="input-steering"
              value={steering}
              onChange={(e) => setSteering(e.target.value)}
              placeholder="e.g. shorter, more technical, lead with the operator workflow"
              className={inputCls}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  if (!busy) handleRegenerate();
                }
              }}
            />
            <div className="flex justify-end">
              <button
                type="button"
                onClick={handleRegenerate}
                disabled={busy}
                data-testid="button-regenerate"
                className="h-9 px-4 rounded-md border border-primary/50 text-primary text-sm font-medium hover:bg-primary/10 disabled:opacity-50"
              >
                {busy ? "Regenerating…" : "Regenerate"}
              </button>
            </div>
          </div>

          <div className="flex flex-wrap justify-end gap-2 pt-2 border-t border-border">
            <button
              type="button"
              onClick={props.onClose}
              data-testid="button-discard"
              className="h-9 px-4 rounded-md border border-border text-sm hover:bg-accent"
            >
              Discard
            </button>
            <button
              type="button"
              onClick={handleAppend}
              disabled={!hasProposal}
              data-testid="button-append"
              className="h-9 px-4 rounded-md border border-primary/50 text-primary text-sm font-medium hover:bg-primary/10 disabled:opacity-50"
            >
              Append
            </button>
            <button
              type="button"
              onClick={handleAccept}
              disabled={!hasProposal}
              data-testid="button-accept"
              className="h-9 px-4 rounded-md bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 disabled:opacity-50"
            >
              {props.kind === "text"
                ? "Accept (replace)"
                : "Accept (replace list)"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

const inputCls =
  "w-full px-3 py-2 rounded-md bg-background border border-border text-sm focus:border-primary focus:outline-none";

function Field({
  label,
  action,
  children,
}: {
  label: string;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div>
      <div className="flex items-end justify-between mb-1.5 gap-3">
        <label className="block text-[10px] font-mono uppercase tracking-wider text-muted-foreground">
          {label}
        </label>
        {action}
      </div>
      {children}
    </div>
  );
}
function ReviewModerationSection() {
  const queryClient = useQueryClient();
  const [showHidden, setShowHidden] = useState(false);
  const params = { include_hidden: showHidden, limit: 50, offset: 0 };
  const {
    data,
    isLoading,
    error,
  } = useAdminListReviews(params, {
    query: { queryKey: getAdminListReviewsQueryKey(params) },
  });

  const hideMutation = useAdminHideReview();
  const unhideMutation = useAdminUnhideReview();

  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: ["/admin/reviews"] });
    queryClient.invalidateQueries({ queryKey: getListToolsQueryKey() });
  };

  const onHide = async (r: AdminToolReview) => {
    const reason = prompt("Reason for hiding (optional):") ?? "";
    await hideMutation.mutateAsync({
      reviewId: r.id,
      data: { reason: reason.trim() ? reason.trim() : null },
    });
    refresh();
  };

  const onUnhide = async (r: AdminToolReview) => {
    await unhideMutation.mutateAsync({ reviewId: r.id });
    refresh();
  };

  return (
    <section className="mt-12">
      <div className="flex items-end justify-between gap-4 mb-4">
        <div>
          <div className="text-[10px] uppercase tracking-[0.25em] text-primary font-mono font-semibold mb-2">
            Admin · Reviews
          </div>
          <h2 className="text-2xl font-semibold tracking-tight">
            Review moderation
          </h2>
          <p className="text-sm text-muted-foreground mt-1">
            Hide reviews that violate policy. Hidden reviews stay in the
            database but are excluded from public listings and ratings.
          </p>
        </div>
        <label className="flex items-center gap-2 text-xs font-mono uppercase tracking-wider text-muted-foreground">
          <input
            type="checkbox"
            checked={showHidden}
            onChange={(e) => setShowHidden(e.target.checked)}
          />
          Show hidden
        </label>
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
      ) : !data || data.reviews.length === 0 ? (
        <EmptyState
          title="No reviews"
          description={
            showHidden
              ? "No reviews exist yet, hidden or otherwise."
              : "No visible reviews to moderate right now."
          }
        />
      ) : (
        <div className="space-y-2">
          {data.reviews.map((r) => (
            <div
              key={r.id}
              className={`bg-card border rounded-md p-4 ${r.hiddenAt ? "border-rose-500/30" : "border-border"}`}
            >
              <div className="flex items-start justify-between gap-3 mb-2">
                <div className="min-w-0">
                  <div className="font-medium">
                    {r.toolName}{" "}
                    <span className="text-xs text-muted-foreground font-mono">
                      / {r.toolSlug}
                    </span>
                  </div>
                  <div className="text-[11px] text-muted-foreground font-mono uppercase tracking-wider mt-0.5">
                    {[r.reviewerRank, r.reviewerBranch]
                      .filter(Boolean)
                      .join(" · ") || "Unknown reviewer"}{" "}
                    · {relativeTime(r.updatedAt)}
                  </div>
                  <div className="mt-1">
                    <StarBar value={r.rating} />
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  {r.hiddenAt ? (
                    <>
                      <Pill tone="destructive">hidden</Pill>
                      <button
                        onClick={() => onUnhide(r)}
                        disabled={unhideMutation.isPending}
                        className="h-8 px-3 rounded-md border border-border text-xs font-mono uppercase tracking-wider hover:border-primary/50 disabled:opacity-50"
                      >
                        Unhide
                      </button>
                    </>
                  ) : (
                    <button
                      onClick={() => onHide(r)}
                      disabled={hideMutation.isPending}
                      className="h-8 px-3 rounded-md border border-border text-xs font-mono uppercase tracking-wider text-rose-400 hover:border-rose-500/50 disabled:opacity-50"
                    >
                      Hide
                    </button>
                  )}
                </div>
              </div>
              {r.comment && (
                <p className="text-sm leading-relaxed whitespace-pre-wrap">
                  {r.comment}
                </p>
              )}
              {r.hiddenAt && (
                <div className="mt-2 text-[11px] text-rose-300 font-mono">
                  Hidden {relativeTime(r.hiddenAt)}
                  {r.hiddenReason ? ` · "${r.hiddenReason}"` : ""}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

function ContextBlockAudit() {
  const { data, isLoading, error } = useAdminListContextBlockConfirmations();
  const [showOnly, setShowOnly] = useState<
    "all" | "confirmed" | "unconfirmed" | "opsec" | "nogo" | "bypassed"
  >("all");

  const all = data?.users ?? [];
  const totals = data?.totals;

  const filtered = all.filter((u) => {
    if (showOnly === "confirmed") return u.hasConfirmed;
    if (showOnly === "unconfirmed") return !u.hasConfirmed;
    if (showOnly === "opsec") return u.opsecFlag;
    if (showOnly === "nogo") return u.status === "NO-GO";
    if (showOnly === "bypassed") return u.bypassed;
    return true;
  });

  return (
    <section>
      <div className="flex items-end justify-between gap-4 mb-4">
        <div>
          <div className="text-[10px] uppercase tracking-[0.25em] text-primary font-mono font-semibold mb-2">
            Admin · Compliance
          </div>
          <h2 className="text-2xl font-semibold tracking-tight">
            Context Block confirmations
          </h2>
          <p className="text-sm text-muted-foreground mt-1 max-w-2xl">
            One row per user. Confirmed users sort newest first; users who
            have never confirmed appear at the bottom. OPSEC-flagged
            confirmations are highlighted for follow-up.
          </p>
        </div>
        <select
          value={showOnly}
          onChange={(e) =>
            setShowOnly(e.target.value as typeof showOnly)
          }
          className="px-3 py-1.5 rounded-md bg-background border border-border text-sm"
          aria-label="Filter Context Block confirmations"
        >
          <option value="all">All users</option>
          <option value="confirmed">Confirmed only</option>
          <option value="unconfirmed">Never confirmed</option>
          <option value="opsec">OPSEC-flagged</option>
          <option value="nogo">NO-GO status</option>
          <option value="bypassed">Bypassed (under 10/12)</option>
        </select>
      </div>

      {totals && (
        <div className="grid grid-cols-2 sm:grid-cols-6 gap-3 mb-6">
          <StatCard label="Total users" value={totals.totalUsers} />
          <StatCard
            label="Confirmed"
            value={totals.confirmedUsers}
            tone="good"
          />
          <StatCard
            label="Never confirmed"
            value={totals.unconfirmedUsers}
            tone={totals.unconfirmedUsers > 0 ? "warn" : "neutral"}
          />
          <StatCard
            label="OPSEC-flagged"
            value={totals.opsecFlaggedUsers}
            tone={
              totals.opsecFlaggedUsers > 0 ? "destructive" : "neutral"
            }
          />
          <StatCard
            label="NO-GO status"
            value={totals.noGoUsers}
            tone={totals.noGoUsers > 0 ? "warn" : "neutral"}
          />
          <StatCard
            label="Bypassed"
            value={totals.bypassedUsers}
            tone={totals.bypassedUsers > 0 ? "warn" : "neutral"}
          />
        </div>
      )}

      {error && <ErrorBox>{(error as Error).message}</ErrorBox>}

      {isLoading ? (
        <div className="space-y-2">
          {Array.from({ length: 4 }).map((_, i) => (
            <div
              key={i}
              className="bg-card border border-border rounded-md h-16 animate-pulse"
            />
          ))}
        </div>
      ) : filtered.length === 0 ? (
        <EmptyState
          title="No users match this filter"
          description="Adjust the filter to see other users."
        />
      ) : (
        <div className="overflow-x-auto rounded-md border border-border">
          <table className="w-full text-sm">
            <thead className="bg-card">
              <tr className="text-left text-[10px] uppercase tracking-wider font-mono text-muted-foreground">
                <th className="px-4 py-3">User</th>
                <th className="px-4 py-3">Branch / Rank</th>
                <th className="px-4 py-3">Last confirmed</th>
                <th className="px-4 py-3">Score</th>
                <th className="px-4 py-3">Status</th>
                <th className="px-4 py-3">Bypassed</th>
                <th className="px-4 py-3">Submission</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((u) => (
                <ConfirmationRow key={u.userId} u={u} />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function ConfirmationRow({ u }: { u: AdminContextBlockConfirmation }) {
  const rowClass = u.opsecFlag
    ? "border-t border-rose-500/30 bg-rose-500/5"
    : "border-t border-border";
  return (
    <tr className={rowClass}>
      <td className="px-4 py-3 align-top">
        <div className="font-medium flex items-center gap-2">
          {u.displayName}
          {u.isAdmin && (
            <Pill tone="info">admin</Pill>
          )}
        </div>
        {u.email && (
          <div className="text-[11px] font-mono text-muted-foreground mt-0.5">
            {u.email}
          </div>
        )}
      </td>
      <td className="px-4 py-3 align-top text-xs font-mono text-muted-foreground uppercase tracking-wider">
        {[u.rank, u.branch].filter(Boolean).join(" · ") || "—"}
      </td>
      <td className="px-4 py-3 align-top">
        {u.confirmedAt ? (
          <div>
            <div>{relativeTime(u.confirmedAt)}</div>
            <div className="text-[10px] font-mono text-muted-foreground mt-0.5">
              {new Date(u.confirmedAt).toLocaleString()}
            </div>
          </div>
        ) : (
          <Pill tone="warn">never confirmed</Pill>
        )}
      </td>
      <td className="px-4 py-3 align-top">
        {u.scoreTotal != null ? (
          <span className="font-mono text-sm">
            <span
              className={
                u.scoreTotal >= 10
                  ? "text-emerald-400"
                  : u.scoreTotal === 0
                    ? "text-rose-400"
                    : "text-amber-300"
              }
            >
              {u.scoreTotal}
            </span>
            <span className="text-muted-foreground"> / 12</span>
          </span>
        ) : (
          <span className="text-muted-foreground">—</span>
        )}
      </td>
      <td className="px-4 py-3 align-top">
        <div className="flex flex-col gap-1.5 items-start">
          {u.status ? (
            <Pill
              tone={
                u.status === "GO"
                  ? "good"
                  : u.status === "NO-GO"
                    ? "destructive"
                    : "neutral"
              }
            >
              {u.status}
            </Pill>
          ) : (
            <span className="text-muted-foreground">—</span>
          )}
          {u.opsecFlag && <Pill tone="destructive">OPSEC</Pill>}
        </div>
      </td>
      <td className="px-4 py-3 align-top">
        {u.bypassed ? (
          <Pill tone="warn">Bypassed</Pill>
        ) : (
          <span className="text-muted-foreground">—</span>
        )}
      </td>
      <td className="px-4 py-3 align-top">
        {u.submissionId ? (
          <span className="text-[11px] font-mono text-muted-foreground break-all">
            {u.submissionId}
          </span>
        ) : (
          <span className="text-muted-foreground">—</span>
        )}
      </td>
    </tr>
  );
}

function StatCard({
  label,
  value,
  tone = "neutral",
}: {
  label: string;
  value: number;
  tone?: "neutral" | "good" | "warn" | "destructive";
}) {
  const toneCls =
    tone === "good"
      ? "text-emerald-400"
      : tone === "warn"
        ? "text-amber-300"
        : tone === "destructive"
          ? "text-rose-400"
          : "text-foreground";
  return (
    <div className="rounded-md border border-border bg-card px-4 py-3">
      <div className="text-[10px] uppercase tracking-wider font-mono text-muted-foreground">
        {label}
      </div>
      <div className={`text-2xl font-semibold mt-1 ${toneCls}`}>{value}</div>
    </div>
  );
}
