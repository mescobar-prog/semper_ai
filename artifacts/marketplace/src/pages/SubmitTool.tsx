import { useEffect, useState } from "react";
import { useLocation, useParams } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import {
  useListCategories,
  useCreateSubmission,
  useUpdateMySubmission,
  useGetMySubmission,
  getListMySubmissionsQueryKey,
  getGetMySubmissionQueryKey,
  getAdminListSubmissionsQueryKey,
} from "@workspace/api-client-react";
import type { SubmissionUpsert } from "@workspace/api-client-react";
import { PageContainer, ErrorBox, Pill } from "@/lib/format";

const ATO_STATUSES = [
  { value: "in_review", label: "In ATO Review" },
  { value: "ipa", label: "Interim Authority" },
  { value: "full_ato", label: "Full ATO" },
];
const IMPACT_LEVELS = ["IL2", "IL4", "IL5", "IL6"];
const DATA_CLASS = ["Unclassified", "CUI", "FOUO", "Secret"];

const EMPTY: SubmissionUpsert = {
  name: "",
  vendor: "",
  shortDescription: "",
  longDescription: "",
  categoryId: null,
  atoStatus: "in_review",
  impactLevels: [],
  dataClassification: "CUI",
  launchUrl: "",
  homepageUrl: null,
  documentationUrl: null,
  logoUrl: null,
  contactEmail: "",
};

export function SubmitTool() {
  const params = useParams<{ id?: string }>();
  const editingId = params?.id;
  const [, setLocation] = useLocation();
  const queryClient = useQueryClient();

  const { data: categories } = useListCategories();
  const { data: existing, isLoading: loadingExisting } = useGetMySubmission(
    editingId ?? "",
    {
      query: {
        enabled: !!editingId,
        queryKey: getGetMySubmissionQueryKey(editingId ?? ""),
      },
    },
  );
  const createMutation = useCreateSubmission();
  const updateMutation = useUpdateMySubmission();

  const [data, setData] = useState<SubmissionUpsert>(EMPTY);
  const [error, setError] = useState<string | null>(null);
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    if (existing && !hydrated) {
      setData({
        name: existing.name,
        vendor: existing.vendor,
        shortDescription: existing.shortDescription,
        longDescription: existing.longDescription,
        categoryId: existing.categoryId,
        atoStatus: existing.atoStatus,
        impactLevels: existing.impactLevels,
        dataClassification: existing.dataClassification,
        launchUrl: existing.launchUrl,
        homepageUrl: existing.homepageUrl,
        documentationUrl: existing.documentationUrl,
        logoUrl: existing.logoUrl,
        contactEmail: existing.contactEmail ?? "",
      });
      setHydrated(true);
    }
  }, [existing, hydrated]);

  const set = <K extends keyof SubmissionUpsert>(
    k: K,
    v: SubmissionUpsert[K],
  ) => setData((d) => ({ ...d, [k]: v }));
  const toggleImpact = (il: string) => {
    setData((d) => ({
      ...d,
      impactLevels: d.impactLevels.includes(il)
        ? d.impactLevels.filter((v) => v !== il)
        : [...d.impactLevels, il],
    }));
  };

  const submitting = createMutation.isPending || updateMutation.isPending;

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    try {
      let id: string;
      if (editingId) {
        const result = await updateMutation.mutateAsync({
          id: editingId,
          data,
        });
        id = result.id;
      } else {
        const result = await createMutation.mutateAsync({ data });
        id = result.id;
      }
      queryClient.invalidateQueries({
        queryKey: getListMySubmissionsQueryKey(),
      });
      queryClient.invalidateQueries({
        queryKey: getAdminListSubmissionsQueryKey(),
      });
      queryClient.invalidateQueries({
        queryKey: getGetMySubmissionQueryKey(id),
      });
      setLocation("/submissions");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Submission failed");
    }
  };

  const isEditing = !!editingId;
  const wasChangesRequested =
    isEditing && existing?.submissionStatus === "changes_requested";

  if (editingId && loadingExisting) {
    return (
      <PageContainer>
        <div className="text-muted-foreground font-mono text-xs uppercase tracking-widest">
          Loading submission…
        </div>
      </PageContainer>
    );
  }
  if (editingId && !existing) {
    return (
      <PageContainer>
        <ErrorBox>Submission not found.</ErrorBox>
      </PageContainer>
    );
  }
  if (
    isEditing &&
    existing &&
    existing.submissionStatus !== "pending" &&
    existing.submissionStatus !== "changes_requested"
  ) {
    return (
      <PageContainer>
        <ErrorBox>
          This submission is locked (status:{" "}
          <span className="font-mono">{existing.submissionStatus}</span>) and
          can no longer be edited by you.
        </ErrorBox>
      </PageContainer>
    );
  }

  return (
    <PageContainer>
      <div className="mb-8">
        <div className="text-[10px] uppercase tracking-[0.25em] text-primary font-mono font-semibold mb-2">
          Vendor · Submission
        </div>
        <h1 className="text-3xl font-semibold tracking-tight">
          {isEditing ? "Edit submission" : "Submit a tool"}
        </h1>
        <p className="text-sm text-muted-foreground mt-1">
          {isEditing
            ? "Address the reviewer feedback and resubmit. Saving will move this submission back to pending review."
            : "Submit an AI tool for marketplace admin review. Approved tools appear in the public catalog with a vendor-submitted badge."}
        </p>
      </div>

      {wasChangesRequested && existing?.reviewComment && (
        <div className="bg-amber-500/5 border border-amber-500/30 rounded-md p-4 mb-6">
          <div className="text-[10px] uppercase tracking-wider font-mono text-amber-400 font-semibold mb-2">
            Reviewer requested changes
          </div>
          <p className="text-sm text-amber-100/90 whitespace-pre-wrap">
            {existing.reviewComment}
          </p>
        </div>
      )}

      <form onSubmit={onSubmit} className="space-y-5">
        <Section title="Tool basics">
          <Grid>
            <Field label="Tool name" required>
              <input
                required
                value={data.name}
                onChange={(e) => set("name", e.target.value)}
                className={inputCls}
              />
            </Field>
            <Field label="Vendor / company" required>
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
                {categories?.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Contact email" required>
              <input
                required
                type="email"
                value={data.contactEmail}
                onChange={(e) => set("contactEmail", e.target.value)}
                className={inputCls}
                placeholder="vendor-contact@example.mil"
              />
            </Field>
          </Grid>
          <Field label="Short description (one-liner)" required>
            <input
              required
              value={data.shortDescription}
              onChange={(e) => set("shortDescription", e.target.value)}
              className={inputCls}
            />
          </Field>
          <Field label="Long description" required>
            <textarea
              required
              rows={5}
              value={data.longDescription}
              onChange={(e) => set("longDescription", e.target.value)}
              className={`${inputCls} font-mono`}
            />
          </Field>
        </Section>

        <Section title="Authorization">
          <Grid>
            <Field label="Requested ATO status">
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
          </Grid>
          <Field label="Requested impact levels">
            <div className="flex gap-2 flex-wrap">
              {IMPACT_LEVELS.map((il) => {
                const active = data.impactLevels.includes(il);
                return (
                  <button
                    type="button"
                    key={il}
                    onClick={() => toggleImpact(il)}
                    className={`px-2.5 py-1 rounded border text-[11px] font-mono uppercase tracking-wider ${
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
        </Section>

        <Section title="URLs">
          <Field label="Launch URL" required>
            <input
              required
              value={data.launchUrl}
              onChange={(e) => set("launchUrl", e.target.value)}
              placeholder="https://tool.vendor.example/launch"
              className={inputCls}
            />
          </Field>
          <Grid>
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
          </Grid>
          <Field label="Logo URL (optional)">
            <input
              value={data.logoUrl ?? ""}
              onChange={(e) => set("logoUrl", e.target.value || null)}
              placeholder="https://…/logo.png"
              className={inputCls}
            />
          </Field>
        </Section>

        {error && <ErrorBox>{error}</ErrorBox>}
        <div className="flex items-center justify-between pt-2 border-t border-border">
          <div className="text-xs text-muted-foreground font-mono">
            {isEditing ? (
              <>
                Editing submission{" "}
                <Pill tone="warn">{existing?.submissionStatus}</Pill>
              </>
            ) : (
              "All fields marked required must be filled."
            )}
          </div>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => setLocation("/submissions")}
              className="h-10 px-4 rounded-md border border-border text-sm hover:bg-accent"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={submitting}
              className="h-10 px-5 rounded-md bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 disabled:opacity-50"
            >
              {submitting
                ? "Saving…"
                : isEditing
                  ? "Resubmit for review"
                  : "Submit for review"}
            </button>
          </div>
        </div>
      </form>
    </PageContainer>
  );
}

const inputCls =
  "w-full px-3 py-2 rounded-md bg-background border border-border text-sm focus:border-primary focus:outline-none";

function Field({
  label,
  required,
  children,
}: {
  label: string;
  required?: boolean;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <div className="text-[10px] font-mono uppercase tracking-wider text-muted-foreground mb-1.5">
        {label}
        {required && <span className="text-rose-400 ml-1">*</span>}
      </div>
      {children}
    </label>
  );
}

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="bg-card border border-border rounded-md p-5 space-y-4">
      <div className="text-[10px] uppercase tracking-wider font-mono text-primary font-semibold">
        {title}
      </div>
      {children}
    </section>
  );
}

function Grid({ children }: { children: React.ReactNode }) {
  return <div className="grid sm:grid-cols-2 gap-3">{children}</div>;
}
