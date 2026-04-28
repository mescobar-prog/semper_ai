import { useState } from "react";
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
  getAdminListToolsQueryKey,
  getListToolsQueryKey,
  getAdminListSubmissionsQueryKey,
  getListMySubmissionsQueryKey,
  getAdminListReviewsQueryKey,
} from "@workspace/api-client-react";
import type {
  ToolUpsert,
  ToolDetail,
  SubmissionDetail,
  AdminToolReview,
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
  isActive: true,
};

export function Admin() {
  const { data: profile, isLoading: profileLoading } = useGetMyProfile();
  const isAdmin = profile?.isAdmin === true;

  if (profileLoading) {
    return (
      <PageContainer>
        <div className="text-muted-foreground font-mono text-xs uppercase tracking-widest">
          Verifying credentials…
        </div>
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

type AdminTab = "catalog" | "review" | "reviews";

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
          Review vendor submissions, manage the published catalog, and
          moderate user reviews.
        </p>
      </div>
      <div className="border-b border-border mb-6 flex gap-6">
        <TabBtn active={tab === "review"} onClick={() => setTab("review")}>
          Submission queue
        </TabBtn>
        <TabBtn active={tab === "catalog"} onClick={() => setTab("catalog")}>
          Catalog management
        </TabBtn>
        <TabBtn active={tab === "reviews"} onClick={() => setTab("reviews")}>
          Review moderation
        </TabBtn>
      </div>
      {tab === "review" ? (
        <ReviewQueue />
      ) : tab === "catalog" ? (
        <CatalogManagement />
      ) : (
        <ReviewModerationSection />
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
        isActive: t.isActive,
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
  categories,
  onChange,
  onCancel,
  onSubmit,
  submitting,
  formError,
}: {
  data: ToolUpsert;
  mode: "create" | "edit";
  categories: Array<{ id: string; name: string }>;
  onChange: (next: ToolUpsert) => void;
  onCancel: () => void;
  onSubmit: (e: React.FormEvent) => void;
  submitting: boolean;
  formError: string | null;
}) {
  const set = <K extends keyof ToolUpsert>(key: K, value: ToolUpsert[K]) =>
    onChange({ ...data, [key]: value });

  const toggleArr = (
    key: "impactLevels" | "badges",
    value: string,
  ) => {
    const arr = data[key] || [];
    onChange({
      ...data,
      [key]: arr.includes(value)
        ? arr.filter((v) => v !== value)
        : [...arr, value],
    });
  };

  return (
    <form
      onSubmit={onSubmit}
      className="bg-card border border-primary/30 rounded-md p-5 mb-6 space-y-4"
    >
      <div className="text-[10px] uppercase tracking-wider text-primary font-mono font-semibold">
        {mode === "create" ? "Add new tool" : "Edit tool"}
      </div>
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
        <Field label="Launch URL">
          <input
            required
            value={data.launchUrl}
            onChange={(e) => set("launchUrl", e.target.value)}
            placeholder="/context-echo/"
            className={inputCls}
          />
        </Field>
        <Field label="Version (optional)">
          <input
            value={data.version ?? ""}
            onChange={(e) => set("version", e.target.value || null)}
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
      <Field label="Short description">
        <input
          required
          value={data.shortDescription}
          onChange={(e) => set("shortDescription", e.target.value)}
          className={inputCls}
        />
      </Field>
      <Field label="Long description">
        <textarea
          required
          rows={4}
          value={data.longDescription}
          onChange={(e) => set("longDescription", e.target.value)}
          className={`${inputCls} font-mono`}
        />
      </Field>
      <Field label="Tool purpose (fed to RAG query generator)">
        <textarea
          rows={3}
          data-testid="textarea-purpose"
          value={data.purpose ?? ""}
          onChange={(e) => set("purpose", e.target.value)}
          placeholder="One sentence on what this tool actually does with the operator's context (e.g. 'Drafts NCOER bullets anchored to the operator's library of past evals and award citations.'). The query generator weighs this heavily over marketing copy."
          className={`${inputCls} font-mono`}
        />
      </Field>
      <Field label="RAG query templates (one per line; {curlies} = profile vars)">
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
          placeholder={`{primaryMission} OPORD\n{dutyTitle} commander's intent\n{unit} mission essential task`}
          className={`${inputCls} font-mono`}
        />
        <div className="mt-1.5 text-[10px] font-mono text-muted-foreground leading-relaxed">
          Available vars: {"{primaryMission} {dutyTitle} {mosCode} {unit} {branch} {rank} {baseLocation} {aiUseCases}"}.
          Templates with vars the operator hasn't filled in are skipped.
        </div>
      </Field>
      <div className="grid sm:grid-cols-2 gap-3">
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
      </div>
      <div className="flex items-center gap-2">
        <input
          id="isActive"
          type="checkbox"
          checked={data.isActive}
          onChange={(e) => set("isActive", e.target.checked)}
          className="w-4 h-4 accent-primary"
        />
        <label htmlFor="isActive" className="text-sm">
          Active in catalog
        </label>
      </div>
      {formError && <ErrorBox>{formError}</ErrorBox>}
      <div className="flex justify-end gap-2 pt-2 border-t border-border">
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

const inputCls =
  "w-full px-3 py-2 rounded-md bg-background border border-border text-sm focus:border-primary focus:outline-none";

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <label className="block text-[10px] font-mono uppercase tracking-wider text-muted-foreground mb-1.5">
        {label}
      </label>
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
