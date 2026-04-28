import { useState } from "react";
import { Link, useParams, useLocation } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import {
  useGetToolBySlug,
  useAddFavorite,
  useRemoveFavorite,
  useGetMyProfile,
  getGetToolBySlugQueryKey,
} from "@workspace/api-client-react";
import {
  PageContainer,
  Pill,
  atoLabel,
  atoTone,
  ErrorBox,
} from "@/lib/format";
import {
  LaunchPreviewDialog,
  type LaunchTrigger,
} from "@/components/LaunchPreviewDialog";

export function CatalogDetail() {
  const params = useParams<{ slug: string }>();
  const [, setLocation] = useLocation();
  const queryClient = useQueryClient();
  const slug = params.slug;

  const { data: tool, isLoading, error } = useGetToolBySlug(slug, {
    query: { enabled: !!slug, queryKey: getGetToolBySlugQueryKey(slug) },
  });

  const addFav = useAddFavorite();
  const removeFav = useRemoveFavorite();
  const { data: profile } = useGetMyProfile();

  const [launchTrigger, setLaunchTrigger] = useState<LaunchTrigger | null>(
    null,
  );
  // When the user clicks "Edit before launch", we explicitly force preview mode
  // for that single click even if their saved preference is "direct".
  const [forcePreview, setForcePreview] = useState(false);
  const [launchState, setLaunchState] = useState<
    | { status: "idle" }
    | { status: "launched"; url: string; toolName: string }
    | { status: "error"; message: string }
  >({ status: "idle" });

  if (isLoading) {
    return (
      <PageContainer>
        <div className="text-muted-foreground font-mono text-xs uppercase tracking-widest">
          Loading tool…
        </div>
      </PageContainer>
    );
  }
  if (error || !tool) {
    return (
      <PageContainer>
        <ErrorBox>{error ? (error as Error).message : "Tool not found"}</ErrorBox>
        <button
          onClick={() => setLocation("/catalog")}
          className="mt-4 text-sm text-primary hover:underline"
        >
          ← Back to catalog
        </button>
      </PageContainer>
    );
  }

  const toggleFav = async () => {
    if (tool.isFavorite) {
      await removeFav.mutateAsync({ toolId: tool.id });
    } else {
      await addFav.mutateAsync({ toolId: tool.id });
    }
    queryClient.invalidateQueries({
      queryKey: getGetToolBySlugQueryKey(slug),
    });
  };

  const launch = (opts?: { forcePreview?: boolean }) => {
    setLaunchState({ status: "idle" });
    setForcePreview(!!opts?.forcePreview);
    setLaunchTrigger({ toolId: tool.id, toolName: tool.name });
  };

  const launchPref = profile?.launchPreference ?? "preview";
  const showPreview = forcePreview || launchPref !== "direct";

  return (
    <PageContainer>
      <Link
        href="/catalog"
        className="inline-block text-xs uppercase tracking-wider font-mono text-muted-foreground hover:text-foreground mb-6"
      >
        ← Catalog
      </Link>

      <div className="grid lg:grid-cols-3 gap-8">
        <div className="lg:col-span-2">
          <div className="text-[10px] font-mono uppercase tracking-wider text-muted-foreground mb-1">
            {tool.vendor}
            {tool.categoryName && (
              <>
                <span className="mx-2 text-border">·</span>
                {tool.categoryName}
              </>
            )}
            {tool.version && (
              <>
                <span className="mx-2 text-border">·</span>v{tool.version}
              </>
            )}
          </div>
          <h1 className="text-4xl font-semibold tracking-tight mb-3 flex items-center gap-3 flex-wrap">
            {tool.name}
            {tool.isVendorSubmitted && (
              <span
                title="Submitted by vendor"
                className="text-[10px] font-mono uppercase tracking-wider px-2 py-1 rounded border border-blue-500/40 bg-blue-500/10 text-blue-300"
              >
                Submitted by vendor
              </span>
            )}
          </h1>
          <div className="flex flex-wrap gap-1.5 mb-6">
            <Pill tone={atoTone(tool.atoStatus)}>
              {atoLabel(tool.atoStatus)}
            </Pill>
            {tool.impactLevels.map((il) => (
              <Pill key={il}>{il}</Pill>
            ))}
            {tool.dataClassification && (
              <Pill tone="neutral">{tool.dataClassification}</Pill>
            )}
            {tool.badges.map((b) => (
              <Pill key={b} tone="info">
                {b}
              </Pill>
            ))}
          </div>
          <p className="text-base text-muted-foreground leading-relaxed mb-8">
            {tool.shortDescription}
          </p>

          <div className="prose prose-invert prose-sm max-w-none">
            <div className="text-[10px] uppercase tracking-wider text-muted-foreground font-mono font-semibold mb-2">
              Overview
            </div>
            <div className="text-sm whitespace-pre-wrap leading-relaxed text-foreground">
              {tool.longDescription}
            </div>
          </div>

          {(tool.homepageUrl || tool.documentationUrl) && (
            <div className="mt-8 flex gap-4 text-sm">
              {tool.homepageUrl && (
                <a
                  href={tool.homepageUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-primary hover:underline"
                >
                  Homepage →
                </a>
              )}
              {tool.documentationUrl && (
                <a
                  href={tool.documentationUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-primary hover:underline"
                >
                  Documentation →
                </a>
              )}
            </div>
          )}
        </div>

        <aside className="space-y-4">
          <div className="bg-card border border-border rounded-md p-5">
            <div className="text-[10px] uppercase tracking-wider text-muted-foreground font-mono mb-3">
              Launch this tool
            </div>
            <button
              onClick={() => launch()}
              disabled={!!launchTrigger || !tool.isActive}
              className="w-full h-11 rounded-md bg-primary text-primary-foreground font-medium text-sm hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              {launchTrigger
                ? showPreview
                  ? "Reviewing…"
                  : "Launching…"
                : tool.isActive
                  ? "Launch with my context"
                  : "Tool inactive"}
            </button>
            <p className="text-xs text-muted-foreground mt-3 leading-relaxed">
              {launchPref === "direct"
                ? "Your default is to launch directly. Want to choose what to share?"
                : "You'll preview your profile and library snippets before they're sent."}{" "}
              {launchPref === "direct" && tool.isActive && (
                <button
                  type="button"
                  onClick={() => launch({ forcePreview: true })}
                  className="text-primary hover:underline"
                >
                  Edit before launch
                </button>
              )}
            </p>
            {launchState.status === "launched" && (
              <div className="mt-3 rounded border border-emerald-500/40 bg-emerald-500/5 p-3 text-xs text-emerald-300">
                {launchState.toolName} opened in a new tab.{" "}
                <a
                  href={launchState.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="underline hover:text-emerald-200"
                >
                  Reopen
                </a>
              </div>
            )}
            {launchState.status === "error" && (
              <div className="mt-3 rounded border border-rose-500/40 bg-rose-500/5 p-3 text-xs text-rose-300">
                {launchState.message}
              </div>
            )}
            <button
              onClick={toggleFav}
              className={`mt-3 w-full h-9 rounded-md border border-border text-xs font-medium hover:border-primary/50 transition-colors ${
                tool.isFavorite ? "text-amber-400" : "text-muted-foreground"
              }`}
            >
              {tool.isFavorite ? "★ Favorited" : "☆ Add to favorites"}
            </button>
          </div>

          <div className="bg-card border border-border rounded-md p-5 space-y-3">
            <div className="text-[10px] uppercase tracking-wider text-muted-foreground font-mono mb-2">
              Authority status
            </div>
            <DetailRow
              label="ATO"
              value={
                <Pill tone={atoTone(tool.atoStatus)}>
                  {atoLabel(tool.atoStatus)}
                </Pill>
              }
            />
            <DetailRow
              label="Impact"
              value={
                tool.impactLevels.length ? (
                  <div className="flex flex-wrap gap-1">
                    {tool.impactLevels.map((il) => (
                      <Pill key={il}>{il}</Pill>
                    ))}
                  </div>
                ) : (
                  <span className="text-muted-foreground">—</span>
                )
              }
            />
            <DetailRow
              label="Data class"
              value={tool.dataClassification || "—"}
            />
            <DetailRow label="Vendor" value={tool.vendor} />
            <DetailRow label="Launches" value={tool.launchCount} />
            <DetailRow label="Favorites" value={tool.favoriteCount} />
          </div>
        </aside>
      </div>

      <LaunchPreviewDialog
        trigger={launchTrigger}
        showPreview={showPreview}
        onClose={() => {
          setLaunchTrigger(null);
          setForcePreview(false);
        }}
        onLaunched={(r) =>
          setLaunchState({
            status: "launched",
            url: r.url,
            toolName: r.toolName,
          })
        }
      />
    </PageContainer>
  );
}

function DetailRow({
  label,
  value,
}: {
  label: string;
  value: React.ReactNode;
}) {
  return (
    <div className="flex items-start justify-between gap-3 text-xs">
      <span className="text-muted-foreground font-mono uppercase tracking-wider">
        {label}
      </span>
      <span className="text-right text-foreground font-medium">{value}</span>
    </div>
  );
}
