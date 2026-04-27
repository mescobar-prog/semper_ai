import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useGetMyProfile,
  useAdminListTools,
  useCreateTool,
  useUpdateTool,
  useDeleteTool,
  useListCategories,
  getAdminListToolsQueryKey,
  getListToolsQueryKey,
} from "@workspace/api-client-react";
import type { ToolUpsert, ToolDetail } from "@workspace/api-client-react";
import {
  PageContainer,
  ErrorBox,
  Pill,
  atoLabel,
  atoTone,
  EmptyState,
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

function AdminInner() {
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
    <PageContainer>
      <div className="mb-8 flex items-end justify-between gap-6">
        <div>
          <div className="text-[10px] uppercase tracking-[0.25em] text-primary font-mono font-semibold mb-2">
            Admin · Catalog
          </div>
          <h1 className="text-3xl font-semibold tracking-tight">
            Tool management
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            Create, update, and deactivate tools in the marketplace catalog.
          </p>
        </div>
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
    </PageContainer>
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
