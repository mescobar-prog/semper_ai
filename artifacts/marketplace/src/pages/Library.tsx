import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useGetLibraryStats,
  useListDocuments,
  useUploadTextDocument,
  useGetDocument,
  useDeleteDocument,
  getGetLibraryStatsQueryKey,
  getListDocumentsQueryKey,
  getGetDocumentQueryKey,
} from "@workspace/api-client-react";
import {
  PageContainer,
  StatCard,
  ErrorBox,
  EmptyState,
  formatDate,
  formatBytes,
  Pill,
} from "@/lib/format";

export function Library() {
  const queryClient = useQueryClient();
  const { data: stats } = useGetLibraryStats();
  const { data: docs, isLoading, error } = useListDocuments();
  const uploadMutation = useUploadTextDocument();
  const deleteMutation = useDeleteDocument();

  const [showUpload, setShowUpload] = useState(false);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [form, setForm] = useState({
    title: "",
    sourceFilename: "",
    content: "",
  });
  const [uploadError, setUploadError] = useState<string | null>(null);

  const onUpload = async (e: React.FormEvent) => {
    e.preventDefault();
    setUploadError(null);
    try {
      await uploadMutation.mutateAsync({
        data: {
          title: form.title,
          sourceFilename: form.sourceFilename || `${form.title}.txt`,
          mimeType: "text/plain",
          content: form.content,
        },
      });
      setForm({ title: "", sourceFilename: "", content: "" });
      setShowUpload(false);
      queryClient.invalidateQueries({ queryKey: getListDocumentsQueryKey() });
      queryClient.invalidateQueries({ queryKey: getGetLibraryStatsQueryKey() });
    } catch (err) {
      setUploadError(err instanceof Error ? err.message : "Upload failed");
    }
  };

  const onDelete = async (id: string) => {
    if (!confirm("Delete this document?")) return;
    await deleteMutation.mutateAsync({ id });
    if (expandedId === id) setExpandedId(null);
    queryClient.invalidateQueries({ queryKey: getListDocumentsQueryKey() });
    queryClient.invalidateQueries({ queryKey: getGetLibraryStatsQueryKey() });
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
          <div className="grid sm:grid-cols-2 gap-3">
            <div>
              <label className="block text-[10px] font-mono uppercase tracking-wider text-muted-foreground mb-1.5">
                Title (required)
              </label>
              <input
                type="text"
                required
                value={form.title}
                onChange={(e) => setForm({ ...form, title: e.target.value })}
                placeholder="3-187 IN OPORD 25-04"
                className="w-full px-3 py-2 rounded-md bg-background border border-border text-sm focus:border-primary focus:outline-none"
              />
            </div>
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
          </div>
          <div>
            <label className="block text-[10px] font-mono uppercase tracking-wider text-muted-foreground mb-1.5">
              Content (required, plain text)
            </label>
            <textarea
              required
              value={form.content}
              onChange={(e) => setForm({ ...form, content: e.target.value })}
              rows={10}
              placeholder="Paste document text here…"
              className="w-full px-3 py-2 rounded-md bg-background border border-border text-sm focus:border-primary focus:outline-none font-mono"
            />
          </div>
          {uploadError && <ErrorBox>{uploadError}</ErrorBox>}
          <div className="flex justify-end">
            <button
              type="submit"
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
        <div className="space-y-2">
          {docs.map((d) => (
            <div
              key={d.id}
              className="bg-card border border-border rounded-md overflow-hidden"
            >
              <div
                className="px-5 py-4 flex items-center justify-between gap-4 cursor-pointer hover:bg-accent/30"
                onClick={() =>
                  setExpandedId(expandedId === d.id ? null : d.id)
                }
              >
                <div className="min-w-0">
                  <div className="font-medium text-sm">{d.title}</div>
                  <div className="text-[11px] text-muted-foreground font-mono mt-0.5">
                    {d.sourceFilename} · uploaded {formatDate(d.uploadedAt)}
                  </div>
                </div>
                <div className="flex items-center gap-3 shrink-0">
                  <Pill tone="neutral">{d.chunkCount} chunks</Pill>
                  <span className="text-[11px] font-mono text-muted-foreground">
                    {formatBytes(d.charCount)}
                  </span>
                  <Pill
                    tone={d.status === "ready" ? "good" : "warn"}
                  >
                    {d.status}
                  </Pill>
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
              {expandedId === d.id && <DocChunks documentId={d.id} />}
            </div>
          ))}
        </div>
      )}
    </PageContainer>
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
