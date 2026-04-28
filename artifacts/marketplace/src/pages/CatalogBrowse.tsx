import { useState, useMemo } from "react";
import { Link } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import {
  useListCategories,
  useListTools,
  useAddFavorite,
  useRemoveFavorite,
  useGetMyProfile,
  getListToolsQueryKey,
  ListToolsSort,
} from "@workspace/api-client-react";
import type { ToolSummary } from "@workspace/api-client-react";
import {
  PageContainer,
  Pill,
  atoLabel,
  atoTone,
  ErrorBox,
  EmptyState,
  RatingBadge,
} from "@/lib/format";

const ATO_OPTIONS = [
  { value: "", label: "All statuses" },
  { value: "full_ato", label: "Full ATO" },
  { value: "ipa", label: "Interim Authority" },
  { value: "in_review", label: "In ATO Review" },
];

const IL_OPTIONS = ["", "IL2", "IL4", "IL5", "IL6"];

export function CatalogBrowse() {
  const [q, setQ] = useState("");
  const [category, setCategory] = useState("");
  const [atoStatus, setAtoStatus] = useState("");
  const [impactLevel, setImpactLevel] = useState("");
  const [sort, setSort] = useState<ListToolsSort>(ListToolsSort.name);

  const params = useMemo(
    () => ({
      q: q || undefined,
      category: category || undefined,
      ato_status: atoStatus || undefined,
      impact_level: impactLevel || undefined,
      sort,
    }),
    [q, category, atoStatus, impactLevel, sort],
  );

  const { data: categories } = useListCategories();
  const { data: tools, isLoading, error } = useListTools(params);
  const { data: profile } = useGetMyProfile();
  const cb = profile?.contextBlock;

  return (
    <PageContainer>
      <div className="mb-8 flex items-start justify-between gap-4 flex-wrap">
        <div>
          <div className="text-[10px] uppercase tracking-[0.25em] text-primary font-mono font-semibold mb-2">
            Catalog · Browse
          </div>
          <h1 className="text-3xl font-semibold tracking-tight">
            Authorized AI tools
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            Filter by category, authorization status, and impact level. Every
            launch carries your profile and Context Block.
          </p>
        </div>
        <Link
          href="/catalog"
          className="text-xs font-mono uppercase tracking-wider px-3 py-2 rounded-md border border-border hover:border-primary/50 transition-colors"
        >
          {cb?.confirmedAt ? "Edit Context Block" : "Confirm Context Block →"}
        </Link>
      </div>

      {cb && !cb.confirmedAt && (
        <div className="mb-6 rounded-md border border-amber-500/40 bg-amber-500/5 p-4 text-sm">
          <div className="font-semibold text-amber-300 mb-1">
            Context Block not confirmed
          </div>
          <p className="text-muted-foreground">
            Tool launches will not include your 6-element Context Block until
            you confirm it.{" "}
            <Link
              href="/catalog"
              className="text-primary underline underline-offset-2"
            >
              Open the verification gate
            </Link>
            .
          </p>
        </div>
      )}

      <div className="bg-card border border-border rounded-md p-4 mb-6 grid md:grid-cols-4 gap-3">
        <input
          type="text"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search tools…"
          className="md:col-span-1 px-3 py-2 rounded-md bg-background border border-border text-sm focus:border-primary focus:outline-none"
        />
        <select
          value={category}
          onChange={(e) => setCategory(e.target.value)}
          className="px-3 py-2 rounded-md bg-background border border-border text-sm focus:border-primary focus:outline-none"
        >
          <option value="">All categories</option>
          {categories?.map((c) => (
            <option key={c.id} value={c.slug}>
              {c.name}
            </option>
          ))}
        </select>
        <select
          value={atoStatus}
          onChange={(e) => setAtoStatus(e.target.value)}
          className="px-3 py-2 rounded-md bg-background border border-border text-sm focus:border-primary focus:outline-none"
        >
          {ATO_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
        <select
          value={impactLevel}
          onChange={(e) => setImpactLevel(e.target.value)}
          className="px-3 py-2 rounded-md bg-background border border-border text-sm focus:border-primary focus:outline-none"
        >
          <option value="">All impact levels</option>
          {IL_OPTIONS.filter(Boolean).map((il) => (
            <option key={il} value={il}>
              {il}
            </option>
          ))}
        </select>
      </div>

      {error && <ErrorBox>{(error as Error).message}</ErrorBox>}

      {isLoading ? (
        <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {Array.from({ length: 6 }).map((_, i) => (
            <div
              key={i}
              className="bg-card border border-border rounded-md h-44 animate-pulse"
            />
          ))}
        </div>
      ) : tools && tools.length > 0 ? (
        <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {tools.map((t) => (
            <ToolCard key={t.id} tool={t} listParams={params} />
          ))}
        </div>
      ) : (
        <EmptyState
          title="No tools match those filters"
          description="Try clearing some filters or broadening your search."
        />
      )}
    </PageContainer>
  );
}

function ToolCard({
  tool,
  listParams,
}: {
  tool: ToolSummary;
  listParams: Record<string, string | undefined>;
}) {
  const queryClient = useQueryClient();
  const addFav = useAddFavorite();
  const removeFav = useRemoveFavorite();

  const toggleFav = async (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (tool.isFavorite) {
      await removeFav.mutateAsync({ toolId: tool.id });
    } else {
      await addFav.mutateAsync({ toolId: tool.id });
    }
    queryClient.invalidateQueries({ queryKey: getListToolsQueryKey(listParams) });
  };

  return (
    <Link
      href={`/catalog/${tool.slug}`}
      className="group block bg-card border border-border rounded-md p-4 hover:border-primary/50 transition-colors"
    >
      <div className="flex items-start justify-between gap-2 mb-3">
        <div className="min-w-0 flex-1">
          <div className="text-[10px] font-mono uppercase tracking-wider text-muted-foreground mb-0.5">
            {tool.vendor}
            {tool.categoryName && (
              <>
                <span className="mx-1.5 text-border">·</span>
                {tool.categoryName}
              </>
            )}
          </div>
          <div className="text-base font-semibold leading-tight group-hover:text-primary transition-colors flex items-center gap-2">
            {tool.name}
            {tool.isVendorSubmitted && (
              <span
                title="Submitted by vendor"
                className="text-[9px] font-mono uppercase tracking-wider px-1.5 py-0.5 rounded border border-blue-500/40 bg-blue-500/10 text-blue-300"
              >
                Vendor
              </span>
            )}
          </div>
        </div>
        <button
          onClick={toggleFav}
          aria-label={
            tool.isFavorite ? "Remove from favorites" : "Add to favorites"
          }
          className={`shrink-0 w-8 h-8 rounded-md border border-border flex items-center justify-center text-xs hover:border-primary/50 transition-colors ${
            tool.isFavorite ? "text-amber-400" : "text-muted-foreground"
          }`}
        >
          {tool.isFavorite ? "★" : "☆"}
        </button>
      </div>
      <p className="text-sm text-muted-foreground line-clamp-2 mb-4">
        {tool.shortDescription}
      </p>
      <div className="flex flex-wrap gap-1.5">
        <Pill tone={atoTone(tool.atoStatus)}>{atoLabel(tool.atoStatus)}</Pill>
        {tool.impactLevels.map((il) => (
          <Pill key={il}>{il}</Pill>
        ))}
        {tool.dataClassification && (
          <Pill tone="neutral">{tool.dataClassification}</Pill>
        )}
      </div>
      <div className="mt-3 pt-3 border-t border-border flex items-center justify-between text-[10px] font-mono uppercase tracking-wider text-muted-foreground">
        <RatingBadge
          avgRating={tool.avgRating}
          reviewCount={tool.reviewCount}
        />
        <span>{tool.launchCount} launches</span>
      </div>
    </Link>
  );
}
