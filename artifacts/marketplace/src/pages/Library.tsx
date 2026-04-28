import { useEffect, useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useGetLibraryStats,
  useListDocuments,
  useUploadTextDocument,
  useGetDocument,
  useDeleteDocument,
  useTestLibraryQuery,
  useListMyPresets,
  useSetDocumentPresetTags,
  useRetryFailedDocument,
  requestUploadUrl,
  getGetLibraryStatsQueryKey,
  getListDocumentsQueryKey,
  getGetDocumentQueryKey,
  getListMyPresetsQueryKey,
} from "@workspace/api-client-react";
import type {
  DocumentSummary,
  MissionPreset,
} from "@workspace/api-client-react";
import { parseAutoSource, BRANCHES as MIL_BRANCHES } from "@workspace/mil-data";
import {
  PageContainer,
  StatCard,
  ErrorBox,
  EmptyState,
  formatDate,
  formatBytes,
  Pill,
} from "@/lib/format";

const ACCEPTED_EXT = ".pdf,.docx,.md,.markdown,.txt";
const MAX_BYTES = 25 * 1024 * 1024;

function inferMimeType(filename: string, declared: string): string {
  if (declared && declared !== "application/octet-stream") return declared;
  const ext = filename.toLowerCase().split(".").pop() ?? "";
  if (ext === "pdf") return "application/pdf";
  if (ext === "docx")
    return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
  if (ext === "md" || ext === "markdown") return "text/markdown";
  return "text/plain";
}

type UploadStage = "idle" | "requesting-url" | "uploading" | "registering";

function statusTone(
  status: string,
): "good" | "warn" | "destructive" | "neutral" {
  switch (status) {
    case "ready":
      return "good";
    case "failed":
      return "destructive";
    case "uploaded":
    case "processing":
      return "warn";
    default:
      return "neutral";
  }
}

function statusLabel(status: string): string {
  switch (status) {
    case "uploaded":
      return "uploaded · queued";
    case "processing":
      return "extracting…";
    case "ready":
      return "ready";
    case "failed":
      return "failed";
    default:
      return status;
  }
}

export function Library() {
  const queryClient = useQueryClient();
  const { data: stats } = useGetLibraryStats();

  // Poll the documents list while any document is still in a non-terminal
  // state so the user sees the status flip from "uploaded" to "processing"
  // to "ready"/"failed" without a manual refresh.
  const { data: docs, isLoading, error } = useListDocuments(undefined, {
    query: {
      queryKey: getListDocumentsQueryKey(),
      refetchInterval: (query) => {
        const list = query.state.data as
          | Array<{ status: string }>
          | undefined;
        if (!list) return false;
        const stillWorking = list.some(
          (d) => d.status === "uploaded" || d.status === "processing",
        );
        return stillWorking ? 1500 : false;
      },
    },
  });
  const { data: presets } = useListMyPresets({
    query: { queryKey: getListMyPresetsQueryKey(), retry: false },
  });
  const uploadMutation = useUploadTextDocument();
  const deleteMutation = useDeleteDocument();
  const testMutation = useTestLibraryQuery();
  const retryMutation = useRetryFailedDocument();

  const [showUpload, setShowUpload] = useState(false);
  const [uploadMode, setUploadMode] = useState<"file" | "paste">("file");
  // When set, the next upload will supersede this failed auto-doc instead of
  // creating a fresh entry. Carries title and preset tags through.
  const [supersedeTarget, setSupersedeTarget] = useState<{
    id: string;
    title: string;
    presetIds: string[];
  } | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [editingTagsId, setEditingTagsId] = useState<string | null>(null);
  const [activeOnly, setActiveOnly] = useState(false);
  const [sourceFilter, setSourceFilter] =
    useState<"all" | "uploaded" | "auto">("all");
  const [retryError, setRetryError] = useState<string | null>(null);

  const presetList: MissionPreset[] = presets ?? [];
  const activePreset = presetList.find((p) => p.isActive);

  // Filter the docs list locally — the user-facing buckets are uploaded vs.
  // auto-ingested. Counts drive the filter buttons so the UI is honest about
  // which sources actually exist. The "active preset only" toggle further
  // narrows the list to documents tagged into the active preset.
  const filteredDocs = useMemo<DocumentSummary[]>(() => {
    if (!docs) return [];
    let list = docs;
    if (sourceFilter === "uploaded") list = list.filter((d) => !d.autoSource);
    else if (sourceFilter === "auto") list = list.filter((d) => !!d.autoSource);
    if (activeOnly && activePreset) {
      const inScope = new Set(activePreset.documentIds);
      list = list.filter((d) => inScope.has(d.id));
    }
    return list;
  }, [docs, sourceFilter, activeOnly, activePreset]);
  const counts = useMemo(() => {
    const total = docs?.length ?? 0;
    const auto = docs?.filter((d) => !!d.autoSource).length ?? 0;
    return { total, auto, uploaded: total - auto };
  }, [docs]);
  const [form, setForm] = useState({
    title: "",
    sourceFilename: "",
    content: "",
  });
  const [pendingFile, setPendingFile] = useState<File | null>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [uploadStage, setUploadStage] = useState<UploadStage>("idle");
  const [uploadProgress, setUploadProgress] = useState<number>(0);

  // When polling flips a doc to "ready", refresh stats too so the header
  // counters stay accurate.
  useEffect(() => {
    if (!docs) return;
    queryClient.invalidateQueries({ queryKey: getGetLibraryStatsQueryKey() });
  }, [
    queryClient,
    // Recompute when any status changes
    useMemo(
      () => (docs ?? []).map((d) => `${d.id}:${d.status}`).join(","),
      [docs],
    ),
  ]);

  const [testQuery, setTestQuery] = useState("");
  const [testResults, setTestResults] = useState<{
    query: string;
    snippets: Array<{
      chunkId: string;
      documentId: string;
      documentTitle: string;
      chunkIndex: number;
      content: string;
      score: number;
    }>;
  } | null>(null);
  const [testError, setTestError] = useState<string | null>(null);

  const onPickFile = (file: File) => {
    setUploadError(null);
    if (file.size > MAX_BYTES) {
      setUploadError(
        `File is ${formatBytes(file.size)} — limit is ${formatBytes(MAX_BYTES)}.`,
      );
      return;
    }
    setPendingFile(file);
    setForm((f) => ({
      title: f.title || file.name.replace(/\.[^.]+$/, ""),
      sourceFilename: file.name,
      content: "",
    }));
  };

  // Two-step upload: request a presigned URL, PUT the file directly to GCS,
  // then register the document with the API. The browser uploads the bytes
  // straight to object storage so the API server never has to buffer big
  // PDFs/DOCX in memory.
  const uploadFileViaStorage = async (file: File): Promise<string> => {
    setUploadStage("requesting-url");
    const mimeType = inferMimeType(file.name, file.type);
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
              `Upload to storage failed (${xhr.status} ${xhr.statusText || ""})`,
            ),
          );
        }
      };
      xhr.onerror = () =>
        reject(new Error("Network error while uploading the file."));
      xhr.send(file);
    });

    return objectPath;
  };

  const onUpload = async (e: React.FormEvent) => {
    e.preventDefault();
    setUploadError(null);
    try {
      if (uploadMode === "file") {
        if (!pendingFile) {
          setUploadError("Choose a file first.");
          return;
        }
        const objectPath = await uploadFileViaStorage(pendingFile);

        setUploadStage("registering");
        await uploadMutation.mutateAsync({
          data: {
            title: form.title || pendingFile.name,
            sourceFilename: pendingFile.name,
            mimeType: inferMimeType(pendingFile.name, pendingFile.type),
            storageObjectPath: objectPath,
            sizeBytes: pendingFile.size,
            ...(supersedeTarget
              ? { replacesDocumentId: supersedeTarget.id }
              : {}),
          },
        });
      } else {
        if (!form.content.trim()) {
          setUploadError("Paste some text or switch to file upload.");
          return;
        }
        await uploadMutation.mutateAsync({
          data: {
            title: form.title,
            sourceFilename: form.sourceFilename || `${form.title}.txt`,
            mimeType: "text/plain",
            content: form.content,
            ...(supersedeTarget
              ? { replacesDocumentId: supersedeTarget.id }
              : {}),
          },
        });
      }
      setForm({ title: "", sourceFilename: "", content: "" });
      setPendingFile(null);
      setShowUpload(false);
      setSupersedeTarget(null);
      setUploadStage("idle");
      setUploadProgress(0);
      queryClient.invalidateQueries({ queryKey: getListDocumentsQueryKey() });
      queryClient.invalidateQueries({ queryKey: getGetLibraryStatsQueryKey() });
      queryClient.invalidateQueries({ queryKey: getListMyPresetsQueryKey() });
    } catch (err) {
      setUploadError(err instanceof Error ? err.message : "Upload failed");
      setUploadStage("idle");
      setUploadProgress(0);
    }
  };

  // Open the upload dialog pre-filled with a failed auto-doc's title and
  // preset tags. The next upload submit will pass `replacesDocumentId` so
  // the backend supersedes the failed row.
  const startSupersedeUpload = (doc: DocumentSummary) => {
    setSupersedeTarget({
      id: doc.id,
      title: doc.title,
      presetIds: doc.presetIds ?? [],
    });
    setUploadMode("file");
    setForm({
      title: doc.title,
      sourceFilename: "",
      content: "",
    });
    setPendingFile(null);
    setUploadError(null);
    setShowUpload(true);
  };

  const onRetryDoc = async (id: string) => {
    setRetryError(null);
    // Optimistically flip the row to "processing" so the user immediately
    // sees that the retry kicked off; this also re-engages the
    // refetchInterval poller (which only polls while at least one row is
    // uploaded/processing). The mutation runs synchronously on the server,
    // so this state is brief, but it removes the dead-air feeling between
    // click and terminal status.
    const queryKey = getListDocumentsQueryKey();
    queryClient.setQueryData<DocumentSummary[]>(queryKey, (prev) =>
      prev
        ? prev.map((d) =>
            d.id === id
              ? { ...d, status: "processing", errorMessage: null }
              : d,
          )
        : prev,
    );
    try {
      await retryMutation.mutateAsync({ id });
    } catch (err) {
      setRetryError(err instanceof Error ? err.message : "Retry failed");
    } finally {
      queryClient.invalidateQueries({ queryKey });
    }
  };

  const onDelete = async (id: string) => {
    if (!confirm("Delete this document?")) return;
    await deleteMutation.mutateAsync({ id });
    if (expandedId === id) setExpandedId(null);
    if (editingTagsId === id) setEditingTagsId(null);
    queryClient.invalidateQueries({ queryKey: getListDocumentsQueryKey() });
    queryClient.invalidateQueries({ queryKey: getGetLibraryStatsQueryKey() });
    queryClient.invalidateQueries({ queryKey: getListMyPresetsQueryKey() });
  };

  const onRunTestQuery = async (e: React.FormEvent) => {
    e.preventDefault();
    setTestError(null);
    if (!testQuery.trim()) return;
    try {
      const res = await testMutation.mutateAsync({
        data: { query: testQuery.trim(), limit: 6 },
      });
      setTestResults(res);
    } catch (err) {
      setTestError(err instanceof Error ? err.message : "Query failed");
    }
  };

  const submitDisabled =
    uploadMutation.isPending ||
    uploadStage === "requesting-url" ||
    uploadStage === "uploading" ||
    uploadStage === "registering";

  const submitLabel = (() => {
    switch (uploadStage) {
      case "requesting-url":
        return "Preparing upload…";
      case "uploading":
        return `Uploading… ${uploadProgress}%`;
      case "registering":
        return "Registering…";
      default:
        return uploadMutation.isPending ? "Uploading…" : "Upload & index";
    }
  })();

  return (
    <PageContainer>
      <div className="mb-8 flex items-end justify-between gap-6">
        <div>
          <div className="text-[10px] uppercase tracking-[0.25em] text-primary font-mono font-semibold mb-2">
            Knowledge Base
          </div>
          <h1 className="text-3xl font-semibold tracking-tight">
            Personal knowledge base
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            Every tool launch searches this library on your behalf.
          </p>
        </div>
        <button
          data-testid="button-toggle-upload"
          onClick={() => {
            setShowUpload((v) => {
              const next = !v;
              if (!next) setSupersedeTarget(null);
              return next;
            });
          }}
          className="h-10 px-5 rounded-md bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90"
        >
          {showUpload ? "Cancel" : "Add document"}
        </button>
      </div>

      <div className="mb-8 max-w-xs">
        <StatCard label="Documents" value={stats?.documentCount ?? "—"} />
      </div>

      {showUpload && (
        <form
          onSubmit={onUpload}
          className="bg-card border border-border rounded-md p-5 mb-6 space-y-3"
        >
          {supersedeTarget && (
            <div
              data-testid="supersede-banner"
              className="text-[11px] font-mono text-amber-300 bg-amber-500/10 border border-amber-500/30 rounded px-3 py-2"
            >
              Replacing failed auto-fetch:{" "}
              <span className="text-foreground">{supersedeTarget.title}</span>
              {" — "}
              the new file will inherit its tags and the failed row will be
              removed.
            </div>
          )}
          <div className="flex gap-2">
            <button
              type="button"
              data-testid="button-mode-file"
              onClick={() => {
                setUploadMode("file");
                setUploadError(null);
              }}
              className={`px-3 py-1.5 rounded text-[11px] font-mono uppercase tracking-wider ${
                uploadMode === "file"
                  ? "bg-primary/20 text-primary border border-primary/50"
                  : "bg-background text-muted-foreground border border-border hover:border-primary/30"
              }`}
            >
              Upload file
            </button>
            <button
              type="button"
              data-testid="button-mode-paste"
              onClick={() => {
                setUploadMode("paste");
                setPendingFile(null);
                setUploadError(null);
              }}
              className={`px-3 py-1.5 rounded text-[11px] font-mono uppercase tracking-wider ${
                uploadMode === "paste"
                  ? "bg-primary/20 text-primary border border-primary/50"
                  : "bg-background text-muted-foreground border border-border hover:border-primary/30"
              }`}
            >
              Paste text
            </button>
          </div>

          {uploadMode === "file" && (
            <div>
              <label className="block text-[10px] font-mono uppercase tracking-wider text-muted-foreground mb-1.5">
                File (PDF, DOCX, MD, TXT — max {formatBytes(MAX_BYTES)})
              </label>
              <input
                type="file"
                data-testid="input-file"
                accept={ACCEPTED_EXT}
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) onPickFile(f);
                }}
                className="block w-full text-sm text-foreground file:mr-3 file:px-3 file:py-2 file:rounded-md file:border-0 file:bg-primary/10 file:text-primary file:text-xs file:font-mono file:uppercase file:tracking-wider hover:file:bg-primary/20"
              />
              {pendingFile && (
                <div className="mt-2 text-[11px] text-muted-foreground font-mono">
                  Selected: {pendingFile.name} ·{" "}
                  {inferMimeType(pendingFile.name, pendingFile.type)} ·{" "}
                  {formatBytes(pendingFile.size)}
                </div>
              )}
              {(uploadStage === "uploading" ||
                uploadStage === "requesting-url") && (
                <div
                  className="mt-3"
                  data-testid="upload-progress"
                  aria-label="Upload progress"
                >
                  <div className="h-1.5 w-full bg-background border border-border rounded overflow-hidden">
                    <div
                      className="h-full bg-primary transition-all duration-150"
                      style={{ width: `${uploadProgress}%` }}
                    />
                  </div>
                  <div className="mt-1 text-[10px] font-mono uppercase tracking-wider text-muted-foreground">
                    {uploadStage === "requesting-url"
                      ? "Requesting upload URL…"
                      : `Uploading to storage… ${uploadProgress}%`}
                  </div>
                </div>
              )}
            </div>
          )}

          <div className="grid sm:grid-cols-2 gap-3">
            <div>
              <label className="block text-[10px] font-mono uppercase tracking-wider text-muted-foreground mb-1.5">
                Title (required)
              </label>
              <input
                type="text"
                data-testid="input-title"
                required
                value={form.title}
                onChange={(e) => setForm({ ...form, title: e.target.value })}
                placeholder="3-187 IN OPORD 25-04"
                className="w-full px-3 py-2 rounded-md bg-background border border-border text-sm focus:border-primary focus:outline-none"
              />
            </div>
            {uploadMode === "paste" && (
              <div>
                <label className="block text-[10px] font-mono uppercase tracking-wider text-muted-foreground mb-1.5">
                  Source filename
                </label>
                <input
                  type="text"
                  value={form.sourceFilename}
                  onChange={(e) =>
                    setForm({ ...form, sourceFilename: e.target.value })
                  }
                  placeholder="opord_25-04.txt"
                  className="w-full px-3 py-2 rounded-md bg-background border border-border text-sm focus:border-primary focus:outline-none"
                />
              </div>
            )}
          </div>

          {uploadMode === "paste" && (
            <div>
              <label className="block text-[10px] font-mono uppercase tracking-wider text-muted-foreground mb-1.5">
                Content (required, plain text)
              </label>
              <textarea
                data-testid="textarea-content"
                required
                value={form.content}
                onChange={(e) => setForm({ ...form, content: e.target.value })}
                rows={10}
                placeholder="Paste document text here…"
                className="w-full px-3 py-2 rounded-md bg-background border border-border text-sm focus:border-primary focus:outline-none font-mono"
              />
            </div>
          )}

          {activePreset && !supersedeTarget && (
            <div className="text-[11px] font-mono text-muted-foreground">
              New uploads are auto-tagged into the active preset:{" "}
              <span className="text-primary">{activePreset.name}</span>. You
              can adjust tags after upload.
            </div>
          )}
          {uploadError && <ErrorBox>{uploadError}</ErrorBox>}
          <div className="flex justify-end">
            <button
              type="submit"
              data-testid="button-upload-submit"
              disabled={submitDisabled}
              className="h-10 px-5 rounded-md bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 disabled:opacity-50"
            >
              {submitLabel}
            </button>
          </div>
        </form>
      )}

      {error && <ErrorBox>{(error as Error).message}</ErrorBox>}

      {isLoading ? (
        <div className="space-y-2">
          {Array.from({ length: 3 }).map((_, i) => (
            <div
              key={i}
              className="bg-card border border-border rounded-md h-16 animate-pulse"
            />
          ))}
        </div>
      ) : !docs || docs.length === 0 ? (
        <EmptyState
          title="Your library is empty"
          description="Upload SOPs, mission briefs, TTPs, or study materials. Tools you launch will receive matching snippets automatically."
          action={
            <button
              onClick={() => setShowUpload(true)}
              className="h-9 px-4 rounded-md bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90"
            >
              Add your first document
            </button>
          }
        />
      ) : (
        <>
          <div className="flex items-center gap-2 mb-3 flex-wrap">
            <FilterChip
              active={sourceFilter === "all"}
              onClick={() => setSourceFilter("all")}
              label={`All (${counts.total})`}
              testId="filter-all"
            />
            <FilterChip
              active={sourceFilter === "uploaded"}
              onClick={() => setSourceFilter("uploaded")}
              label={`Uploaded (${counts.uploaded})`}
              testId="filter-uploaded"
            />
            <FilterChip
              active={sourceFilter === "auto"}
              onClick={() => setSourceFilter("auto")}
              label={`Auto-ingested (${counts.auto})`}
              testId="filter-auto"
            />
            {presetList.length > 0 && (
              <label className="ml-auto flex items-center gap-2 text-xs text-muted-foreground cursor-pointer">
                <input
                  type="checkbox"
                  data-testid="filter-active-preset-only"
                  checked={activeOnly}
                  onChange={(e) => setActiveOnly(e.target.checked)}
                />
                Show only documents in active preset
                {activePreset && (
                  <span className="text-primary font-mono">
                    ({activePreset.name})
                  </span>
                )}
              </label>
            )}
          </div>
          <div className="space-y-2">
            {filteredDocs.length === 0 ? (
              <div className="text-sm text-muted-foreground italic px-1 py-4">
                No documents match this filter.
              </div>
            ) : (
              filteredDocs.map((d) => (
                <div
                  key={d.id}
                  data-testid={`doc-row-${d.id}`}
                  className="bg-card border border-border rounded-md overflow-hidden"
                >
                  <div
                    className="px-5 py-4 flex items-center justify-between gap-4 cursor-pointer hover:bg-accent/30"
                    onClick={() =>
                      setExpandedId(expandedId === d.id ? null : d.id)
                    }
                  >
                    <div className="min-w-0">
                      <div className="font-medium text-sm flex items-center gap-2 flex-wrap">
                        <span>{d.title}</span>
                        <AutoSourceBadge autoSource={d.autoSource} />
                      </div>
                      <div className="text-[11px] text-muted-foreground font-mono mt-0.5">
                        {d.sourceFilename} · uploaded {formatDate(d.uploadedAt)}
                        {d.sourceUrl && (
                          <>
                            {" · "}
                            <a
                              href={d.sourceUrl}
                              target="_blank"
                              rel="noopener noreferrer"
                              onClick={(e) => e.stopPropagation()}
                              className="underline hover:text-foreground"
                            >
                              source
                            </a>
                          </>
                        )}
                      </div>
                      {presetList.length > 0 &&
                        (d.presetIds ?? []).length > 0 && (
                          <div className="mt-1.5 flex flex-wrap gap-1">
                            {(d.presetIds ?? []).map((pid) => {
                              const p = presetList.find((x) => x.id === pid);
                              if (!p) return null;
                              return (
                                <span
                                  key={pid}
                                  className={`text-[10px] font-mono px-1.5 py-0.5 rounded border ${
                                    p.isActive
                                      ? "border-primary/40 bg-primary/10 text-primary"
                                      : "border-border text-muted-foreground"
                                  }`}
                                >
                                  {p.name}
                                </span>
                              );
                            })}
                          </div>
                        )}
                    </div>
                    <div className="flex items-center gap-3 shrink-0">
                      <span data-testid={`doc-status-${d.id}`}>
                        <Pill tone={statusTone(d.status)}>
                          {statusLabel(d.status)}
                        </Pill>
                      </span>
                      {presetList.length > 0 && (
                        <button
                          data-testid={`button-tags-${d.id}`}
                          onClick={(e) => {
                            e.stopPropagation();
                            setEditingTagsId(
                              editingTagsId === d.id ? null : d.id,
                            );
                          }}
                          className="text-[11px] uppercase tracking-wider font-mono text-muted-foreground hover:text-foreground"
                        >
                          Tags
                        </button>
                      )}
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          onDelete(d.id);
                        }}
                        className="text-[11px] uppercase tracking-wider font-mono text-muted-foreground hover:text-rose-400"
                      >
                        Delete
                      </button>
                    </div>
                  </div>
                  {d.status === "failed" && (
                    <FailedDocBanner
                      doc={d}
                      isRetrying={
                        retryMutation.isPending &&
                        retryMutation.variables?.id === d.id
                      }
                      retryError={
                        retryMutation.variables?.id === d.id
                          ? retryError
                          : null
                      }
                      onRetry={() => onRetryDoc(d.id)}
                      onSupersede={() => startSupersedeUpload(d)}
                    />
                  )}
                  {editingTagsId === d.id && (
                    <PresetTagEditor
                      doc={d}
                      presets={presetList}
                      onClose={() => setEditingTagsId(null)}
                    />
                  )}
                  {expandedId === d.id && d.status === "ready" && (
                    <DocChunks documentId={d.id} />
                  )}
                  {expandedId === d.id &&
                    (d.status === "uploaded" ||
                      d.status === "processing") && (
                      <div className="border-t border-border p-5 text-xs text-muted-foreground">
                        Indexing in progress — chunks will appear when
                        extraction finishes.
                      </div>
                    )}
                </div>
              ))
            )}
          </div>

          <div className="mt-10 bg-card border border-border rounded-md p-5">
            <div className="text-[10px] uppercase tracking-[0.25em] text-primary font-mono font-semibold mb-2">
              Test your library
            </div>
            <h2 className="text-base font-medium tracking-tight mb-1">
              Run a sample retrieval query
            </h2>
            <p className="text-xs text-muted-foreground mb-3">
              Verify your library returns useful snippets before trusting it
              with a tool launch. Queries run against the same Postgres
              full-text index your tools see.
            </p>
            <form onSubmit={onRunTestQuery} className="flex gap-2 mb-3">
              <input
                type="text"
                data-testid="input-test-query"
                value={testQuery}
                onChange={(e) => setTestQuery(e.target.value)}
                placeholder="e.g. air assault checklist, OPORD service support"
                className="flex-1 px-3 py-2 rounded-md bg-background border border-border text-sm focus:border-primary focus:outline-none"
              />
              <button
                type="submit"
                data-testid="button-run-test-query"
                disabled={testMutation.isPending || !testQuery.trim()}
                className="h-10 px-5 rounded-md bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 disabled:opacity-50"
              >
                {testMutation.isPending ? "Searching…" : "Search"}
              </button>
            </form>
            {testError && <ErrorBox>{testError}</ErrorBox>}
            {testResults && (
              <div
                className="space-y-2 mt-3"
                data-testid="test-query-results"
              >
                <div className="text-[11px] font-mono uppercase tracking-wider text-muted-foreground">
                  {testResults.snippets.length === 0
                    ? "No matching snippets"
                    : `${testResults.snippets.length} snippet${testResults.snippets.length === 1 ? "" : "s"}`}
                  {" · query: "}
                  <span className="text-foreground">"{testResults.query}"</span>
                </div>
                {testResults.snippets.map((s) => (
                  <div
                    key={s.chunkId}
                    className="border border-border rounded p-3 bg-background text-xs"
                  >
                    <div className="flex items-center justify-between mb-1.5">
                      <div className="text-[10px] font-mono uppercase tracking-wider text-muted-foreground">
                        {s.documentTitle} · chunk #{s.chunkIndex}
                      </div>
                      <Pill tone="neutral">score {s.score.toFixed(3)}</Pill>
                    </div>
                    <div className="whitespace-pre-wrap font-mono text-foreground/90 leading-relaxed line-clamp-6">
                      {s.content}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </>
      )}
    </PageContainer>
  );
}

function FailedDocBanner({
  doc,
  isRetrying,
  retryError,
  onRetry,
  onSupersede,
}: {
  doc: DocumentSummary;
  isRetrying: boolean;
  retryError: string | null;
  onRetry: () => void;
  onSupersede: () => void;
}) {
  const isAuto = !!doc.autoSource && !!doc.sourceUrl;
  // Anything that's failed and isn't an auto-ingest row must be a
  // user-uploaded file (paste-text uploads can't fail asynchronously —
  // they 400 inline before a row is ever created).
  const isUploaded = !isAuto;
  const retryCount = doc.retryCount ?? 0;

  // Auto-ingest banner (Task #52): one in-place retry, then prompt the
  // user to upload the file manually.
  const showAutoRetry = isAuto && retryCount === 0;
  const showAutoSupersede = isAuto && retryCount >= 1;

  // Uploaded-doc banner (this task): up to two in-place retries against
  // the already-uploaded blob, then prompt the user to delete + re-upload
  // the file from scratch (matches the server cap in MAX_UPLOAD_RETRIES).
  const showUploadRetry = isUploaded && retryCount < 2;
  const showUploadGiveUp = isUploaded && retryCount >= 2;

  return (
    <div
      className="border-t border-border bg-rose-500/10 px-5 py-3 text-xs text-rose-300 space-y-2"
      data-testid={`doc-error-${doc.id}`}
    >
      <div>
        <span className="font-mono uppercase tracking-wider text-[10px] mr-2">
          Extraction failed:
        </span>
        {doc.errorMessage ?? "Unknown error"}
      </div>
      {showAutoSupersede && (
        <div className="text-rose-200/90">
          The automatic fetch did not work twice. Open the source document
          and upload it manually below.
        </div>
      )}
      {showUploadGiveUp && (
        <div
          className="text-rose-200/90"
          data-testid={`doc-reupload-prompt-${doc.id}`}
        >
          We couldn't extract this file after two retries. Delete it and
          upload the file again — it may be corrupt, password-protected, or
          a scanned-image PDF.
        </div>
      )}
      {retryError && (
        <div
          className="text-rose-200 font-mono text-[11px]"
          data-testid={`doc-retry-error-${doc.id}`}
        >
          Retry failed: {retryError}
        </div>
      )}
      <div className="flex flex-wrap gap-2 pt-1">
        {(showAutoRetry || showUploadRetry) && (
          <button
            type="button"
            data-testid={`button-retry-${doc.id}`}
            onClick={(e) => {
              e.stopPropagation();
              onRetry();
            }}
            disabled={isRetrying}
            className="text-[11px] font-mono uppercase tracking-wider px-3 py-1.5 rounded border border-rose-400/40 bg-rose-500/15 text-rose-100 hover:bg-rose-500/25 disabled:opacity-50"
          >
            {isRetrying
              ? "Retrying…"
              : showUploadRetry && retryCount > 0
                ? "Retry again"
                : "Retry"}
          </button>
        )}
        {showAutoSupersede && (
          <>
            {doc.sourceUrl && (
              <a
                data-testid={`link-open-source-${doc.id}`}
                href={doc.sourceUrl}
                target="_blank"
                rel="noopener noreferrer"
                onClick={(e) => e.stopPropagation()}
                className="text-[11px] font-mono uppercase tracking-wider px-3 py-1.5 rounded border border-rose-400/40 bg-rose-500/10 text-rose-100 hover:bg-rose-500/20"
              >
                Open source
              </a>
            )}
            <button
              type="button"
              data-testid={`button-supersede-${doc.id}`}
              onClick={(e) => {
                e.stopPropagation();
                onSupersede();
              }}
              className="text-[11px] font-mono uppercase tracking-wider px-3 py-1.5 rounded bg-primary text-primary-foreground hover:bg-primary/90"
            >
              Upload manually
            </button>
          </>
        )}
      </div>
    </div>
  );
}

function FilterChip({
  active,
  onClick,
  label,
  testId,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  testId?: string;
}) {
  return (
    <button
      data-testid={testId}
      onClick={onClick}
      className={`px-3 py-1.5 rounded text-[11px] font-mono uppercase tracking-wider border ${
        active
          ? "bg-primary/20 text-primary border-primary/50"
          : "bg-background text-muted-foreground border-border hover:border-primary/30"
      }`}
    >
      {label}
    </button>
  );
}

function AutoSourceBadge({
  autoSource,
}: {
  autoSource: string | null | undefined;
}) {
  if (!autoSource) return null;
  const parsed = parseAutoSource(autoSource);
  if (!parsed) {
    return (
      <span
        data-testid="badge-auto"
        className="text-[10px] font-mono uppercase tracking-wider px-1.5 py-0.5 rounded bg-emerald-500/15 text-emerald-300 border border-emerald-500/30"
        title={autoSource}
      >
        Auto
      </span>
    );
  }
  const branchLabel =
    MIL_BRANCHES.find((b) => b.code === parsed.branchCode)?.label ??
    parsed.branchCode;
  const kindLabel = parsed.kind === "mos" ? "MOS" : "Unit";
  return (
    <span
      data-testid="badge-auto"
      className="text-[10px] font-mono uppercase tracking-wider px-1.5 py-0.5 rounded bg-emerald-500/15 text-emerald-300 border border-emerald-500/30"
      title={autoSource}
    >
      Auto · {branchLabel} {kindLabel} {parsed.identifier}
    </span>
  );
}

function PresetTagEditor({
  doc,
  presets,
  onClose,
}: {
  doc: DocumentSummary;
  presets: MissionPreset[];
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const setTags = useSetDocumentPresetTags();
  const [selected, setSelected] = useState<string[]>(doc.presetIds ?? []);
  const [error, setError] = useState<string | null>(null);

  const onSave = async () => {
    setError(null);
    try {
      await setTags.mutateAsync({
        id: doc.id,
        data: { presetIds: selected },
      });
      queryClient.invalidateQueries({ queryKey: getListDocumentsQueryKey() });
      queryClient.invalidateQueries({ queryKey: getListMyPresetsQueryKey() });
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Save failed");
    }
  };

  return (
    <div className="border-t border-border bg-background/50 p-5">
      <div className="text-[10px] font-mono uppercase tracking-wider text-muted-foreground mb-3">
        Tag this document into presets
      </div>
      {presets.length === 0 ? (
        <div className="text-xs text-muted-foreground italic">
          You don't have any presets yet.
        </div>
      ) : (
        <div className="grid sm:grid-cols-2 gap-1.5 mb-3">
          {presets.map((p) => (
            <label
              key={p.id}
              className="flex items-center gap-2 text-sm cursor-pointer hover:bg-accent/30 px-2 py-1 rounded"
            >
              <input
                type="checkbox"
                checked={selected.includes(p.id)}
                onChange={(e) => {
                  if (e.target.checked) {
                    setSelected([...selected, p.id]);
                  } else {
                    setSelected(selected.filter((x) => x !== p.id));
                  }
                }}
              />
              <span>{p.name}</span>
              {p.isActive && (
                <span className="text-[9px] font-mono uppercase tracking-wider text-primary">
                  active
                </span>
              )}
            </label>
          ))}
        </div>
      )}
      {error && <ErrorBox>{error}</ErrorBox>}
      <div className="flex gap-2 justify-end">
        <button
          onClick={onClose}
          className="text-[11px] font-mono uppercase tracking-wider text-muted-foreground hover:text-foreground px-2.5 py-1"
        >
          Cancel
        </button>
        <button
          onClick={onSave}
          disabled={setTags.isPending}
          className="text-[11px] font-medium px-3 py-1.5 rounded bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
        >
          {setTags.isPending ? "Saving…" : "Save tags"}
        </button>
      </div>
    </div>
  );
}

function DocChunks({ documentId }: { documentId: string }) {
  const { data, isLoading } = useGetDocument(documentId, {
    query: {
      enabled: !!documentId,
      queryKey: getGetDocumentQueryKey(documentId),
    },
  });
  if (isLoading) {
    return (
      <div className="border-t border-border p-5 text-xs text-muted-foreground">
        Loading chunks…
      </div>
    );
  }
  if (!data) return null;
  return (
    <div className="border-t border-border bg-background/50 p-5 space-y-3">
      <div className="text-[10px] font-mono uppercase tracking-wider text-muted-foreground">
        Indexed chunks ({data.chunks.length})
      </div>
      {data.chunks.length === 0 ? (
        <div className="text-xs text-muted-foreground italic">
          No chunks indexed yet.
        </div>
      ) : (
        data.chunks.map((c) => (
          <div
            key={c.id}
            className="border border-border rounded p-3 bg-card text-xs"
          >
            <div className="text-[10px] font-mono uppercase tracking-wider text-muted-foreground mb-1.5">
              chunk #{c.chunkIndex} · {c.charCount} chars
            </div>
            <div className="whitespace-pre-wrap font-mono text-foreground/90 leading-relaxed">
              {c.content}
            </div>
          </div>
        ))
      )}
    </div>
  );
}
