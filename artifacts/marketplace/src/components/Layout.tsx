import { useAuth } from "@workspace/replit-auth-web";
import { Link, useLocation } from "wouter";
import {
  useGetMyProfile,
  getGetMyProfileQueryKey,
} from "@workspace/api-client-react";

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

  const { data: profile } = useGetMyProfile({
    query: {
      enabled: !!user,
      retry: false,
      queryKey: getGetMyProfileQueryKey(),
    },
  });

  if (!user) {
    return <>{children}</>;
  }

  const isAdmin = profile?.isAdmin === true;

  const navItems = [
    { href: "/dashboard", label: "Dashboard" },
    { href: "/catalog", label: "Catalog" },
    { href: "/library", label: "Library" },
    { href: "/profile", label: "Profile" },
    { href: "/launches", label: "Launches" },
    { href: "/submissions", label: "My submissions" },
    ...(isAdmin ? [{ href: "/admin", label: "Admin" }] : []),
  ];

  return (
    <div className="min-h-screen flex bg-background text-foreground">
      <aside className="w-64 border-r border-border bg-card flex flex-col">
        <div className="px-6 py-5 border-b border-border">
          <div className="flex items-center gap-2">
            <div className="w-2 h-2 rounded-sm bg-primary" />
            <span className="text-[10px] uppercase tracking-[0.25em] text-primary font-mono font-semibold">
              DoD AI
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
              {isAdmin ? "Admin" : "Operator"}
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
      <main className="flex-1 overflow-auto">{children}</main>
    </div>
  );
}
