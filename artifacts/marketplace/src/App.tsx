import { Switch, Route, Router as WouterRouter, useLocation } from "wouter";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { useAuth } from "@workspace/replit-auth-web";
import { useEffect } from "react";

import { Layout } from "@/components/Layout";
import { Landing } from "@/pages/Landing";
import { AuthCallback } from "@/pages/AuthCallback";
import { Dashboard } from "@/pages/Dashboard";
import { Catalog } from "@/pages/Catalog";
import { CatalogBrowse } from "@/pages/CatalogBrowse";
import { CatalogDetail } from "@/pages/CatalogDetail";
import { Profile } from "@/pages/Profile";
import { Library } from "@/pages/Library";
import { Launches } from "@/pages/Launches";
import { Admin } from "@/pages/Admin";
import { SubmitTool } from "@/pages/SubmitTool";
import { MySubmissions } from "@/pages/MySubmissions";
import NotFound from "@/pages/not-found";

const queryClient = new QueryClient();

function ProtectedRoute({
  component: Component,
}: {
  component: React.ComponentType;
}) {
  const { isAuthenticated, isLoading } = useAuth();
  const [, setLocation] = useLocation();

  useEffect(() => {
    if (!isLoading && !isAuthenticated) {
      setLocation("/");
    }
  }, [isLoading, isAuthenticated, setLocation]);

  if (isLoading) {
    return (
      <div className="p-8 text-muted-foreground font-mono text-xs uppercase tracking-widest">
        Authenticating…
      </div>
    );
  }
  if (!isAuthenticated) {
    return null;
  }
  return <Component />;
}

function Router() {
  return (
    <Layout>
      <Switch>
        <Route path="/" component={Landing} />
        <Route path="/auth/callback" component={AuthCallback} />
        <Route path="/dashboard">
          <ProtectedRoute component={Dashboard} />
        </Route>
        <Route path="/catalog">
          <ProtectedRoute component={Catalog} />
        </Route>
        <Route path="/catalog/browse">
          <ProtectedRoute component={CatalogBrowse} />
        </Route>
        <Route path="/catalog/:slug">
          <ProtectedRoute component={CatalogDetail} />
        </Route>
        <Route path="/profile">
          <ProtectedRoute component={Profile} />
        </Route>
        <Route path="/library">
          <ProtectedRoute component={Library} />
        </Route>
        <Route path="/launches">
          <ProtectedRoute component={Launches} />
        </Route>
        <Route path="/submissions">
          <ProtectedRoute component={MySubmissions} />
        </Route>
        <Route path="/submissions/new">
          <ProtectedRoute component={SubmitTool} />
        </Route>
        <Route path="/submissions/:id/edit">
          <ProtectedRoute component={SubmitTool} />
        </Route>
        <Route path="/admin">
          <ProtectedRoute component={Admin} />
        </Route>
        <Route component={NotFound} />
      </Switch>
    </Layout>
  );
}

function App() {
  useEffect(() => {
    document.documentElement.classList.add("dark");
  }, []);

  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, "")}>
          <Router />
        </WouterRouter>
        <Toaster />
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;
