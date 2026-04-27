import { useEffect } from "react";
import { useLocation } from "wouter";

export function AuthCallback() {
  const [, setLocation] = useLocation();
  useEffect(() => {
    setLocation("/dashboard");
  }, [setLocation]);
  return (
    <div className="min-h-screen flex items-center justify-center bg-background">
      <div className="text-muted-foreground font-mono text-xs uppercase tracking-widest">
        Establishing session…
      </div>
    </div>
  );
}
