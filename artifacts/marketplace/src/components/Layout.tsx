import { useEffect, useRef, useState } from "react";
import { useAuth } from "@workspace/replit-auth-web";
import { Link, useLocation } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import {
  useGetMyProfile,
  useListMyPresets,
  useActivateMyPreset,
  useUpdateMyProfile,
  getGetMyProfileQueryKey,
  getListMyPresetsQueryKey,
  getListDocumentsQueryKey,
  getGetDashboardSummaryQueryKey,
  getGetLaunchAffirmationQueryKey,
} from "@workspace/api-client-react";
import type { MissionPreset } from "@workspace/api-client-react";

function displayName(user: {
  firstName: string | null;
  lastName: string | null;
  email: string | null;
}): string {
  const parts = [user.firstName, user.lastName].filter(Boolean).join(" ");
  return parts || user.email || "User";
}

export function Layout({ children }: { children: React.ReactNode }) {
  const { user, logout } = useAuth();
  const [location] = useLocation();

  const { data: profileEnvelope } = useGetMyProfile({
    query: {
      enabled: !!user,
      retry: false,
      queryKey: getGetMyProfileQueryKey(),
    },
  });

  // The auth callback route renders without the chrome (and the
  // classification banner) even if a stale user is briefly present
  // during redirect handoff. Treat it as an unauthenticated screen.
  if (!user || location === "/auth/callback") {
    return <>{children}</>;
  }

  const isAdmin = profileEnvelope?.profile.isAdmin === true;
  const viewMode = profileEnvelope?.profile.viewMode === "operator"
    ? "operator"
    : "admin";
  // Single source of truth for whether admin-only UI affordances render.
  // Server-side authorization keys off `isAdmin` only — flipping into
  // operator view is purely presentation and never demotes the user.
  const effectiveRole: "admin" | "operator" =
    isAdmin && viewMode === "admin" ? "admin" : "operator";
  const showAdminAffordances = effectiveRole === "admin";

  const navItems = [
    { href: "/dashboard", label: "Dashboard" },
    { href: "/catalog", label: "Catalog" },
    { href: "/library", label: "Library" },
    { href: "/profile", label: "Profile" },
    { href: "/launches", label: "Launches" },
    { href: "/submissions", label: "My submissions" },
    ...(showAdminAffordances ? [{ href: "/admin", label: "Admin" }] : []),
  ];

  return (
    <div className="min-h-screen flex flex-col bg-background text-foreground">
      <div
        role="status"
        aria-label="Classification banner"
        className="w-full bg-green-500 text-black font-bold text-center text-sm tracking-widest uppercase py-1.5 border-b border-green-700"
      >
        UNCLASSIFIED (DEMO)
      </div>
      <div className="flex flex-1 min-h-0">
      <aside className="w-64 border-r border-border bg-card flex flex-col">
        <div className="px-6 py-5 border-b border-border">
          <div className="flex items-center gap-2">
            <div className="w-2 h-2 rounded-sm bg-primary" />
            <span className="text-[10px] uppercase tracking-[0.25em] text-primary font-mono font-semibold">
              DoW AI
            </span>
          </div>
          <h1 className="text-base font-semibold tracking-tight mt-1.5">
            Marketplace
          </h1>
          <p className="text-[11px] text-muted-foreground font-mono mt-0.5 uppercase tracking-wider">
            Authorized Toolkit
          </p>
        </div>
        <nav className="flex-1 p-3 space-y-0.5">
          {navItems.map((item) => {
            const isActive =
              location === item.href ||
              (item.href !== "/dashboard" && location.startsWith(item.href));
            return (
              <Link
                key={item.href}
                href={item.href}
                className={`block px-3 py-2 rounded-md text-sm transition-colors ${
                  isActive
                    ? "bg-primary/10 text-primary font-medium border-l-2 border-primary -ml-[2px] pl-[14px]"
                    : "text-muted-foreground hover:bg-accent hover:text-accent-foreground border-l-2 border-transparent -ml-[2px] pl-[14px]"
                }`}
              >
                {item.label}
              </Link>
            );
          })}
        </nav>
        <div className="p-4 border-t border-border space-y-2">
          <div className="text-sm font-medium truncate">
            {displayName(user)}
          </div>
          <div className="flex items-center justify-between gap-2">
            <span className="text-[10px] text-muted-foreground font-mono uppercase tracking-wider truncate">
              {effectiveRole === "admin" ? "Admin" : "Operator"}
            </span>
            <button
              onClick={logout}
              className="text-[11px] text-muted-foreground hover:text-foreground transition-colors"
            >
              Sign out
            </button>
          </div>
        </div>
      </aside>
      <main className="flex-1 overflow-auto flex flex-col">
        <header className="border-b border-border bg-card px-6 py-3 flex items-center justify-end gap-3">
          {isAdmin && <ViewModeSwitch viewMode={viewMode} />}
          <PresetSwitcher />
        </header>
        <div className="flex-1 overflow-auto">{children}</div>
      </main>
      </div>
    </div>
  );
}

function ViewModeSwitch({
  viewMode,
}: {
  viewMode: "admin" | "operator";
}) {
  const queryClient = useQueryClient();
  const update = useUpdateMyProfile();
  const [, setLocation] = useLocation();
  const [location] = useLocation();

  const setMode = async (next: "admin" | "operator") => {
    if (next === viewMode || update.isPending) return;
    // Optimistically patch the cached profile so the UI flips immediately
    // even before the server round-trip resolves.
    queryClient.setQueriesData(
      { queryKey: getGetMyProfileQueryKey() },
      (prev: unknown) => {
        if (!prev || typeof prev !== "object") return prev;
        const env = prev as { profile?: Record<string, unknown> };
        if (!env.profile) return prev;
        return { ...env, profile: { ...env.profile, viewMode: next } };
      },
    );
    try {
      await update.mutateAsync({
        data: { viewMode: next } as never,
      });
    } finally {
      queryClient.invalidateQueries({ queryKey: getGetMyProfileQueryKey() });
    }
    // If we just switched out of admin view while sitting on an admin
    // page, send the user home so they don't keep staring at the Admin
    // screen they no longer want to see.
    if (next === "operator" && location.startsWith("/admin")) {
      setLocation("/dashboard");
    }
  };

  return (
    <div
      className="inline-flex items-center rounded-md border border-border bg-background p-0.5"
      role="group"
      aria-label="View mode"
    >
      <button
        type="button"
        onClick={() => setMode("admin")}
        aria-pressed={viewMode === "admin"}
        className={`text-[10px] font-mono uppercase tracking-wider px-2.5 py-1 rounded ${
          viewMode === "admin"
            ? "bg-primary text-primary-foreground"
            : "text-muted-foreground hover:text-foreground"
        }`}
      >
        Admin view
      </button>
      <button
        type="button"
        onClick={() => setMode("operator")}
        aria-pressed={viewMode === "operator"}
        className={`text-[10px] font-mono uppercase tracking-wider px-2.5 py-1 rounded ${
          viewMode === "operator"
            ? "bg-primary text-primary-foreground"
            : "text-muted-foreground hover:text-foreground"
        }`}
      >
        Operator view
      </button>
    </div>
  );
}

function PresetSwitcher() {
  const queryClient = useQueryClient();
  const { data: presets } = useListMyPresets({
    query: { queryKey: getListMyPresetsQueryKey(), retry: false },
  });
  const activate = useActivateMyPreset();
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function onClick(e: MouseEvent) {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, []);

  const list: MissionPreset[] = presets ?? [];
  const active = list.find((p) => p.isActive) ?? list[0];

  const onSwitch = async (id: string) => {
    setOpen(false);
    if (!active || id === active.id) return;
    await activate.mutateAsync({ id });
    // Anything that depends on the active preset's profile or doc scope must
    // refresh: the profile sidebar (active preset id), preset list, library
    // (per-doc filter), dashboard summaries.
    queryClient.invalidateQueries({ queryKey: getListMyPresetsQueryKey() });
    queryClient.invalidateQueries({ queryKey: getGetMyProfileQueryKey() });
    queryClient.invalidateQueries({ queryKey: getListDocumentsQueryKey() });
    queryClient.invalidateQueries({
      queryKey: getGetDashboardSummaryQueryKey(),
    });
    // Switching the active preset invalidates the launch-time affirmation
    // server-side (Task #45). Invalidate the query so the marketplace's
    // CatalogDetail re-prompts the affirmation modal on the next launch.
    queryClient.invalidateQueries({
      queryKey: getGetLaunchAffirmationQueryKey(),
    });
  };

  if (!active) {
    return (
      <div className="text-[10px] uppercase tracking-wider font-mono text-muted-foreground">
        Loading mission preset…
      </div>
    );
  }

  return (
    <div ref={wrapRef} className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-3 px-3 py-1.5 rounded-md border border-border bg-background hover:border-primary/50 transition-colors"
        aria-label="Switch active preset"
      >
        <div className="text-left">
          <div className="text-[9px] font-mono uppercase tracking-wider text-muted-foreground leading-none">
            Active profile preset
          </div>
          <div className="text-sm font-medium leading-tight mt-0.5">
            {active.name}
          </div>
        </div>
        <span className="text-muted-foreground text-xs">▾</span>
      </button>
      {open && (
        <div className="absolute right-0 mt-1 w-72 bg-card border border-border rounded-md shadow-lg z-50 overflow-hidden">
          <div className="px-3 py-2 border-b border-border text-[10px] font-mono uppercase tracking-wider text-muted-foreground">
            Switch preset
          </div>
          {list.map((p) => (
            <button
              key={p.id}
              onClick={() => onSwitch(p.id)}
              className={`block w-full text-left px-3 py-2.5 hover:bg-accent transition-colors ${
                p.isActive ? "bg-primary/5" : ""
              }`}
            >
              <div className="flex items-center gap-2">
                <div
                  className={`w-1.5 h-1.5 rounded-full ${
                    p.isActive ? "bg-primary" : "bg-border"
                  }`}
                />
                <div className="text-sm font-medium">{p.name}</div>
                {p.isActive && (
                  <span className="ml-auto text-[9px] font-mono uppercase tracking-wider text-primary">
                    Active
                  </span>
                )}
              </div>
              {p.description && (
                <div className="text-xs text-muted-foreground mt-0.5 line-clamp-2 ml-3.5">
                  {p.description}
                </div>
              )}
              <div className="text-[10px] font-mono text-muted-foreground mt-1 ml-3.5">
                {p.documentIds.length} doc{p.documentIds.length === 1 ? "" : "s"}
              </div>
            </button>
          ))}
          <div className="border-t border-border px-3 py-2">
            <Link
              href="/profile"
              onClick={() => setOpen(false)}
              className="text-[11px] font-mono uppercase tracking-wider text-primary hover:underline"
            >
              Manage presets →
            </Link>
          </div>
        </div>
      )}
    </div>
  );
}
