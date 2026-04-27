import { Link } from "wouter";
import { useListRecentLaunches } from "@workspace/api-client-react";
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
          Every time you launch an authorized tool, the marketplace logs the
          event and returns a one-time token. Tokens expire after 5 minutes.
        </p>
      </div>

      {error && <ErrorBox>{(error as Error).message}</ErrorBox>}

      {isLoading ? (
        <div className="space-y-2">
          {Array.from({ length: 4 }).map((_, i) => (
            <div
              key={i}
              className="bg-card border border-border rounded-md h-14 animate-pulse"
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
        <div className="bg-card border border-border rounded-md overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border bg-background/50">
                <th className="text-left px-5 py-3 text-[10px] font-mono uppercase tracking-wider text-muted-foreground font-medium">
                  Tool
                </th>
                <th className="text-left px-5 py-3 text-[10px] font-mono uppercase tracking-wider text-muted-foreground font-medium">
                  Status
                </th>
                <th className="text-right px-5 py-3 text-[10px] font-mono uppercase tracking-wider text-muted-foreground font-medium">
                  Timestamp
                </th>
              </tr>
            </thead>
            <tbody>
              {data.map((l) => (
                <tr
                  key={l.id}
                  className="border-b border-border last:border-b-0 hover:bg-accent/30"
                >
                  <td className="px-5 py-3">
                    <Link
                      href={`/catalog/${l.toolSlug}`}
                      className="font-medium hover:text-primary"
                    >
                      {l.toolName}
                    </Link>
                  </td>
                  <td className="px-5 py-3">
                    <Pill
                      tone={l.status === "exchanged" ? "good" : "neutral"}
                    >
                      {l.status}
                    </Pill>
                  </td>
                  <td className="px-5 py-3 text-right text-xs text-muted-foreground font-mono">
                    {formatDate(l.createdAt)}
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
