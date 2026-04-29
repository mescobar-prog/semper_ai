import { useState, useEffect, useRef } from "react";
import { Link, useParams, useLocation } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import {
  useGetToolBySlug,
  useAddFavorite,
  useRemoveFavorite,
  useGetMyProfile,
  useLaunchTool,
  useListToolReviews,
  useUpsertMyToolReview,
  useDeleteMyToolReview,
  useGetLaunchAffirmation,
  useListMyPresets,
  getGetToolBySlugQueryKey,
  getListRecentLaunchesQueryKey,
  getGetDashboardSummaryQueryKey,
  getListToolReviewsQueryKey,
  getListToolsQueryKey,
  getGetLaunchAffirmationQueryKey,
  getListMyPresetsQueryKey,
} from "@workspace/api-client-react";
import type { ToolReview } from "@workspace/api-client-react";
import {
  PageContainer,
  Pill,
  atoLabel,
  atoTone,
  ErrorBox,
  StarBar,
  RatingBadge,
  relativeTime,
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
  const { data: profileEnvelope } = useGetMyProfile();
  const profile = profileEnvelope?.profile;
  const contextBlock = profileEnvelope?.contextBlock ?? null;

  // Launch-time affirmation status (Task #45). Drives the "preset confirmed
  // for this session" indicator and short-circuits the modal when the
  // operator already affirmed within the 30-min TTL.
  const { data: affirmationStatus } = useGetLaunchAffirmation({
    query: {
      queryKey: getGetLaunchAffirmationQueryKey(),
      // Server returns plain JSON; default cache is fine. Refetch on
      // window focus so a new tab editing the CB doesn't leave a stale
      // "confirmed" pill behind.
      refetchOnWindowFocus: true,
    },
  });
  const { data: presets } = useListMyPresets({
    query: { queryKey: getListMyPresetsQueryKey(), retry: false },
  });
  const activePreset = (presets ?? []).find((p) => p.isActive) ?? null;

  const hasValidAffirmation =
    !!affirmationStatus?.affirmation &&
    !!activePreset &&
    affirmationStatus.presetId === activePreset.id &&
    !!contextBlock &&
    affirmationStatus.contextBlockVersion === contextBlock.version;

  const [launchTrigger, setLaunchTrigger] = useState<LaunchTrigger | null>(
    null,
  );
  // When the user clicks "Edit before launch", we explicitly force preview mode
  // for that single click even if their saved preference is "direct".
  const [forcePreview, setForcePreview] = useState(false);
  // When true the consolidated dialog opens in "re-affirm only" mode —
  // the same review content is shown but the primary button records a
  // fresh affirmation and closes without minting a launch.
  const [reaffirmOnly, setReaffirmOnly] = useState(false);
  const [launchState, setLaunchState] = useState<
    | { status: "idle" }
    | { status: "launched"; url: string; toolName: string }
    | {
        status: "local_ready";
        url: string;
        toolName: string;
        installerDownloadUrl: string | null;
        installerFilename: string | null;
        installInstructions: string | null;
      }
    | { status: "error"; message: string }
  >({ status: "idle" });

  // Belt-and-braces guard against double-launch: even with the disabled
  // button we've seen rapid double-clicks (touch events + click) slip
  // through before `launchTrigger` flips, so we also short-circuit here
  // via a ref that doesn't wait for a React render. Declared up here
  // (before the early returns below) so React always sees the same hook
  // count across renders — moving it after the loading/error guards
  // would violate the rules of hooks and crash the page on first load.
  const isLaunchingRef = useRef(false);

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

  // Triggered by the launch button. After Task #125 the affirmation
  // gate is rolled into the consolidated review dialog, so we just
  // open it here. The dialog itself records the affirmation (when
  // needed) before minting the launch.
  const launch = (opts?: { forcePreview?: boolean }) => {
    if (isLaunchingRef.current || launchTrigger) return;
    isLaunchingRef.current = true;
    setLaunchState({ status: "idle" });
    setForcePreview(!!opts?.forcePreview);
    setReaffirmOnly(false);
    setLaunchTrigger({ toolId: tool.id, toolName: tool.name });
  };

  // Click handler for the "Re-confirm preset for this session" link.
  // Opens the same consolidated dialog in re-affirm-only mode — the
  // primary button records a fresh affirmation and closes without
  // minting a launch.
  const reaffirm = () => {
    if (!activePreset || !contextBlock) return;
    if (isLaunchingRef.current || launchTrigger) return;
    isLaunchingRef.current = true;
    setLaunchState({ status: "idle" });
    setForcePreview(true);
    setReaffirmOnly(true);
    setLaunchTrigger({ toolId: tool.id, toolName: tool.name });
  };

  const launchPref = profile?.launchPreference ?? "preview";
  // The "skip preview" short-circuit only applies when the operator
  // already has a server-valid affirmation. If they've toggled "direct"
  // but their affirmation is missing/expired, we still need to show
  // the consolidated dialog so they can re-affirm before launching.
  const showPreview =
    reaffirmOnly ||
    forcePreview ||
    launchPref !== "direct" ||
    !hasValidAffirmation;
  const isLocal = tool.hostingType === "local_install";
  const cbConfirmed = !!contextBlock?.confirmedAt;

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
          <div className="mb-4">
            <RatingBadge
              avgRating={tool.avgRating}
              reviewCount={tool.reviewCount}
            />
          </div>
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
            {isLocal && <Pill tone="warn">Runs locally</Pill>}
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
            {!cbConfirmed && (
              <div
                role="alert"
                className="mb-3 rounded-md border border-amber-500/40 bg-amber-500/5 p-3 text-xs"
              >
                <div className="font-semibold text-amber-300 mb-1">
                  Context Block not confirmed
                </div>
                <p className="text-muted-foreground leading-relaxed">
                  This tool can't be launched until your 6-element Context
                  Block is confirmed.{" "}
                  <Link
                    href="/catalog"
                    className="text-primary underline underline-offset-2 hover:text-primary/80"
                  >
                    Open the verification gate →
                  </Link>
                </p>
              </div>
            )}
            <AffirmationIndicator
              valid={hasValidAffirmation}
              expiresAt={affirmationStatus?.affirmation?.expiresAt ?? null}
              onReaffirm={reaffirm}
              canReaffirm={!!activePreset && !!contextBlock}
            />
            <button
              onClick={() => launch()}
              disabled={!!launchTrigger || !tool.isActive || !cbConfirmed}
              className="w-full h-11 rounded-md bg-primary text-primary-foreground font-medium text-sm hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              {launchTrigger
                ? showPreview
                  ? "Reviewing…"
                  : "Launching…"
                : !tool.isActive
                  ? "Tool inactive"
                  : !cbConfirmed
                    ? "Confirm Context Block to launch"
                    : isLocal
                      ? "Launch local app with my context"
                      : "Launch with my context"}
            </button>
            <p className="text-xs text-muted-foreground mt-3 leading-relaxed">
              {isLocal
                ? "We'll mint a one-time launch token and hand it to your locally-installed copy of the tool. Install the app first if you haven't already. "
                : launchPref === "direct"
                  ? "Your default is to launch directly. Want to choose what to share? "
                  : "You'll preview your profile and library snippets before they're sent. "}
              {!isLocal &&
                launchPref === "direct" &&
                tool.isActive &&
                cbConfirmed && (
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
            {launchState.status === "local_ready" && (
              <LocalLaunchPanel
                toolName={launchState.toolName}
                url={launchState.url}
                installerDownloadUrl={launchState.installerDownloadUrl}
                installerFilename={launchState.installerFilename}
                installInstructions={launchState.installInstructions}
                onClose={() => setLaunchState({ status: "idle" })}
              />
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
            <DetailRow
              label="Reviews"
              value={
                tool.reviewCount > 0
                  ? `${tool.avgRating?.toFixed(1) ?? "—"} · ${tool.reviewCount}`
                  : "—"
              }
            />
          </div>
        </aside>
      </div>

      <LaunchPreviewDialog
        trigger={launchTrigger}
        showPreview={showPreview}
        presetSnapshot={activePreset}
        contextBlockSnapshot={contextBlock}
        hasValidAffirmation={hasValidAffirmation}
        mode={reaffirmOnly ? "reaffirm" : "launch"}
        onClose={() => {
          setLaunchTrigger(null);
          setForcePreview(false);
          setReaffirmOnly(false);
          isLaunchingRef.current = false;
        }}
        onLaunched={(r) => {
          if (r.hostingType === "local_install") {
            setLaunchState({
              status: "local_ready",
              url: r.launchUrl,
              toolName: r.toolName,
              installerDownloadUrl: r.installerDownloadUrl,
              installerFilename: r.installerFilename,
              installInstructions: r.installInstructions,
            });
          } else {
            setLaunchState({
              status: "launched",
              url: r.launchUrl,
              toolName: r.toolName,
            });
          }
        }}
      />

      <ReviewsSection toolId={tool.id} toolSlug={tool.slug} />
    </PageContainer>
  );
}

/**
 * Status pill rendered above the launch button. When the operator has a
 * valid affirmation we show an "expires at" timestamp and a re-confirm
 * link; otherwise we surface that the modal will appear on launch.
 */
function AffirmationIndicator({
  valid,
  expiresAt,
  onReaffirm,
  canReaffirm,
}: {
  valid: boolean;
  expiresAt: string | null;
  onReaffirm: () => void;
  canReaffirm: boolean;
}) {
  if (valid && expiresAt) {
    const minutesLeft = Math.max(
      0,
      Math.round((new Date(expiresAt).getTime() - Date.now()) / 60000),
    );
    return (
      <div className="mb-3 flex items-center justify-between gap-2 rounded border border-emerald-500/40 bg-emerald-500/5 px-3 py-2 text-xs">
        <span className="text-emerald-300">
          Preset confirmed for this session
          {minutesLeft > 0 ? ` · ${minutesLeft}m left` : ""}
        </span>
        {canReaffirm && (
          <button
            type="button"
            onClick={onReaffirm}
            className="text-emerald-200 hover:text-emerald-100 underline underline-offset-2"
          >
            Re-confirm
          </button>
        )}
      </div>
    );
  }
  return (
    <div className="mb-3 rounded border border-border bg-background/40 px-3 py-2 text-xs text-muted-foreground">
      You'll confirm your active preset before launching.
    </div>
  );
}

const REVIEWS_PAGE_SIZE = 10;

function ReviewsSection({
  toolId,
  toolSlug,
}: {
  toolId: string;
  toolSlug: string;
}) {
  const queryClient = useQueryClient();
  const [offset, setOffset] = useState(0);
  const [accumulated, setAccumulated] = useState<ToolReview[]>([]);
  const [editing, setEditing] = useState(false);

  const queryParams = {
    tool_slug: toolSlug,
    limit: REVIEWS_PAGE_SIZE,
    offset,
  };

  const {
    data: page,
    isLoading,
    error,
    refetch,
  } = useListToolReviews(queryParams, {
    query: { queryKey: getListToolReviewsQueryKey(queryParams) },
  });

  // Accumulate reviews across "show more" clicks. Reset whenever the first
  // page changes (e.g. after edit/delete invalidation).
  useEffect(() => {
    if (!page) return;
    if (offset === 0) {
      setAccumulated(page.reviews);
    } else {
      setAccumulated((prev) => {
        const seen = new Set(prev.map((r) => r.id));
        const next = page.reviews.filter((r) => !seen.has(r.id));
        return [...prev, ...next];
      });
    }
  }, [page, offset]);

  const upsertMutation = useUpsertMyToolReview();
  const deleteMutation = useDeleteMyToolReview();

  const refreshAll = () => {
    setOffset(0);
    setAccumulated([]);
    queryClient.invalidateQueries({
      queryKey: getListToolReviewsQueryKey({
        tool_slug: toolSlug,
        limit: REVIEWS_PAGE_SIZE,
        offset: 0,
      }),
    });
    queryClient.invalidateQueries({
      queryKey: getGetToolBySlugQueryKey(toolSlug),
    });
    queryClient.invalidateQueries({ queryKey: getListToolsQueryKey() });
    refetch();
  };

  const onSave = async (rating: number, comment: string) => {
    await upsertMutation.mutateAsync({
      toolId,
      data: { rating, comment: comment.trim() ? comment.trim() : null },
    });
    setEditing(false);
    refreshAll();
  };

  const onDelete = async () => {
    if (!confirm("Delete your review?")) return;
    await deleteMutation.mutateAsync({ toolId });
    setEditing(false);
    refreshAll();
  };

  return (
    <section className="mt-12 border-t border-border pt-8">
      <div className="flex items-baseline justify-between gap-4 mb-6">
        <div>
          <div className="text-[10px] uppercase tracking-[0.25em] text-primary font-mono font-semibold mb-1">
            Reviews
          </div>
          <h2 className="text-2xl font-semibold tracking-tight">
            What service members say
          </h2>
          <p className="text-sm text-muted-foreground mt-1">
            Reviewers are identified only by branch and rank.
          </p>
        </div>
        {page && page.total > 0 && (
          <div className="text-right">
            <div className="text-3xl font-semibold leading-none">
              {page.avgRating?.toFixed(1) ?? "—"}
              <span className="text-base text-muted-foreground"> / 5</span>
            </div>
            <div className="mt-1">
              <StarBar value={page.avgRating ?? 0} size="md" />
            </div>
            <div className="text-xs text-muted-foreground mt-1">
              {page.total} {page.total === 1 ? "review" : "reviews"}
            </div>
          </div>
        )}
      </div>

      {error && <ErrorBox>{(error as Error).message}</ErrorBox>}

      {isLoading && accumulated.length === 0 ? (
        <div className="space-y-2">
          {Array.from({ length: 3 }).map((_, i) => (
            <div
              key={i}
              className="h-20 bg-card border border-border rounded-md animate-pulse"
            />
          ))}
        </div>
      ) : (
        <div className="grid lg:grid-cols-3 gap-6">
          <div className="lg:col-span-2 space-y-3">
            {accumulated.length === 0 && page?.total === 0 && (
              <div className="border border-dashed border-border rounded-md p-8 text-center bg-card/40">
                <div className="text-base font-medium mb-1">
                  No reviews yet
                </div>
                <p className="text-sm text-muted-foreground">
                  {page?.canReview
                    ? "Be the first to share how this tool performed for your role."
                    : "Launch this tool once, then come back to leave the first review."}
                </p>
              </div>
            )}
            {accumulated.map((r) => (
              <ReviewCard key={r.id} review={r} />
            ))}
            {page && page.hasMore && (
              <div className="pt-2">
                <button
                  onClick={() => setOffset(offset + REVIEWS_PAGE_SIZE)}
                  className="h-9 px-4 rounded-md border border-border text-xs font-mono uppercase tracking-wider hover:border-primary/50"
                >
                  Show more
                </button>
              </div>
            )}
          </div>

          <aside>
            <ReviewComposer
              myReview={page?.myReview ?? null}
              canReview={page?.canReview ?? false}
              isEditing={editing}
              onStartEdit={() => setEditing(true)}
              onCancel={() => setEditing(false)}
              onSave={onSave}
              onDelete={onDelete}
              saving={upsertMutation.isPending || deleteMutation.isPending}
            />
          </aside>
        </div>
      )}
    </section>
  );
}

function ReviewCard({ review }: { review: ToolReview }) {
  const reviewer =
    [review.reviewerRank, review.reviewerBranch].filter(Boolean).join(" · ") ||
    "Anonymous service member";
  return (
    <div className="bg-card border border-border rounded-md p-4">
      <div className="flex items-start justify-between gap-3 mb-2">
        <div>
          <div className="text-[11px] font-mono uppercase tracking-wider text-muted-foreground">
            {reviewer}
            {review.isMine && (
              <span className="ml-2 text-primary">· your review</span>
            )}
          </div>
          <div className="mt-1">
            <StarBar value={review.rating} />
          </div>
        </div>
        <div className="text-[11px] text-muted-foreground font-mono">
          {relativeTime(review.updatedAt)}
        </div>
      </div>
      {review.comment && (
        <p className="text-sm leading-relaxed text-foreground whitespace-pre-wrap">
          {review.comment}
        </p>
      )}
    </div>
  );
}

function ReviewComposer({
  myReview,
  canReview,
  isEditing,
  onStartEdit,
  onCancel,
  onSave,
  onDelete,
  saving,
}: {
  myReview: ToolReview | null;
  canReview: boolean;
  isEditing: boolean;
  onStartEdit: () => void;
  onCancel: () => void;
  onSave: (rating: number, comment: string) => void;
  onDelete: () => void;
  saving: boolean;
}) {
  const [rating, setRating] = useState<number>(myReview?.rating ?? 5);
  const [comment, setComment] = useState<string>(myReview?.comment ?? "");

  useEffect(() => {
    setRating(myReview?.rating ?? 5);
    setComment(myReview?.comment ?? "");
  }, [myReview, isEditing]);

  if (!canReview && !myReview) {
    return (
      <div className="bg-card border border-border rounded-md p-5">
        <div className="text-[10px] uppercase tracking-wider text-muted-foreground font-mono mb-2">
          Leave a review
        </div>
        <p className="text-sm text-muted-foreground">
          Launch this tool at least once before posting a review. That keeps
          ratings anchored to actual usage.
        </p>
      </div>
    );
  }

  if (myReview && !isEditing) {
    return (
      <div className="bg-card border border-border rounded-md p-5">
        <div className="text-[10px] uppercase tracking-wider text-muted-foreground font-mono mb-2">
          Your review
        </div>
        <div className="mb-2">
          <StarBar value={myReview.rating} size="md" />
        </div>
        {myReview.comment && (
          <p className="text-sm leading-relaxed mb-3 whitespace-pre-wrap">
            {myReview.comment}
          </p>
        )}
        <div className="flex gap-2">
          <button
            onClick={onStartEdit}
            className="h-8 px-3 rounded-md border border-border text-xs font-mono uppercase tracking-wider hover:border-primary/50"
          >
            Edit
          </button>
          <button
            onClick={onDelete}
            disabled={saving}
            className="h-8 px-3 rounded-md border border-border text-xs font-mono uppercase tracking-wider text-rose-400 hover:border-rose-500/50 disabled:opacity-50"
          >
            Delete
          </button>
        </div>
      </div>
    );
  }

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        onSave(rating, comment);
      }}
      className="bg-card border border-primary/30 rounded-md p-5"
    >
      <div className="text-[10px] uppercase tracking-wider text-primary font-mono font-semibold mb-3">
        {myReview ? "Edit your review" : "Leave a review"}
      </div>
      <div className="mb-3">
        <div className="text-[11px] font-mono uppercase tracking-wider text-muted-foreground mb-1">
          Rating
        </div>
        <div className="flex gap-1 text-2xl">
          {[1, 2, 3, 4, 5].map((n) => (
            <button
              type="button"
              key={n}
              onClick={() => setRating(n)}
              aria-label={`${n} stars`}
              className={
                n <= rating ? "text-amber-400" : "text-muted-foreground/40"
              }
            >
              ★
            </button>
          ))}
        </div>
      </div>
      <div className="mb-3">
        <div className="text-[11px] font-mono uppercase tracking-wider text-muted-foreground mb-1">
          Comment (optional, 500 chars)
        </div>
        <textarea
          value={comment}
          onChange={(e) => setComment(e.target.value.slice(0, 500))}
          rows={4}
          maxLength={500}
          placeholder="Share what worked, what didn't, and what role you used it in."
          className="w-full px-3 py-2 rounded-md bg-background border border-border text-sm focus:border-primary focus:outline-none"
        />
        <div className="text-[10px] text-muted-foreground font-mono mt-1 text-right">
          {comment.length}/500
        </div>
      </div>
      <div className="flex gap-2 justify-end">
        {myReview && (
          <button
            type="button"
            onClick={onCancel}
            className="h-8 px-3 rounded-md border border-border text-xs font-mono uppercase tracking-wider"
          >
            Cancel
          </button>
        )}
        <button
          type="submit"
          disabled={saving}
          className="h-8 px-4 rounded-md bg-primary text-primary-foreground text-xs font-mono uppercase tracking-wider hover:bg-primary/90 disabled:opacity-50"
        >
          {saving ? "Saving…" : myReview ? "Save changes" : "Post review"}
        </button>
      </div>
    </form>
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

function LocalLaunchPanel({
  toolName,
  url,
  installerDownloadUrl,
  installerFilename,
  installInstructions,
  onClose,
}: {
  toolName: string;
  url: string;
  installerDownloadUrl: string | null;
  installerFilename: string | null;
  installInstructions: string | null;
  onClose: () => void;
}) {
  const handoff = () => {
    window.location.href = url;
  };
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4">
      <div className="bg-card border border-border rounded-md w-full max-w-lg max-h-[85vh] overflow-y-auto">
        <div className="flex items-start justify-between gap-4 border-b border-border px-5 py-4">
          <div>
            <div className="text-[10px] uppercase tracking-wider text-amber-300 font-mono">
              Local install
            </div>
            <div className="text-base font-semibold mt-0.5">
              Launch {toolName}
            </div>
          </div>
          <button
            onClick={onClose}
            aria-label="Close"
            className="text-muted-foreground hover:text-foreground text-lg"
          >
            ×
          </button>
        </div>
        <div className="px-5 py-4 space-y-4">
          <p className="text-xs text-muted-foreground leading-relaxed">
            {toolName} runs on your workstation. Install it once, then click the
            handoff button to open it with a fresh platform context token.
          </p>

          {installInstructions && (
            <div>
              <div className="text-[10px] font-mono uppercase tracking-wider text-muted-foreground mb-1.5">
                Install instructions
              </div>
              <div className="text-xs whitespace-pre-wrap leading-relaxed text-foreground bg-background border border-border rounded-md p-3 max-h-48 overflow-y-auto">
                {installInstructions}
              </div>
            </div>
          )}

          {installerDownloadUrl && (
            <a
              href={installerDownloadUrl}
              download={installerFilename ?? undefined}
              className="block w-full h-10 leading-10 text-center rounded-md border border-border text-sm hover:border-primary/50 transition-colors"
            >
              ⬇ Download installer
              {installerFilename && (
                <span className="text-muted-foreground ml-1">
                  ({installerFilename})
                </span>
              )}
            </a>
          )}

          <button
            onClick={handoff}
            className="w-full h-11 rounded-md bg-primary text-primary-foreground font-medium text-sm hover:bg-primary/90 transition-colors"
          >
            Open with my context →
          </button>
          <p className="text-[10px] font-mono uppercase tracking-wider text-muted-foreground text-center">
            One-time token expires after first use
          </p>
        </div>
      </div>
    </div>
  );
}
