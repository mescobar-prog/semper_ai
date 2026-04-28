import { useMemo, useState } from "react";
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

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  const chunkSize = 0x8000; // avoid call-stack overflow on big PDFs
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const slice = bytes.subarray(i, i + chunkSize);
    binary += String.fromCharCode(...slice);
  }
  return btoa(binary);
}

export function Library() {
  const queryClient = useQueryClient();
  const { data: stats } = useGetLibraryStats();
  const { data: docs, isLoading, error } = useListDocuments();
  const { data: presets } = useListMyPresets({
    query: { queryKey: getListMyPresetsQueryKey(), retry: false },
  });
  const uploadMutation = useUploadTextDocument();
  const deleteMutation = useDeleteDocument();
  const testMutation = useTestLibraryQuery();

  const [showUpload, setShowUpload] = useState(false);
  const [uploadMode, setUploadMode] = useState<"file" | "paste">("file");
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [editingTagsId, setEditingTagsId] = useState<string | null>(null);
  const [activeOnly, setActiveOnly] = useState(false);
  const [sourceFilter, setSourceFilter] =
    useState<"all" | "uploaded" | "auto">("all");

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
  const [pendingFile, setPendingFile] = useState<{
    filename: string;
    mimeType: string;
    sizeBytes: number;
    contentBase64: string;
  } | null>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);

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

  const onPickFile = async (file: File) => {
    setUploadError(null);
    if (file.size > MAX_BYTES) {
      setUploadError(
        `File is ${formatBytes(file.size)} — limit is ${formatBytes(MAX_BYTES)}.`,
      );
      return;
    }
    const buffer = await file.arrayBuffer();
    const contentBase64 = arrayBufferToBase64(buffer);
    setPendingFile({
      filename: file.name,
      mimeType: inferMimeType(file.name, file.type),
      sizeBytes: file.size,
      contentBase64,
    });
    setForm((f) => ({
      title: f.title || file.name.replace(/\.[^.]+$/, ""),
      sourceFilename: file.name,
      content: "",
    }));
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
        await uploadMutation.mutateAsync({
          data: {
            title: form.title || pendingFile.filename,
            sourceFilename: pendingFile.filename,
            mimeType: pendingFile.mimeType,
            contentBase64: pendingFile.contentBase64,
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
          },
        });
      }
      setForm({ title: "", sourceFilename: "", content: "" });
      setPendingFile(null);
      setShowUpload(false);
      queryClient.invalidateQueries({ queryKey: getListDocumentsQueryKey() });
      queryClient.invalidateQueries({ queryKey: getGetLibraryStatsQueryKey() });
      queryClient.invalidateQueries({ queryKey: getListMyPresetsQueryKey() });
    } catch (err) {
      setUploadError(err instanceof Error ? err.message : "Upload failed");
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

  return (
    <PageContainer>
      <div className="mb-8 flex items-end justify-between gap-6">
        <div>
          <div className="text-[10px] uppercase tracking-[0.25em] text-primary font-mono font-semibold mb-2">
            RAG Library
          </div>
          <h1 className="text-3xl font-semibold tracking-tight">
            Personal knowledge base
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            Documents are chunked and full-text indexed. Every tool launch
            queries this library on your behalf.
          </p>
        </div>
        <button
          data-testid="button-toggle-upload"
          onClick={() => setShowUpload((v) => !v)}
          className="h-10 px-5 rounded-md bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90"
        >
          {showUpload ? "Cancel" : "Add document"}
        </button>
      </div>

      <div className="grid grid-cols-3 gap-4 mb-8">
        <StatCard label="Documents" value={stats?.documentCount ?? "—"} />
        <StatCard
          label="Indexed chunks"
          value={stats?.chunkCount.toLocaleString() ?? "—"}
        />
        <StatCard
          label="Total content"
          value={stats ? formatBytes(stats.totalChars) : "—"}
        />
      </div>

      {showUpload && (
        <form
          onSubmit={onUpload}
          className="bg-card border border-border rounded-md p-5 mb-6 space-y-3"
        >
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
                  Loaded: {pendingFile.filename} · {pendingFile.mimeType} ·{" "}
                  {formatBytes(pendingFile.sizeBytes)}
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

          {activePreset && (
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
              disabled={uploadMutation.isPending}
              className="h-10 px-5 rounded-md bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 disabled:opacity-50"
            >
              {uploadMutation.isPending ? "Uploading…" : "Upload & index"}
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
                      {presetList.length > 0 && (
                        <div className="mt-1.5 flex flex-wrap gap-1">
                          {(d.presetIds ?? []).length === 0 ? (
                            <span className="text-[10px] font-mono text-rose-400/80 uppercase tracking-wider">
                              Untagged · not in any preset
                            </span>
                          ) : (
                            (d.presetIds ?? []).map((pid) => {
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
                            })
                          )}
                        </div>
                      )}
                    </div>
                    <div className="flex items-center gap-3 shrink-0">
                      <Pill tone="neutral">{d.chunkCount} chunks</Pill>
                      <span className="text-[11px] font-mono text-muted-foreground">
                        {formatBytes(d.charCount)}
                      </span>
                      <Pill tone={d.status === "ready" ? "good" : "warn"}>
                        {d.status}
                      </Pill>
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
                  {editingTagsId === d.id && (
                    <PresetTagEditor
                      doc={d}
                      presets={presetList}
                      onClose={() => setEditingTagsId(null)}
                    />
                  )}
                  {expandedId === d.id && <DocChunks documentId={d.id} />}
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
