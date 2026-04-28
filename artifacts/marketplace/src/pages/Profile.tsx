import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useGetMyProfile,
  useUpdateMyProfile,
  useGetProfileChatHistory,
  useSendProfileChat,
  useResetProfileChat,
  useGetAutoIngestStatus,
  useListMyPresets,
  useCreateMyPreset,
  useUpdateMyPreset,
  useDeleteMyPreset,
  useDuplicateMyPreset,
  useActivateMyPreset,
  useListDocuments,
  getGetMyProfileQueryKey,
  getGetProfileChatHistoryQueryKey,
  getGetAutoIngestStatusQueryKey,
  getListDocumentsQueryKey,
  getListMyPresetsQueryKey,
  getGetDashboardSummaryQueryKey,
} from "@workspace/api-client-react";
import type {
  ProfileUpdate,
  UserProfile,
  ChatMessage,
  MissionPreset,
  DocumentSummary,
} from "@workspace/api-client-react";
import {
  BRANCHES as MIL_BRANCHES,
  branchCode,
  buildMosAutoSource,
  buildUnitAutoSource,
  findMosEntry,
  hasUnitDoctrinePackage,
  listMosForBranch,
  listUnitsForBranch,
} from "@workspace/mil-data";
import { PageContainer, ErrorBox, formatDate } from "@/lib/format";

const BRANCHES = MIL_BRANCHES.map((b) => b.label);
const CLEARANCES = [
  "None",
  "Public Trust",
  "Secret",
  "Top Secret",
  "TS/SCI",
];
const DEPLOYMENT_STATUS = [
  "Garrison",
  "Train-up",
  "Deployed",
  "Reset",
  "TDY",
];

// Branch / MOS / Unit are handled separately so we can wire up the typeahead
// pickers and the auto-ingest status panel. The remaining fields are still
// rendered through the generic FIELDS table.
const FIELDS: Array<{
  key: keyof ProfileUpdate;
  label: string;
  type: "text" | "select" | "textarea";
  options?: string[];
  span?: 1 | 2 | 3;
  placeholder?: string;
}> = [
  { key: "rank", label: "Rank", type: "text", placeholder: "e.g. SSG, O-3" },
  {
    key: "dutyTitle",
    label: "Duty title",
    type: "text",
    placeholder: "e.g. Platoon Sergeant",
  },
  {
    key: "baseLocation",
    label: "Base / location",
    type: "text",
    placeholder: "e.g. Fort Campbell, KY",
  },
  {
    key: "securityClearance",
    label: "Clearance",
    type: "select",
    options: CLEARANCES,
  },
  {
    key: "deploymentStatus",
    label: "Deployment status",
    type: "select",
    options: DEPLOYMENT_STATUS,
  },
  {
    key: "primaryMission",
    label: "Primary mission",
    type: "textarea",
    span: 3,
    placeholder: "What does your unit actually do day-to-day?",
  },
  {
    key: "freeFormContext",
    label: "Narrative context",
    type: "textarea",
    span: 3,
    placeholder:
      "Anything else a tool should know — current operation, equipment, AOR, frequent tasks…",
  },
];

export function Profile() {
  const queryClient = useQueryClient();
  const { data: profile, isLoading, error } = useGetMyProfile();
  const updateMutation = useUpdateMyProfile();

  const [draft, setDraft] = useState<ProfileUpdate | null>(null);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);

  // Versioning + timer refs prevent out-of-order responses from clobbering
  // newer user input. Every queued save bumps the version, the in-flight
  // request only commits if it is still the latest.
  const versionRef = useRef(0);
  const lastCommittedRef = useRef(0);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingDraftRef = useRef<ProfileUpdate | null>(null);

  useEffect(() => {
    if (profile && !draft) {
      setDraft(profileToDraft(profile));
    }
  }, [profile, draft]);

  const flush = useCallback(async () => {
    const next = pendingDraftRef.current;
    if (!next) return;
    const myVersion = ++versionRef.current;
    setSaveError(null);
    try {
      const updated = await updateMutation.mutateAsync({ data: next });
      // Only commit this response if no newer save has been queued in the
      // meantime — discards stale "last response wins" overwrites.
      if (myVersion >= lastCommittedRef.current) {
        lastCommittedRef.current = myVersion;
        setSavedAt(Date.now());
        queryClient.setQueryData(getGetMyProfileQueryKey(), updated);
      }
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : "Failed to save profile");
    }
  }, [queryClient, updateMutation]);

  const queueSave = useCallback(
    (next: ProfileUpdate) => {
      setDraft(next);
      pendingDraftRef.current = next;
      if (debounceRef.current) clearTimeout(debounceRef.current);
      debounceRef.current = setTimeout(() => {
        debounceRef.current = null;
        void flush();
      }, 400);
    },
    [flush],
  );

  // On unmount, flush any pending edit so we don't lose the last keystrokes.
  useEffect(() => {
    return () => {
      if (debounceRef.current) {
        clearTimeout(debounceRef.current);
        debounceRef.current = null;
        void flush();
      }
    };
  }, [flush]);

  const onChange = (key: keyof ProfileUpdate, value: string) => {
    if (!draft) return;
    queueSave({ ...draft, [key]: value || null });
  };

  // Picking a new branch should reset the MOS+unit fields, since their valid
  // values depend on branch. Without this the user can end up with an
  // "Army:5933" combination that doesn't match any curated MOS.
  const onChangeBranch = (value: string) => {
    if (!draft) return;
    const next: ProfileUpdate = { ...draft, branch: value || null };
    if (value !== draft.branch) {
      next.mosCode = null;
      next.unit = null;
    }
    queueSave(next);
  };

  const onAiUseCases = (value: string) => {
    if (!draft) return;
    const arr = value
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    queueSave({ ...draft, aiUseCases: arr });
  };

  const applySuggestion = (suggestion: ProfileUpdate) => {
    if (!draft) return;
    queueSave({ ...draft, ...suggestion });
  };

  const exportProfile = useCallback(
    async (format: "md" | "json") => {
      // Flush any pending debounced save so the export reflects the latest edits.
      if (debounceRef.current) {
        clearTimeout(debounceRef.current);
        debounceRef.current = null;
        await flush();
      }
      const latest =
        queryClient.getQueryData<UserProfile>(getGetMyProfileQueryKey()) ??
        profile;
      if (!latest) return;

      const date = new Date().toISOString().slice(0, 10);
      let content: string;
      let mime: string;
      let ext: string;
      if (format === "md") {
        content = profileToMarkdown(latest);
        mime = "text/markdown;charset=utf-8";
        ext = "md";
      } else {
        content = JSON.stringify(latest, null, 2);
        mime = "application/json;charset=utf-8";
        ext = "json";
      }
      const blob = new Blob([content], { type: mime });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `operator-profile-${date}.${ext}`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    },
    [flush, profile, queryClient],
  );

  if (error) {
    return (
      <PageContainer>
        <ErrorBox>{(error as Error).message}</ErrorBox>
      </PageContainer>
    );
  }

  return (
    <PageContainer>
      <div className="mb-8 flex items-end justify-between gap-6">
        <div>
          <div className="text-[10px] uppercase tracking-[0.25em] text-primary font-mono font-semibold mb-2">
            Operator Profile
          </div>
          <h1 className="text-3xl font-semibold tracking-tight">
            Mission context
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            Every tool you launch receives this context. Edit fields directly,
            or chat with the assistant to fill it in conversationally.
          </p>
        </div>
        {profile && (
          <div className="flex items-end gap-5">
            <ExportMenu onExport={exportProfile} />
            <div className="text-right">
              <div className="text-[10px] font-mono uppercase tracking-wider text-muted-foreground">
                Completeness
              </div>
              <div className="text-3xl font-semibold tabular-nums">
                {profile.completenessPct}%
              </div>
              <div className="w-32 h-1 bg-border rounded-full overflow-hidden mt-1">
                <div
                  className="h-full bg-primary"
                  style={{ width: `${profile.completenessPct}%` }}
                />
              </div>
            </div>
          </div>
        )}
      </div>

      <div className="grid lg:grid-cols-5 gap-6">
        <section className="lg:col-span-3 bg-card border border-border rounded-md p-5">
          {isLoading || !draft ? (
            <div className="text-muted-foreground text-sm">
              Loading profile…
            </div>
          ) : (
            <div className="grid grid-cols-3 gap-4">
              <BranchMosUnitFields draft={draft} onChange={onChange} onChangeBranch={onChangeBranch} />
              {FIELDS.map((f) => {
                const colSpan =
                  f.span === 3
                    ? "col-span-3"
                    : f.span === 2
                      ? "col-span-2"
                      : "col-span-3 sm:col-span-1";
                const value =
                  ((draft as Record<string, unknown>)[f.key] as
                    | string
                    | null) ?? "";
                return (
                  <div key={f.key} className={colSpan}>
                    <label className="block text-[10px] font-mono uppercase tracking-wider text-muted-foreground mb-1.5">
                      {f.label}
                    </label>
                    {f.type === "select" ? (
                      <select
                        value={value}
                        onChange={(e) => onChange(f.key, e.target.value)}
                        className="w-full px-3 py-2 rounded-md bg-background border border-border text-sm focus:border-primary focus:outline-none"
                      >
                        <option value="">— unset —</option>
                        {f.options?.map((o) => (
                          <option key={o} value={o}>
                            {o}
                          </option>
                        ))}
                      </select>
                    ) : f.type === "textarea" ? (
                      <textarea
                        value={value}
                        onChange={(e) => onChange(f.key, e.target.value)}
                        placeholder={f.placeholder}
                        rows={3}
                        className="w-full px-3 py-2 rounded-md bg-background border border-border text-sm focus:border-primary focus:outline-none resize-y"
                      />
                    ) : (
                      <input
                        type="text"
                        value={value}
                        onChange={(e) => onChange(f.key, e.target.value)}
                        placeholder={f.placeholder}
                        className="w-full px-3 py-2 rounded-md bg-background border border-border text-sm focus:border-primary focus:outline-none"
                      />
                    )}
                  </div>
                );
              })}
              <div className="col-span-3">
                <label className="block text-[10px] font-mono uppercase tracking-wider text-muted-foreground mb-1.5">
                  AI use cases (comma-separated)
                </label>
                <input
                  type="text"
                  defaultValue={(draft.aiUseCases ?? []).join(", ")}
                  onBlur={(e) => onAiUseCases(e.target.value)}
                  placeholder="planning, analysis, drafting, code review…"
                  className="w-full px-3 py-2 rounded-md bg-background border border-border text-sm focus:border-primary focus:outline-none"
                />
              </div>
              <div className="col-span-3 border-t border-border pt-4 mt-2">
                <div className="text-[10px] font-mono uppercase tracking-wider text-muted-foreground mb-2">
                  Launch behavior
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <label
                    className={`cursor-pointer border rounded-md p-3 text-xs ${
                      (draft.launchPreference ?? "preview") === "preview"
                        ? "border-primary bg-primary/5"
                        : "border-border hover:border-primary/50"
                    }`}
                  >
                    <input
                      type="radio"
                      name="launchPref"
                      className="sr-only"
                      checked={
                        (draft.launchPreference ?? "preview") === "preview"
                      }
                      onChange={() =>
                        queueSave({ ...draft, launchPreference: "preview" })
                      }
                    />
                    <div className="font-semibold text-foreground mb-0.5">
                      Preview before launching
                    </div>
                    <div className="text-muted-foreground">
                      Show a redaction screen so you can deselect fields or
                      snippets before they are sent.
                    </div>
                  </label>
                  <label
                    className={`cursor-pointer border rounded-md p-3 text-xs ${
                      draft.launchPreference === "direct"
                        ? "border-primary bg-primary/5"
                        : "border-border hover:border-primary/50"
                    }`}
                  >
                    <input
                      type="radio"
                      name="launchPref"
                      className="sr-only"
                      checked={draft.launchPreference === "direct"}
                      onChange={() =>
                        queueSave({ ...draft, launchPreference: "direct" })
                      }
                    />
                    <div className="font-semibold text-foreground mb-0.5">
                      Launch directly
                    </div>
                    <div className="text-muted-foreground">
                      Skip the preview and send your full profile and top
                      snippets every time.
                    </div>
                  </label>
                </div>
              </div>
              <div className="col-span-3 space-y-2">
                <div className="text-[10px] font-mono uppercase tracking-wider text-muted-foreground">
                  {updateMutation.isPending
                    ? "Saving…"
                    : savedAt
                      ? `Saved · ${formatDate(new Date(savedAt).toISOString())}`
                      : "Changes save automatically"}
                </div>
                {saveError && <ErrorBox>Save failed: {saveError}</ErrorBox>}
              </div>
              <div className="col-span-3">
                <IngestStatusPanel draft={draft} />
              </div>
            </div>
          )}
        </section>

        <ChatPanel onApply={applySuggestion} />
      </div>

      <PresetsSection />
    </PageContainer>
  );
}

function PresetsSection() {
  const queryClient = useQueryClient();
  const { data: presets, isLoading } = useListMyPresets({
    query: { queryKey: getListMyPresetsQueryKey() },
  });
  const { data: documents } = useListDocuments(undefined, {
    query: { queryKey: getListDocumentsQueryKey() },
  });

  const createMutation = useCreateMyPreset();
  const activateMutation = useActivateMyPreset();
  const duplicateMutation = useDuplicateMyPreset();
  const deleteMutation = useDeleteMyPreset();

  const [showCreate, setShowCreate] = useState(false);
  const [createForm, setCreateForm] = useState({
    name: "",
    description: "",
    activate: false,
  });
  const [createError, setCreateError] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);

  const invalidateAll = () => {
    queryClient.invalidateQueries({ queryKey: getListMyPresetsQueryKey() });
    queryClient.invalidateQueries({ queryKey: getGetMyProfileQueryKey() });
    queryClient.invalidateQueries({ queryKey: getListDocumentsQueryKey() });
    queryClient.invalidateQueries({
      queryKey: getGetDashboardSummaryQueryKey(),
    });
  };

  const onCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    setCreateError(null);
    try {
      await createMutation.mutateAsync({
        data: {
          name: createForm.name.trim(),
          description: createForm.description.trim() || null,
          activate: createForm.activate,
        },
      });
      setCreateForm({ name: "", description: "", activate: false });
      setShowCreate(false);
      invalidateAll();
    } catch (err) {
      setCreateError(err instanceof Error ? err.message : "Create failed");
    }
  };

  const onActivate = async (id: string) => {
    await activateMutation.mutateAsync({ id });
    invalidateAll();
  };

  const onDuplicate = async (id: string) => {
    await duplicateMutation.mutateAsync({ id });
    invalidateAll();
  };

  const onDelete = async (id: string) => {
    if (!confirm("Delete this preset? Documents stay in your library.")) return;
    try {
      await deleteMutation.mutateAsync({ id });
      invalidateAll();
    } catch (err) {
      alert(err instanceof Error ? err.message : "Delete failed");
    }
  };

  const list: MissionPreset[] = presets ?? [];
  const docs: DocumentSummary[] = documents ?? [];

  return (
    <section className="mt-10">
      <div className="flex items-end justify-between mb-4">
        <div>
          <div className="text-[10px] uppercase tracking-[0.25em] text-primary font-mono font-semibold mb-1">
            Mission Presets
          </div>
          <h2 className="text-xl font-semibold tracking-tight">
            Saved profile + library configurations
          </h2>
          <p className="text-sm text-muted-foreground mt-1 max-w-2xl">
            Switch between contexts — garrison vs. deployment, primary MOS vs.
            additional duty — without rewriting your profile each time. Tools
            you launch use the active preset's snapshot and document scope.
          </p>
        </div>
        <button
          onClick={() => setShowCreate((v) => !v)}
          className="h-9 px-4 rounded-md bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90"
        >
          {showCreate ? "Cancel" : "New preset"}
        </button>
      </div>

      {showCreate && (
        <form
          onSubmit={onCreate}
          className="bg-card border border-border rounded-md p-4 mb-4 space-y-3"
        >
          <div>
            <label className="block text-[10px] font-mono uppercase tracking-wider text-muted-foreground mb-1.5">
              Name (required)
            </label>
            <input
              type="text"
              required
              value={createForm.name}
              onChange={(e) =>
                setCreateForm({ ...createForm, name: e.target.value })
              }
              placeholder="JRTC Rotation – Platoon Sgt"
              className="w-full px-3 py-2 rounded-md bg-background border border-border text-sm focus:border-primary focus:outline-none"
            />
          </div>
          <div>
            <label className="block text-[10px] font-mono uppercase tracking-wider text-muted-foreground mb-1.5">
              Description
            </label>
            <input
              type="text"
              value={createForm.description}
              onChange={(e) =>
                setCreateForm({
                  ...createForm,
                  description: e.target.value,
                })
              }
              placeholder="Pre-rotation prep, light infantry"
              className="w-full px-3 py-2 rounded-md bg-background border border-border text-sm focus:border-primary focus:outline-none"
            />
          </div>
          <label className="flex items-center gap-2 text-sm text-muted-foreground">
            <input
              type="checkbox"
              checked={createForm.activate}
              onChange={(e) =>
                setCreateForm({ ...createForm, activate: e.target.checked })
              }
            />
            Switch to this preset immediately
          </label>
          <p className="text-xs text-muted-foreground">
            The preset is created from your current profile snapshot. You can
            edit the description, name, and document scope after creating it.
          </p>
          {createError && <ErrorBox>{createError}</ErrorBox>}
          <div className="flex justify-end">
            <button
              type="submit"
              disabled={createMutation.isPending}
              className="h-9 px-4 rounded-md bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 disabled:opacity-50"
            >
              {createMutation.isPending ? "Creating…" : "Create preset"}
            </button>
          </div>
        </form>
      )}

      {isLoading ? (
        <div className="text-sm text-muted-foreground">Loading presets…</div>
      ) : (
        <div className="grid md:grid-cols-2 gap-3">
          {list.map((p) => (
            <PresetCard
              key={p.id}
              preset={p}
              isEditing={editingId === p.id}
              onEditOpen={() => setEditingId(p.id)}
              onEditClose={() => setEditingId(null)}
              docs={docs}
              onActivate={() => onActivate(p.id)}
              onDuplicate={() => onDuplicate(p.id)}
              onDelete={() => onDelete(p.id)}
              onChanged={invalidateAll}
              canDelete={list.length > 1}
            />
          ))}
        </div>
      )}
    </section>
  );
}

function PresetCard({
  preset,
  isEditing,
  onEditOpen,
  onEditClose,
  docs,
  onActivate,
  onDuplicate,
  onDelete,
  onChanged,
  canDelete,
}: {
  preset: MissionPreset;
  isEditing: boolean;
  onEditOpen: () => void;
  onEditClose: () => void;
  docs: DocumentSummary[];
  onActivate: () => void;
  onDuplicate: () => void;
  onDelete: () => void;
  onChanged: () => void;
  canDelete: boolean;
}) {
  const updateMutation = useUpdateMyPreset();
  const [name, setName] = useState(preset.name);
  const [description, setDescription] = useState(preset.description ?? "");
  const [docIds, setDocIds] = useState<string[]>(preset.documentIds);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (isEditing) {
      setName(preset.name);
      setDescription(preset.description ?? "");
      setDocIds(preset.documentIds);
      setError(null);
    }
  }, [isEditing, preset]);

  const onSave = async () => {
    setError(null);
    try {
      await updateMutation.mutateAsync({
        id: preset.id,
        data: {
          name: name.trim(),
          description: description.trim() || null,
          documentIds: docIds,
        },
      });
      onChanged();
      onEditClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Save failed");
    }
  };

  const docCountInScope = preset.documentIds.length;
  const snap = preset.profileSnapshot;

  return (
    <div
      className={`bg-card border rounded-md p-4 ${
        preset.isActive
          ? "border-primary/50 shadow-[0_0_0_1px_var(--primary)]"
          : "border-border"
      }`}
    >
      <div className="flex items-start justify-between gap-3 mb-2">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <div className="text-base font-semibold truncate">{preset.name}</div>
            {preset.isActive && (
              <span className="text-[9px] font-mono uppercase tracking-wider px-1.5 py-0.5 rounded border border-primary/40 bg-primary/10 text-primary">
                Active
              </span>
            )}
          </div>
          {preset.description && (
            <div className="text-xs text-muted-foreground mt-1 line-clamp-2">
              {preset.description}
            </div>
          )}
        </div>
        {!preset.isActive && (
          <button
            onClick={onActivate}
            className="shrink-0 text-[11px] font-medium px-2.5 py-1 rounded bg-primary/15 hover:bg-primary/25 text-primary"
          >
            Activate
          </button>
        )}
      </div>

      {!isEditing && (
        <>
          <div className="text-[11px] font-mono text-muted-foreground space-y-0.5 mb-3">
            {snap.branch && <div>Branch: {snap.branch}</div>}
            {snap.rank && <div>Rank: {snap.rank}</div>}
            {snap.dutyTitle && <div>Duty: {snap.dutyTitle}</div>}
            {snap.unit && <div>Unit: {snap.unit}</div>}
            {snap.deploymentStatus && (
              <div>Status: {snap.deploymentStatus}</div>
            )}
          </div>
          <div className="text-[11px] font-mono text-muted-foreground mb-3">
            {docCountInScope} doc{docCountInScope === 1 ? "" : "s"} in scope
          </div>
          <div className="flex gap-2">
            <button
              onClick={onEditOpen}
              className="text-[11px] font-mono uppercase tracking-wider text-muted-foreground hover:text-foreground"
            >
              Edit
            </button>
            <button
              onClick={onDuplicate}
              className="text-[11px] font-mono uppercase tracking-wider text-muted-foreground hover:text-foreground"
            >
              Duplicate
            </button>
            <button
              onClick={onDelete}
              disabled={!canDelete}
              title={!canDelete ? "You need at least one preset" : undefined}
              className="ml-auto text-[11px] font-mono uppercase tracking-wider text-muted-foreground hover:text-rose-400 disabled:opacity-30 disabled:cursor-not-allowed"
            >
              Delete
            </button>
          </div>
        </>
      )}

      {isEditing && (
        <div className="space-y-3">
          <div>
            <label className="block text-[10px] font-mono uppercase tracking-wider text-muted-foreground mb-1">
              Name
            </label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="w-full px-3 py-1.5 rounded-md bg-background border border-border text-sm focus:border-primary focus:outline-none"
            />
          </div>
          <div>
            <label className="block text-[10px] font-mono uppercase tracking-wider text-muted-foreground mb-1">
              Description
            </label>
            <input
              type="text"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              className="w-full px-3 py-1.5 rounded-md bg-background border border-border text-sm focus:border-primary focus:outline-none"
            />
          </div>
          <div>
            <div className="flex items-center justify-between mb-1">
              <label className="text-[10px] font-mono uppercase tracking-wider text-muted-foreground">
                Documents in scope ({docIds.length}/{docs.length})
              </label>
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => setDocIds(docs.map((d) => d.id))}
                  className="text-[10px] font-mono uppercase tracking-wider text-primary hover:underline"
                >
                  All
                </button>
                <button
                  type="button"
                  onClick={() => setDocIds([])}
                  className="text-[10px] font-mono uppercase tracking-wider text-muted-foreground hover:text-foreground"
                >
                  None
                </button>
              </div>
            </div>
            <div className="max-h-40 overflow-y-auto border border-border rounded p-2 bg-background space-y-1">
              {docs.length === 0 && (
                <div className="text-xs text-muted-foreground italic">
                  No documents in your library yet.
                </div>
              )}
              {docs.map((d) => (
                <label
                  key={d.id}
                  className="flex items-center gap-2 text-xs cursor-pointer hover:bg-accent/30 px-1.5 py-0.5 rounded"
                >
                  <input
                    type="checkbox"
                    checked={docIds.includes(d.id)}
                    onChange={(e) => {
                      if (e.target.checked) {
                        setDocIds([...docIds, d.id]);
                      } else {
                        setDocIds(docIds.filter((x) => x !== d.id));
                      }
                    }}
                  />
                  <span className="truncate">{d.title}</span>
                </label>
              ))}
            </div>
          </div>
          {error && <ErrorBox>{error}</ErrorBox>}
          <div className="flex gap-2 justify-end">
            <button
              type="button"
              onClick={onEditClose}
              className="text-[11px] font-mono uppercase tracking-wider text-muted-foreground hover:text-foreground px-2.5 py-1"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={onSave}
              disabled={updateMutation.isPending}
              className="text-[11px] font-medium px-3 py-1.5 rounded bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
            >
              {updateMutation.isPending ? "Saving…" : "Save"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function ExportMenu({
  onExport,
}: {
  onExport: (format: "md" | "json") => void | Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const wrapperRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (
        wrapperRef.current &&
        !wrapperRef.current.contains(e.target as Node)
      ) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  const choose = (fmt: "md" | "json") => {
    setOpen(false);
    void onExport(fmt);
  };

  return (
    <div className="relative" ref={wrapperRef}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="menu"
        aria-expanded={open}
        className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md border border-border bg-background hover:bg-accent text-sm font-medium"
      >
        Export
        <svg
          width="10"
          height="10"
          viewBox="0 0 10 10"
          aria-hidden="true"
          className="opacity-70"
        >
          <path
            d="M2 3.5l3 3 3-3"
            stroke="currentColor"
            strokeWidth="1.5"
            fill="none"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </button>
      {open && (
        <div
          role="menu"
          className="absolute right-0 mt-1 w-48 rounded-md border border-border bg-card shadow-lg z-10 py-1"
        >
          <button
            type="button"
            role="menuitem"
            onClick={() => choose("md")}
            className="w-full text-left px-3 py-1.5 text-sm hover:bg-accent flex items-center justify-between"
          >
            <span>Markdown</span>
            <span className="text-[10px] font-mono text-muted-foreground">
              .md
            </span>
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() => choose("json")}
            className="w-full text-left px-3 py-1.5 text-sm hover:bg-accent flex items-center justify-between"
          >
            <span>JSON</span>
            <span className="text-[10px] font-mono text-muted-foreground">
              .json
            </span>
          </button>
        </div>
      )}
    </div>
  );
}

function BranchMosUnitFields({
  draft,
  onChange,
  onChangeBranch,
}: {
  draft: ProfileUpdate;
  onChange: (key: keyof ProfileUpdate, value: string) => void;
  onChangeBranch: (value: string) => void;
}) {
  // Resolve the user's branch to a code so we can scope the typeahead lists.
  const code = useMemo(() => branchCode(draft.branch ?? ""), [draft.branch]);
  const mosOptions = useMemo(
    () =>
      code
        ? listMosForBranch(code).map((m) => ({
            value: m.code,
            label: `${m.code} — ${m.title}`,
            searchText: `${m.code} ${m.title}`.toLowerCase(),
          }))
        : [],
    [code],
  );
  const unitOptions = useMemo(
    () =>
      code
        ? listUnitsForBranch(code).map((u) => ({
            value: u.identifier,
            label: `${u.identifier} — ${u.name}`,
            searchText: `${u.identifier} ${u.name}`.toLowerCase(),
          }))
        : [],
    [code],
  );
  const matchedMos = useMemo(() => {
    if (!code || !draft.mosCode) return null;
    return findMosEntry(code, draft.mosCode);
  }, [code, draft.mosCode]);
  const unitHasPackage = useMemo(() => {
    if (!code || !draft.unit) return false;
    return hasUnitDoctrinePackage(code, draft.unit);
  }, [code, draft.unit]);

  return (
    <>
      <div className="col-span-3 sm:col-span-1">
        <label className="block text-[10px] font-mono uppercase tracking-wider text-muted-foreground mb-1.5">
          Branch
        </label>
        <select
          value={draft.branch ?? ""}
          onChange={(e) => onChangeBranch(e.target.value)}
          className="w-full px-3 py-2 rounded-md bg-background border border-border text-sm focus:border-primary focus:outline-none"
          data-testid="branch-select"
        >
          <option value="">— unset —</option>
          {BRANCHES.map((b) => (
            <option key={b} value={b}>
              {b}
            </option>
          ))}
        </select>
      </div>
      <div className="col-span-3 sm:col-span-1">
        <label className="block text-[10px] font-mono uppercase tracking-wider text-muted-foreground mb-1.5">
          MOS / Rate / AFSC
        </label>
        <Combobox
          value={draft.mosCode ?? ""}
          options={mosOptions}
          disabled={!code}
          placeholder={code ? "Type code or title…" : "Pick a branch first"}
          onChange={(v) => onChange("mosCode", v)}
          testId="mos-combobox"
        />
        {matchedMos && (
          <div
            className="text-[10px] text-emerald-400 mt-1 font-mono"
            data-testid="mos-matched-hint"
          >
            ✓ {matchedMos.title} — doctrine will auto-load
          </div>
        )}
      </div>
      <div className="col-span-3 sm:col-span-1">
        <label className="block text-[10px] font-mono uppercase tracking-wider text-muted-foreground mb-1.5">
          Unit
        </label>
        <Combobox
          value={draft.unit ?? ""}
          options={unitOptions}
          disabled={!code}
          allowFreeText
          placeholder={code ? "e.g. 3-187 IN" : "Pick a branch first"}
          onChange={(v) => onChange("unit", v)}
          testId="unit-combobox"
        />
        {unitHasPackage && (
          <div
            className="text-[10px] text-emerald-400 mt-1 font-mono"
            data-testid="unit-matched-hint"
          >
            ✓ Curated unit package — doctrine will auto-load
          </div>
        )}
      </div>
    </>
  );
}

interface ComboboxOption {
  value: string;
  label: string;
  searchText: string;
}

function Combobox({
  value,
  options,
  onChange,
  placeholder,
  disabled,
  allowFreeText,
  testId,
}: {
  value: string;
  options: ComboboxOption[];
  onChange: (value: string) => void;
  placeholder?: string;
  disabled?: boolean;
  /** When true, accepts free-text values not in the options list (units). */
  allowFreeText?: boolean;
  testId?: string;
}) {
  const [query, setQuery] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [activeIdx, setActiveIdx] = useState(0);
  const containerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // The displayed text is the user's in-progress query when typing, otherwise
  // the canonical value. We don't show the long " — title" suffix in the input
  // so it stays compact; the dropdown row provides the fuller label.
  const displayValue = query ?? value;

  // Filter options by code AND title. Empty query shows the first 50 to keep
  // the dropdown bounded.
  const filtered = useMemo(() => {
    const q = (query ?? "").trim().toLowerCase();
    const list = q
      ? options.filter((o) => o.searchText.includes(q))
      : options;
    return list.slice(0, 50);
  }, [query, options]);

  useEffect(() => {
    if (!open) return;
    function onClickOutside(e: MouseEvent) {
      if (
        containerRef.current &&
        !containerRef.current.contains(e.target as Node)
      ) {
        setOpen(false);
        setQuery(null);
      }
    }
    document.addEventListener("mousedown", onClickOutside);
    return () => document.removeEventListener("mousedown", onClickOutside);
  }, [open]);

  // Reset active row whenever the filter set changes so arrow-key nav doesn't
  // point at an out-of-range index after the user types another character.
  useEffect(() => {
    setActiveIdx(0);
  }, [query]);

  const commit = (next: string) => {
    onChange(next);
    setQuery(null);
    setOpen(false);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (disabled) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setOpen(true);
      setActiveIdx((i) => Math.min(filtered.length - 1, i + 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIdx((i) => Math.max(0, i - 1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const pick = filtered[activeIdx];
      if (pick) {
        commit(pick.value);
      } else if (allowFreeText) {
        commit((query ?? value).trim());
      }
    } else if (e.key === "Escape") {
      setOpen(false);
      setQuery(null);
    }
  };

  return (
    <div className="relative" ref={containerRef} data-testid={testId}>
      <input
        ref={inputRef}
        type="text"
        value={displayValue}
        onChange={(e) => {
          setQuery(e.target.value);
          setOpen(true);
          // For free-text fields (units) we propagate every keystroke so the
          // value persists even when the user doesn't pick a row. For
          // catalog-only fields (MOS) we wait for a row click or Enter to
          // commit, so partial typing doesn't write a junk MOS code.
          if (allowFreeText) onChange(e.target.value);
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => {
          // Defer so click-on-row fires first.
          setTimeout(() => {
            setOpen(false);
            // For MOS we may have typed something that doesn't match any
            // option. If the input is non-empty AND it exact-matches a code,
            // commit it; otherwise revert to the last committed value.
            if (!allowFreeText && query !== null) {
              const norm = query.trim().toLowerCase();
              const exact = options.find(
                (o) => o.value.toLowerCase() === norm,
              );
              if (exact) commit(exact.value);
              else setQuery(null);
            }
          }, 120);
        }}
        onKeyDown={onKeyDown}
        placeholder={placeholder}
        disabled={disabled}
        className="w-full px-3 py-2 rounded-md bg-background border border-border text-sm focus:border-primary focus:outline-none disabled:opacity-50"
        data-testid={testId ? `${testId}-input` : undefined}
        autoComplete="off"
      />
      {open && filtered.length > 0 && (
        <ul
          className="absolute z-20 mt-1 w-full max-h-64 overflow-y-auto rounded-md border border-border bg-popover shadow-lg"
          role="listbox"
          data-testid={testId ? `${testId}-list` : undefined}
        >
          {filtered.map((o, i) => (
            <li
              key={o.value}
              role="option"
              aria-selected={i === activeIdx}
              onMouseEnter={() => setActiveIdx(i)}
              onMouseDown={(e) => {
                // mousedown so we beat the input's onBlur
                e.preventDefault();
                commit(o.value);
              }}
              className={`px-3 py-1.5 text-xs cursor-pointer ${
                i === activeIdx
                  ? "bg-primary/15 text-foreground"
                  : "text-foreground/90"
              }`}
              data-testid={testId ? `${testId}-option-${o.value}` : undefined}
            >
              {o.label}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function IngestStatusPanel({ draft }: { draft: ProfileUpdate }) {
  const code = useMemo(() => branchCode(draft.branch ?? ""), [draft.branch]);
  const matchedMos = useMemo(() => {
    if (!code || !draft.mosCode) return null;
    return findMosEntry(code, draft.mosCode);
  }, [code, draft.mosCode]);
  const unitHasPackage = useMemo(() => {
    if (!code || !draft.unit) return false;
    return hasUnitDoctrinePackage(code, draft.unit);
  }, [code, draft.unit]);

  const sources: string[] = [];
  if (code && matchedMos) sources.push(buildMosAutoSource(code, matchedMos.code));
  if (code && unitHasPackage && draft.unit)
    sources.push(buildUnitAutoSource(code, draft.unit.trim()));

  if (sources.length === 0) return null;

  return (
    <div className="rounded-md border border-primary/30 bg-primary/5 p-4 space-y-3">
      <div className="text-[10px] font-mono uppercase tracking-wider text-primary">
        Auto-loaded doctrine
      </div>
      {sources.map((src) => (
        <IngestStatusRow key={src} source={src} />
      ))}
    </div>
  );
}

function IngestStatusRow({ source }: { source: string }) {
  const queryClient = useQueryClient();
  const { data } = useGetAutoIngestStatus(
    { source },
    {
      query: {
        queryKey: getGetAutoIngestStatusQueryKey({ source }),
        refetchInterval: (q) => {
          const j = q.state.data?.job;
          return j && j.status === "running" ? 1500 : false;
        },
      },
    },
  );
  const job = data?.job ?? null;

  // When a running job finishes, invalidate the documents list so the user
  // sees the new docs flow into their library without a manual refresh.
  const lastStatus = useRef<string | null>(null);
  useEffect(() => {
    if (!job) return;
    if (
      lastStatus.current === "running" &&
      job.status !== "running"
    ) {
      queryClient.invalidateQueries({ queryKey: getListDocumentsQueryKey() });
      queryClient.invalidateQueries({
        queryKey: getGetAutoIngestStatusQueryKey({ source }),
      });
    }
    lastStatus.current = job.status;
  }, [job, queryClient, source]);

  if (!job) {
    return (
      <div className="text-xs text-muted-foreground font-mono">
        {source} — queued
      </div>
    );
  }

  const verb =
    job.status === "running"
      ? "Pulling doctrine…"
      : job.status === "done"
        ? "Doctrine loaded"
        : "Failed";
  const verbColor =
    job.status === "running"
      ? "text-primary"
      : job.status === "done"
        ? "text-emerald-400"
        : "text-red-400";

  return (
    <div className="text-xs">
      <div className="flex items-center gap-2">
        <span className={`font-mono ${verbColor}`}>{verb}</span>
        <span className="text-muted-foreground font-mono">{source}</span>
      </div>
      <div className="text-muted-foreground mt-0.5">
        {job.addedCount} added · {job.existingCount} already in library ·{" "}
        {job.failedCount} failed · {job.totalCount} total
      </div>
      {job.errorMessage && (
        <div className="text-red-400 text-[11px] mt-0.5">
          {job.errorMessage}
        </div>
      )}
    </div>
  );
}

function profileToMarkdown(p: UserProfile): string {
  const dash = (v: string | null | undefined) =>
    v && v.trim() ? v.trim() : "—";
  const block = (v: string | null | undefined) =>
    v && v.trim() ? v.trim() : "—";

  const lines: string[] = [];
  lines.push("# Operator Profile");
  lines.push("");
  lines.push(`_Exported ${new Date().toISOString()}_`);
  lines.push("");
  lines.push(`**Completeness:** ${p.completenessPct}%`);
  lines.push("");

  lines.push("## Service info");
  lines.push("");
  lines.push(`- **Branch:** ${dash(p.branch)}`);
  lines.push(`- **Rank:** ${dash(p.rank)}`);
  lines.push(`- **MOS / Rate / AFSC:** ${dash(p.mosCode)}`);
  lines.push("");

  lines.push("## Duty");
  lines.push("");
  lines.push(`- **Duty title:** ${dash(p.dutyTitle)}`);
  lines.push(`- **Unit:** ${dash(p.unit)}`);
  lines.push(`- **Base / location:** ${dash(p.baseLocation)}`);
  lines.push("");

  lines.push("## Readiness & security");
  lines.push("");
  lines.push(`- **Clearance:** ${dash(p.securityClearance)}`);
  lines.push(`- **Deployment status:** ${dash(p.deploymentStatus)}`);
  lines.push("");

  lines.push("## Narrative");
  lines.push("");
  lines.push("### Primary mission");
  lines.push("");
  lines.push(block(p.primaryMission));
  lines.push("");
  lines.push("### Narrative context");
  lines.push("");
  lines.push(block(p.freeFormContext));
  lines.push("");

  lines.push("## AI use cases");
  lines.push("");
  if (!p.aiUseCases || p.aiUseCases.length === 0) {
    lines.push("—");
  } else {
    for (const uc of p.aiUseCases) lines.push(`- ${uc}`);
  }
  lines.push("");

  return lines.join("\n");
}

function profileToDraft(p: UserProfile): ProfileUpdate {
  return {
    branch: p.branch,
    rank: p.rank,
    mosCode: p.mosCode,
    dutyTitle: p.dutyTitle,
    unit: p.unit,
    baseLocation: p.baseLocation,
    securityClearance: p.securityClearance,
    deploymentStatus: p.deploymentStatus,
    primaryMission: p.primaryMission,
    aiUseCases: p.aiUseCases,
    freeFormContext: p.freeFormContext,
    launchPreference: p.launchPreference,
  };
}

function ChatPanel({
  onApply,
}: {
  onApply: (s: ProfileUpdate) => void;
}) {
  const queryClient = useQueryClient();
  const { data: history } = useGetProfileChatHistory();
  const sendMutation = useSendProfileChat();
  const resetMutation = useResetProfileChat();
  const [input, setInput] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);
  const [latestSuggestion, setLatestSuggestion] = useState<{
    messageId: string;
    suggestion: ProfileUpdate;
  } | null>(null);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [history]);

  const onSend = async (e: React.FormEvent) => {
    e.preventDefault();
    const text = input.trim();
    if (!text) return;
    setInput("");
    try {
      const resp = await sendMutation.mutateAsync({ data: { message: text } });
      queryClient.invalidateQueries({
        queryKey: getGetProfileChatHistoryQueryKey(),
      });
      if (resp.suggestedProfile) {
        setLatestSuggestion({
          messageId: crypto.randomUUID(),
          suggestion: resp.suggestedProfile,
        });
      }
    } catch (err) {
      console.error(err);
    }
  };

  const onReset = async () => {
    await resetMutation.mutateAsync();
    queryClient.invalidateQueries({
      queryKey: getGetProfileChatHistoryQueryKey(),
    });
    setLatestSuggestion(null);
  };

  const messages: ChatMessage[] = history ?? [];

  return (
    <section className="lg:col-span-2 bg-card border border-border rounded-md flex flex-col h-[640px]">
      <div className="px-5 py-4 border-b border-border flex items-center justify-between">
        <div>
          <div className="text-[10px] uppercase tracking-wider text-muted-foreground font-mono">
            Profile assistant
          </div>
          <div className="text-sm font-semibold mt-0.5">
            Conversational fill-in
          </div>
        </div>
        {messages.length > 0 && (
          <button
            onClick={onReset}
            className="text-[10px] font-mono uppercase tracking-wider text-muted-foreground hover:text-foreground"
          >
            Reset
          </button>
        )}
      </div>
      <div ref={scrollRef} className="flex-1 overflow-y-auto p-5 space-y-3">
        {messages.length === 0 && (
          <div className="text-sm text-muted-foreground py-8 text-center">
            Tell me about your role and mission. I'll suggest profile fields
            you can apply with one click.
          </div>
        )}
        {messages.map((m) => (
          <div
            key={m.id}
            className={`flex ${m.role === "user" ? "justify-end" : "justify-start"}`}
          >
            <div
              className={`max-w-[85%] rounded-md px-3 py-2 text-sm leading-relaxed ${
                m.role === "user"
                  ? "bg-primary/15 text-foreground border border-primary/30"
                  : "bg-background border border-border"
              }`}
            >
              <div className="whitespace-pre-wrap">{m.content}</div>
              <div className="text-[10px] text-muted-foreground font-mono mt-1.5">
                {formatDate(m.createdAt)}
              </div>
            </div>
          </div>
        ))}
        {latestSuggestion && (
          <div className="rounded-md border border-emerald-500/40 bg-emerald-500/5 p-3">
            <div className="text-[10px] font-mono uppercase tracking-wider text-emerald-300 mb-2">
              Suggested updates
            </div>
            <div className="text-xs space-y-0.5 mb-3 text-emerald-100/90">
              {Object.entries(latestSuggestion.suggestion).map(([k, v]) => {
                if (v == null || (Array.isArray(v) && v.length === 0))
                  return null;
                return (
                  <div key={k}>
                    <span className="text-emerald-400 font-mono">{k}:</span>{" "}
                    {Array.isArray(v) ? v.join(", ") : String(v)}
                  </div>
                );
              })}
            </div>
            <div className="flex gap-2">
              <button
                onClick={() => {
                  onApply(latestSuggestion.suggestion);
                  setLatestSuggestion(null);
                }}
                className="px-3 py-1.5 rounded bg-emerald-500/20 hover:bg-emerald-500/30 text-emerald-300 text-xs font-medium"
              >
                Apply suggestions
              </button>
              <button
                onClick={() => setLatestSuggestion(null)}
                className="px-3 py-1.5 rounded text-xs text-emerald-200/70 hover:text-emerald-200"
              >
                Dismiss
              </button>
            </div>
          </div>
        )}
        {sendMutation.isPending && (
          <div className="text-xs text-muted-foreground">Thinking…</div>
        )}
      </div>
      <form
        onSubmit={onSend}
        className="border-t border-border p-3 flex gap-2"
      >
        <input
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Tell me about your role…"
          className="flex-1 px-3 py-2 rounded-md bg-background border border-border text-sm focus:border-primary focus:outline-none"
        />
        <button
          type="submit"
          disabled={!input.trim() || sendMutation.isPending}
          className="px-4 py-2 rounded-md bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 disabled:opacity-50"
        >
          Send
        </button>
      </form>
    </section>
  );
}
