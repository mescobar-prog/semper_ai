import { Link } from "wouter";
import {
  useListRecentLaunches,
  type LaunchHistoryItem,
} from "@workspace/api-client-react";
import {
  PageContainer,
  ErrorBox,
  EmptyState,
  formatDate,
  Pill,
} from "@/lib/format";

export function Launches() {
  const { data, isLoading, error } = useListRecentLaunches();
  return (
    <PageContainer>
      <div className="mb-8">
        <div className="text-[10px] uppercase tracking-[0.25em] text-primary font-mono font-semibold mb-2">
          Launch History
        </div>
        <h1 className="text-3xl font-semibold tracking-tight">
          Recent activity
        </h1>
        <p className="text-sm text-muted-foreground mt-1">
          Every launch records exactly which profile fields and library
          snippets were sent to the tool, so you can audit past sessions.
        </p>
      </div>

      {error && <ErrorBox>{(error as Error).message}</ErrorBox>}

      {isLoading ? (
        <div className="space-y-2">
          {Array.from({ length: 4 }).map((_, i) => (
            <div
              key={i}
              className="bg-card border border-border rounded-md h-24 animate-pulse"
            />
          ))}
        </div>
      ) : !data || data.length === 0 ? (
        <EmptyState
          title="No launches yet"
          description="Browse the catalog and launch a tool. The marketplace mints a token, attaches your context, and opens the tool in a new tab."
          action={
            <Link
              href="/catalog"
              className="inline-flex h-9 items-center px-4 rounded-md bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90"
            >
              Browse catalog
            </Link>
          }
        />
      ) : (
        <ul className="space-y-3">
          {data.map((l) => (
            <LaunchRow key={l.id} launch={l} />
          ))}
        </ul>
      )}
    </PageContainer>
  );
}

const FIELD_LABELS: Record<string, string> = {
  branch: "Branch",
  rank: "Rank",
  mosCode: "MOS / Rate / AFSC",
  dutyTitle: "Duty title",
  unit: "Unit",
  baseLocation: "Base / location",
  securityClearance: "Security clearance",
  deploymentStatus: "Deployment status",
  primaryMission: "Primary mission",
  aiUseCases: "AI use cases",
  freeFormContext: "Free-form context",
};

function LaunchRow({ launch: l }: { launch: LaunchHistoryItem }) {
  const fields = l.sharedFieldKeys ?? [];
  const snippets = l.sharedSnippets ?? [];
  return (
    <li className="bg-card border border-border rounded-md">
      <div className="flex items-center justify-between gap-3 px-5 py-3 border-b border-border">
        <div className="min-w-0 flex-1">
          <Link
            href={`/catalog/${l.toolSlug}`}
            className="font-medium hover:text-primary"
          >
            {l.toolName}
          </Link>
          <div className="text-[11px] text-muted-foreground font-mono mt-0.5">
            {formatDate(l.createdAt)}
          </div>
        </div>
        <Pill tone={l.status === "exchanged" ? "good" : "neutral"}>
          {l.status}
        </Pill>
      </div>

      <div className="px-5 py-3 space-y-3 text-xs">
        {l.launchIntent && (
          <div>
            <div className="text-[10px] font-mono uppercase tracking-wider text-muted-foreground mb-1.5">
              Operator's question
            </div>
            <div className="text-foreground whitespace-pre-wrap">
              {l.launchIntent}
            </div>
          </div>
        )}

        <div>
          <div className="text-[10px] font-mono uppercase tracking-wider text-muted-foreground mb-1.5">
            Profile fields shared ({fields.length})
          </div>
          {fields.length === 0 ? (
            <div className="text-muted-foreground italic">
              No profile fields were sent.
            </div>
          ) : (
            <div className="flex flex-wrap gap-1.5">
              {fields.map((k) => (
                <Pill key={k}>{FIELD_LABELS[k] ?? k}</Pill>
              ))}
            </div>
          )}
        </div>

        <div>
          <div className="text-[10px] font-mono uppercase tracking-wider text-muted-foreground mb-1.5">
            Library snippets shared ({snippets.length})
          </div>
          {snippets.length === 0 ? (
            <div className="text-muted-foreground italic">
              No library snippets were sent.
            </div>
          ) : (
            <ul className="space-y-1">
              {snippets.map((s) => (
                <li
                  key={s.chunkId}
                  className="border border-border rounded px-2.5 py-1.5"
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-medium text-foreground/90 truncate">
                      {s.documentTitle}
                    </span>
                    <span className="text-[10px] font-mono text-muted-foreground tabular-nums shrink-0">
                      chunk #{s.chunkIndex}
                    </span>
                  </div>
                  <div className="text-muted-foreground line-clamp-2 mt-0.5">
                    {s.content}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>

        {l.additionalNote && (
          <div>
            <div className="text-[10px] font-mono uppercase tracking-wider text-muted-foreground mb-1.5">
              Additional note
            </div>
            <div className="text-foreground whitespace-pre-wrap">
              {l.additionalNote}
            </div>
          </div>
        )}
      </div>
    </li>
  );
}
