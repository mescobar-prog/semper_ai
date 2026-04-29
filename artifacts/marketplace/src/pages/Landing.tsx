import { useAuth } from "@workspace/replit-auth-web";
import { useLocation } from "wouter";
import { useEffect } from "react";

export function Landing() {
  const { isAuthenticated, isLoading } = useAuth();
  const [, setLocation] = useLocation();

  useEffect(() => {
    if (!isLoading && isAuthenticated) {
      setLocation("/dashboard");
    }
  }, [isLoading, isAuthenticated, setLocation]);

  if (isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <div className="text-muted-foreground font-mono text-xs uppercase tracking-widest">
          Initializing system…
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background text-foreground relative overflow-hidden">
      <div
        className="absolute inset-0 opacity-[0.03] pointer-events-none"
        style={{
          backgroundImage:
            "linear-gradient(to right, currentColor 1px, transparent 1px), linear-gradient(to bottom, currentColor 1px, transparent 1px)",
          backgroundSize: "40px 40px",
        }}
      />
      <div className="absolute top-0 left-0 right-0 h-px bg-gradient-to-r from-transparent via-primary/40 to-transparent" />

      <header className="relative px-8 py-6 flex items-center justify-between">
        <div className="flex items-center gap-2.5">
          <div className="w-2.5 h-2.5 rounded-sm bg-primary" />
          <span className="text-xs uppercase tracking-[0.3em] text-primary font-mono font-semibold">
            Semper AI
          </span>
        </div>
        <a
          href="/api/login?returnTo=/"
          className="text-xs uppercase tracking-widest font-mono text-muted-foreground hover:text-foreground transition-colors"
        >
          Sign in →
        </a>
      </header>

      <div className="relative max-w-5xl mx-auto px-8 pt-24 pb-32">
        <div className="text-[10px] uppercase tracking-[0.4em] text-primary font-mono mb-6">
          / Authorized Tooling Storefront
        </div>
        <h1 className="text-5xl md:text-7xl font-semibold tracking-tight leading-[0.95] mb-8">
          The AI workbench
          <br />
          <span className="text-primary">for service members.</span>
        </h1>
        <p className="text-lg text-muted-foreground max-w-2xl leading-relaxed mb-10">
          Discover authorized AI tools with full ATO transparency. Build a
          structured profile and a personal knowledge base once — every tool
          you launch receives mission-relevant context the moment you open it.
        </p>
        <div className="flex items-center gap-4">
          <a
            href="/api/login?returnTo=/"
            className="inline-flex h-11 items-center px-6 rounded-md bg-primary text-primary-foreground font-medium text-sm hover:bg-primary/90 transition-colors"
          >
            Sign in to access
          </a>
          <a
            href="#how"
            className="text-sm text-muted-foreground hover:text-foreground transition-colors"
          >
            How it works
          </a>
        </div>
      </div>

      <div id="how" className="relative border-t border-border bg-card/30">
        <div className="max-w-5xl mx-auto px-8 py-20 grid md:grid-cols-2 lg:grid-cols-4 gap-10">
          {[
            {
              n: "01",
              t: "Build your operator profile",
              d: "Branch, rank, MOS, mission, deployment status, security clearance, AI use cases. A built-in copilot helps you fill it in conversationally.",
            },
            {
              n: "02",
              t: "Upload your knowledge base",
              d: "Drop in TTPs, SOPs, mission briefs, OPORDs, study materials. Every tool launch searches this library on your behalf.",
            },
            {
              n: "03",
              t: "Define your context",
              d: "Spell out the mission, audience, constraints, and success criteria for the work you're about to do. The Context Block ships with every launch so tools never have to guess.",
            },
            {
              n: "04",
              t: "Launch with context",
              d: "Every authorized tool you open receives your profile, your Context Block, and the relevant snippets from your library. No copy-pasting context into every new session.",
            },
          ].map((step) => (
            <div key={step.n}>
              <div className="text-[10px] font-mono text-primary uppercase tracking-widest mb-3">
                {step.n}
              </div>
              <div className="text-base font-semibold mb-2">{step.t}</div>
              <p className="text-sm text-muted-foreground leading-relaxed">
                {step.d}
              </p>
            </div>
          ))}
        </div>
      </div>

      <div className="relative border-t border-border">
        <div className="max-w-5xl mx-auto px-8 py-16">
          <div className="text-[10px] uppercase tracking-[0.3em] text-primary font-mono mb-3">
            ATO Transparency
          </div>
          <h2 className="text-2xl font-semibold tracking-tight mb-4 max-w-2xl">
            Every tool ships with its authority status, impact level, and data
            classification visible up front.
          </h2>
          <div className="flex flex-wrap gap-2 mt-6">
            {[
              ["Full ATO", "good"],
              ["Interim Authority", "info"],
              ["In ATO Review", "warn"],
              ["IL2", "neutral"],
              ["IL4", "neutral"],
              ["IL5", "neutral"],
              ["IL6", "neutral"],
              ["CUI", "neutral"],
            ].map(([label, tone]) => {
              const TONES: Record<string, string> = {
                good: "bg-emerald-500/10 text-emerald-400 border-emerald-500/30",
                info: "bg-sky-500/10 text-sky-400 border-sky-500/30",
                warn: "bg-amber-500/10 text-amber-400 border-amber-500/30",
                neutral: "bg-muted text-muted-foreground border-border",
              };
              return (
                <span
                  key={label}
                  className={`inline-flex items-center px-2 py-1 rounded border text-[11px] font-medium uppercase tracking-wider font-mono ${TONES[tone]}`}
                >
                  {label}
                </span>
              );
            })}
          </div>
        </div>
      </div>

      <footer className="relative border-t border-border">
        <div className="max-w-5xl mx-auto px-8 py-6 flex items-center justify-between text-xs text-muted-foreground font-mono uppercase tracking-wider">
          <span>Semper AI · MVP</span>
          <a
            href="/api/login?returnTo=/"
            className="hover:text-foreground transition-colors"
          >
            Sign in →
          </a>
        </div>
      </footer>
    </div>
  );
}
