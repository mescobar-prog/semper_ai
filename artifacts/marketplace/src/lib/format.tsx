import type { ReactNode } from "react";

export function atoLabel(status: string): string {
  if (status === "full_ato") return "Full ATO";
  if (status === "ipa") return "Interim Authority";
  if (status === "in_review") return "In ATO Review";
  return status;
}

export function atoTone(status: string): "good" | "info" | "warn" | "neutral" {
  if (status === "full_ato") return "good";
  if (status === "ipa") return "info";
  if (status === "in_review") return "warn";
  return "neutral";
}

const TONES: Record<string, string> = {
  good: "bg-emerald-500/10 text-emerald-400 border-emerald-500/30",
  info: "bg-sky-500/10 text-sky-400 border-sky-500/30",
  warn: "bg-amber-500/10 text-amber-400 border-amber-500/30",
  neutral: "bg-muted text-muted-foreground border-border",
  destructive: "bg-rose-500/10 text-rose-400 border-rose-500/30",
};

export function Pill({
  children,
  tone = "neutral",
  mono = true,
}: {
  children: ReactNode;
  tone?: "good" | "info" | "warn" | "neutral" | "destructive";
  mono?: boolean;
}) {
  return (
    <span
      className={`inline-flex items-center px-1.5 py-0.5 rounded border text-[10px] font-medium uppercase tracking-wider ${
        mono ? "font-mono" : ""
      } ${TONES[tone]}`}
    >
      {children}
    </span>
  );
}

export function SectionHeader({
  eyebrow,
  title,
  description,
  right,
}: {
  eyebrow?: string;
  title: string;
  description?: string;
  right?: ReactNode;
}) {
  return (
    <div className="flex items-end justify-between gap-6 mb-6">
      <div>
        {eyebrow && (
          <div className="text-[10px] uppercase tracking-[0.25em] text-primary font-mono font-semibold mb-1.5">
            {eyebrow}
          </div>
        )}
        <h2 className="text-2xl font-semibold tracking-tight">{title}</h2>
        {description && (
          <p className="text-sm text-muted-foreground mt-1">{description}</p>
        )}
      </div>
      {right}
    </div>
  );
}

export function PageContainer({ children }: { children: ReactNode }) {
  return <div className="p-8 max-w-7xl mx-auto w-full">{children}</div>;
}

export function StatCard({
  label,
  value,
  hint,
}: {
  label: string;
  value: ReactNode;
  hint?: ReactNode;
}) {
  return (
    <div className="bg-card border border-border rounded-md p-4">
      <div className="text-[10px] uppercase tracking-wider text-muted-foreground font-mono font-medium">
        {label}
      </div>
      <div className="text-2xl font-semibold mt-2 tabular-nums">{value}</div>
      {hint && (
        <div className="text-xs text-muted-foreground mt-1">{hint}</div>
      )}
    </div>
  );
}

export function formatBytes(chars: number): string {
  if (chars < 1024) return `${chars} chars`;
  if (chars < 1024 * 1024) return `${(chars / 1024).toFixed(1)}K chars`;
  return `${(chars / (1024 * 1024)).toFixed(1)}M chars`;
}

export function formatDate(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export function ErrorBox({ children }: { children: ReactNode }) {
  return (
    <div className="rounded-md border border-rose-500/40 bg-rose-500/10 text-rose-300 px-4 py-3 text-sm">
      {children}
    </div>
  );
}

export function EmptyState({
  title,
  description,
  action,
}: {
  title: string;
  description?: string;
  action?: ReactNode;
}) {
  return (
    <div className="border border-dashed border-border rounded-md p-10 text-center bg-card/40">
      <div className="text-base font-medium mb-1">{title}</div>
      {description && (
        <p className="text-sm text-muted-foreground max-w-md mx-auto">
          {description}
        </p>
      )}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}
