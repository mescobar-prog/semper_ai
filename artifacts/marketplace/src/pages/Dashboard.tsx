import { Link } from "wouter";
import {
  useGetDashboardSummary,
  useGetMyProfile,
} from "@workspace/api-client-react";
import { useAuth } from "@workspace/replit-auth-web";
import {
  PageContainer,
  StatCard,
  Pill,
  atoLabel,
  atoTone,
  formatDate,
  ErrorBox,
  EmptyState,
} from "@/lib/format";

export function Dashboard() {
  const { user } = useAuth();
  const { data: profileEnvelope } = useGetMyProfile();
  const profile = profileEnvelope?.profile;
  const {
    data: summary,
    isLoading,
    error,
  } = useGetDashboardSummary();

  const greeting =
    user?.firstName || (user?.email ? user.email.split("@")[0] : "Operator");

  if (error) {
    return (
      <PageContainer>
        <ErrorBox>{(error as Error).message}</ErrorBox>
      </PageContainer>
    );
  }

  return (
    <PageContainer>
      <div className="mb-10">
        <div className="text-[10px] uppercase tracking-[0.25em] text-primary font-mono font-semibold mb-2">
          Operations Dashboard
        </div>
        <h1 className="text-3xl font-semibold tracking-tight">
          Welcome back, {greeting}.
        </h1>
        <p className="text-sm text-muted-foreground mt-1">
          Your authorized AI workbench. Profile context and library snippets
          travel with every tool you launch.
        </p>
      </div>

      {isLoading || !summary ? (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-10">
          {Array.from({ length: 4 }).map((_, i) => (
            <div
              key={i}
              className="bg-card border border-border rounded-md h-24 animate-pulse"
            />
          ))}
        </div>
      ) : (
        <>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-10">
            <StatCard
              label="Profile completeness"
              value={`${summary.profileCompletenessPct}%`}
              hint={
                <Link
                  href="/profile"
                  className="text-primary hover:underline"
                >
                  Refine →
                </Link>
              }
            />
            <StatCard
              label="Library documents"
              value={summary.libraryDocumentCount}
              hint={`${summary.libraryChunkCount.toLocaleString()} indexed chunks`}
            />
            <StatCard label="Favorited tools" value={summary.favoritesCount} />
            <StatCard label="Total launches" value={summary.launchCount} />
          </div>

          <div className="grid lg:grid-cols-3 gap-6">
            <section className="lg:col-span-2 bg-card border border-border rounded-md">
              <div className="px-5 py-4 border-b border-border flex items-center justify-between">
                <div>
                  <div className="text-[10px] uppercase tracking-wider text-muted-foreground font-mono">
                    Recent launches
                  </div>
                  <h2 className="text-base font-semibold mt-0.5">
                    Last activity
                  </h2>
                </div>
                <Link
                  href="/launches"
                  className="text-xs text-primary hover:underline font-mono uppercase tracking-wider"
                >
                  Full history →
                </Link>
              </div>
              {summary.recentLaunches.length === 0 ? (
                <div className="p-10">
                  <EmptyState
                    title="No launches yet"
                    description="Browse the catalog and launch a tool to see it here. The marketplace mints a one-time token and forwards your context."
                    action={
                      <Link
                        href="/catalog"
                        className="inline-flex h-9 items-center px-4 rounded-md bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90"
                      >
                        Browse catalog
                      </Link>
                    }
                  />
                </div>
              ) : (
                <ul className="divide-y divide-border">
                  {summary.recentLaunches.map((l) => (
                    <li
                      key={l.id}
                      className="px-5 py-3 flex items-center justify-between hover:bg-accent/30 transition-colors"
                    >
                      <Link
                        href={`/catalog/${l.toolSlug}`}
                        className="text-sm font-medium hover:text-primary"
                      >
                        {l.toolName}
                      </Link>
                      <div className="text-xs text-muted-foreground font-mono">
                        {formatDate(l.createdAt)}
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </section>

            <section className="bg-card border border-border rounded-md">
              <div className="px-5 py-4 border-b border-border">
                <div className="text-[10px] uppercase tracking-wider text-muted-foreground font-mono">
                  Catalog by ATO status
                </div>
                <h2 className="text-base font-semibold mt-0.5">
                  Authorization mix
                </h2>
              </div>
              {summary.atoStatusBreakdown.length === 0 ? (
                <div className="p-5 text-sm text-muted-foreground">
                  No tools in catalog.
                </div>
              ) : (
                <ul className="p-5 space-y-3">
                  {summary.atoStatusBreakdown.map((b) => {
                    const total = summary.atoStatusBreakdown.reduce(
                      (s, x) => s + x.count,
                      0,
                    );
                    const pct = total > 0 ? (b.count / total) * 100 : 0;
                    return (
                      <li key={b.atoStatus} className="space-y-1">
                        <div className="flex items-center justify-between text-xs">
                          <Pill tone={atoTone(b.atoStatus)}>
                            {atoLabel(b.atoStatus)}
                          </Pill>
                          <span className="font-mono tabular-nums text-muted-foreground">
                            {b.count}
                          </span>
                        </div>
                        <div className="h-1 bg-border rounded-full overflow-hidden">
                          <div
                            className="h-full bg-primary rounded-full"
                            style={{ width: `${pct}%` }}
                          />
                        </div>
                      </li>
                    );
                  })}
                </ul>
              )}
            </section>
          </div>

          {summary.topTools.length > 0 && (
            <section className="mt-8">
              <div className="flex items-end justify-between mb-4">
                <div>
                  <div className="text-[10px] uppercase tracking-wider text-muted-foreground font-mono">
                    Top tools
                  </div>
                  <h2 className="text-base font-semibold mt-0.5">
                    Most-launched in your catalog
                  </h2>
                </div>
                <Link
                  href="/catalog"
                  className="text-xs text-primary hover:underline font-mono uppercase tracking-wider"
                >
                  All tools →
                </Link>
              </div>
              <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-3">
                {summary.topTools.slice(0, 4).map((t) => (
                  <Link
                    key={t.id}
                    href={`/catalog/${t.slug}`}
                    className="block bg-card border border-border rounded-md p-4 hover:border-primary/50 transition-colors"
                  >
                    <div className="flex items-center justify-between mb-2">
                      <span className="text-[10px] font-mono uppercase tracking-wider text-muted-foreground">
                        {t.vendor}
                      </span>
                      <Pill tone={atoTone(t.atoStatus)}>
                        {atoLabel(t.atoStatus)}
                      </Pill>
                    </div>
                    <div className="text-sm font-semibold leading-tight">
                      {t.name}
                    </div>
                    <div className="text-xs text-muted-foreground mt-2 line-clamp-2">
                      {t.shortDescription}
                    </div>
                  </Link>
                ))}
              </div>
            </section>
          )}

          {profile && profile.completenessPct < 60 && (
            <div className="mt-8 rounded-md border border-amber-500/40 bg-amber-500/5 p-4 flex items-center justify-between">
              <div>
                <div className="text-sm font-medium text-amber-300">
                  Your profile is {profile.completenessPct}% complete.
                </div>
                <div className="text-xs text-amber-200/70 mt-0.5">
                  Tools work best when they know your branch, role, and
                  mission. Spend two minutes filling it in.
                </div>
              </div>
              <Link
                href="/profile"
                className="text-xs uppercase tracking-wider font-mono text-amber-300 hover:text-amber-200"
              >
                Refine profile →
              </Link>
            </div>
          )}
        </>
      )}
    </PageContainer>
  );
}
