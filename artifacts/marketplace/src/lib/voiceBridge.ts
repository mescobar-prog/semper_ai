/**
 * Voice agent ↔ React bridge.
 *
 * The ElevenLabs Conversational AI agent calls a small set of "client tools"
 * during the conversation. Those tool implementations need to read from /
 * mutate the React tree (the catalog form, profile fields, navigation,
 * launch button, …) — but the SDK lives outside React, in a single global
 * `<VoiceAgentDock />` component.
 *
 * This module is the bridge. Pages register implementations for the tools
 * they own (e.g. /catalog registers `setContextBlockElement`); the dock's
 * `clientTools` object forwards every agent call through `runVoiceTool`,
 * which dispatches to whichever handler is currently registered.
 *
 * Design notes:
 * - Handlers are stored by name in a single Map. There is exactly one
 *   active handler per tool at a time (the most-recently-mounted page).
 * - Tools that need to switch routes first (e.g. clickEvaluate must run on
 *   /catalog) use `runVoiceToolOnRoute` to navigate then await the handler
 *   to register on the destination page.
 * - The dispatcher always returns a string (never throws across the SDK
 *   boundary). Errors come back as `Error: <message>` so the agent can
 *   read them aloud to the operator.
 */

type VoiceToolHandler = (
  args: Record<string, unknown>,
) => Promise<unknown> | unknown;

const handlers = new Map<string, VoiceToolHandler>();
const waiters = new Map<string, Array<() => void>>();

export function registerVoiceTool(
  name: string,
  handler: VoiceToolHandler,
): () => void {
  handlers.set(name, handler);
  // Wake up anyone waiting for this tool to come online (route-gated calls).
  const queued = waiters.get(name);
  if (queued && queued.length) {
    waiters.delete(name);
    queued.forEach((fn) => fn());
  }
  return () => {
    // Only unregister if we're still the current owner — protects against
    // the unmount of a stale page that re-registered after a newer page
    // already took ownership.
    if (handlers.get(name) === handler) handlers.delete(name);
  };
}

export function waitForHandler(name: string, timeoutMs = 4000): Promise<void> {
  if (handlers.has(name)) return Promise.resolve();
  return new Promise((resolve, reject) => {
    let settled = false;
    const fn = () => {
      if (settled) return;
      settled = true;
      resolve();
    };
    const list = waiters.get(name) ?? [];
    list.push(fn);
    waiters.set(name, list);
    setTimeout(() => {
      if (settled) return;
      settled = true;
      const remaining = (waiters.get(name) ?? []).filter((f) => f !== fn);
      if (remaining.length) waiters.set(name, remaining);
      else waiters.delete(name);
      reject(
        new Error(
          `Tool "${name}" did not become available within ${timeoutMs}ms`,
        ),
      );
    }, timeoutMs);
  });
}

/** Read the currently-registered handler reference (or undefined) for a tool. */
export function getRegisteredHandler(name: string): VoiceToolHandler | undefined {
  return handlers.get(name);
}

/**
 * Generic readiness primitive: poll a predicate every 50ms until it
 * returns true (or `timeoutMs` elapses). Used by handlers that need to
 * wait on application state that doesn't go through the registry —
 * e.g. CatalogDetail waiting for `params.slug` to reach the requested
 * value AND the corresponding `useGetToolBySlug` query to settle.
 */
export function waitForCondition(
  predicate: () => boolean,
  timeoutMs = 4000,
): Promise<void> {
  if (predicate()) return Promise.resolve();
  return new Promise((resolve, reject) => {
    let settled = false;
    const tick = () => {
      if (settled) return;
      try {
        if (predicate()) {
          settled = true;
          clearInterval(timer);
          resolve();
        }
      } catch (err) {
        settled = true;
        clearInterval(timer);
        reject(err);
      }
    };
    const timer = setInterval(tick, 50);
    setTimeout(() => {
      if (settled) return;
      settled = true;
      clearInterval(timer);
      reject(new Error(`condition not met within ${timeoutMs}ms`));
    }, timeoutMs);
  });
}

/**
 * Wait until the registered handler for `name` is *not* the same reference
 * as `previous`. Used by route changes between two pages that both
 * register the same tool name (e.g. CatalogDetail → CatalogDetail with a
 * different slug): plain `waitForHandler` would resolve immediately
 * because the old page's handler is still registered for the brief window
 * before the new page mounts.
 *
 * Falls back to a short polling loop instead of plumbing into the waiter
 * queue — registration always wakes the waiter queue on `set`, so a
 * 50ms tick is plenty fine for sub-second route swaps.
 */
export function waitForHandlerSwap(
  name: string,
  previous: VoiceToolHandler | undefined,
  timeoutMs = 4000,
): Promise<void> {
  if (handlers.get(name) !== previous) return Promise.resolve();
  return new Promise((resolve, reject) => {
    let settled = false;
    const tick = () => {
      if (settled) return;
      if (handlers.get(name) !== previous) {
        settled = true;
        clearInterval(timer);
        resolve();
      }
    };
    const timer = setInterval(tick, 50);
    setTimeout(() => {
      if (settled) return;
      settled = true;
      clearInterval(timer);
      reject(
        new Error(
          `Tool "${name}" did not swap to a new owner within ${timeoutMs}ms`,
        ),
      );
    }, timeoutMs);
  });
}

/** Serialise the handler result the way ElevenLabs expects (string). */
function toResultString(value: unknown): string {
  if (value === undefined || value === null) return "ok";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/**
 * Route-aware navigator the dock injects on mount. We can't depend on
 * wouter outside of React, so the dock supplies these. The bridge owns
 * the references so any registered handler can navigate / read the route.
 */
type NavRefs = {
  getCurrentRoute: () => string;
  navigate: (to: string) => void;
};

const navRef: { current: NavRefs | null } = { current: null };

export function setVoiceNav(refs: NavRefs): () => void {
  navRef.current = refs;
  return () => {
    if (navRef.current === refs) navRef.current = null;
  };
}

function getNav(): NavRefs {
  if (!navRef.current) {
    throw new Error("Voice agent dock has not mounted yet");
  }
  return navRef.current;
}

/**
 * For page-scoped tools, the canonical route the bridge will navigate to
 * if the agent calls the tool while a different page is mounted.
 *
 * Behaviour: `runVoiceTool` only auto-navigates when no handler is
 * registered for the requested tool. If a handler is already present
 * (e.g. `openTool` works from both /catalog/browse and /catalog/<slug>),
 * the bridge just runs it where you are.
 */
const PAGE_TOOL_ROUTES: Record<string, string> = {
  getProfileState: "/profile",
  setProfileField: "/profile",
  getContextBlockState: "/catalog",
  setContextBlockElement: "/catalog",
  clickEvaluate: "/catalog",
  clickConfirmContextBlock: "/catalog",
  findTool: "/catalog/browse",
  openTool: "/catalog/browse",
};

/**
 * Dispatch a single voice-tool call. Always resolves (never throws across
 * the SDK boundary) so the agent can speak the error verbatim.
 *
 * If a page-scoped tool is invoked while no handler is registered (the
 * operator/agent is on the wrong page), the bridge transparently
 * navigates to the canonical route and waits for the handler to register
 * on the new page before invoking it. This makes the conversation
 * tolerant of out-of-order tool calls.
 */
export async function runVoiceTool(
  name: string,
  args: Record<string, unknown> | undefined,
): Promise<string> {
  try {
    // Navigation + route-read tools are owned by the dock itself.
    if (name === "getCurrentRoute") {
      return getNav().getCurrentRoute();
    }
    if (name === "navigate") {
      const to = String(args?.to ?? "");
      if (!to.startsWith("/")) {
        return `Error: 'to' must start with '/'. Got: ${to}`;
      }
      getNav().navigate(to);
      return `Navigating to ${to}`;
    }
    if (name === "goToCatalogBrowse") {
      // Convenience navigation tool — handled by the dock so it never
      // depends on a specific page being mounted to register a handler.
      getNav().navigate("/catalog/browse");
      return "Navigating to catalog browse";
    }

    // Auto-navigate for page-scoped tools when no handler is online.
    if (!handlers.has(name) && PAGE_TOOL_ROUTES[name]) {
      const target = PAGE_TOOL_ROUTES[name];
      getNav().navigate(target);
      try {
        await waitForHandler(name, 4000);
      } catch {
        return `Error: tool "${name}" did not become available after navigating to ${target}.`;
      }
    }

    const handler = handlers.get(name);
    if (!handler) {
      return `Error: tool "${name}" is not available on the current page (${getNav().getCurrentRoute()}).`;
    }
    const result = await handler(args ?? {});
    return toResultString(result);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return `Error: ${msg}`;
  }
}

/**
 * Convenience: navigate to a target route, wait up to `timeoutMs` for the
 * named handler to register on the new page, then run it. Used for
 * goToCatalogBrowse and openTool where the agent's intent is "go there
 * and confirm".
 */
export async function runVoiceToolOnRoute(
  toolName: string,
  args: Record<string, unknown> | undefined,
  options: { route: string; timeoutMs?: number },
): Promise<string> {
  const { route, timeoutMs = 4000 } = options;
  try {
    const nav = getNav();
    if (nav.getCurrentRoute() !== route) {
      nav.navigate(route);
      await waitForHandler(toolName, timeoutMs);
    }
    return await runVoiceTool(toolName, args);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return `Error: ${msg}`;
  }
}

/* -------------------------------------------------------------------- */
/*  React hook                                                          */
/* -------------------------------------------------------------------- */

import { useEffect, useRef } from "react";

/**
 * Register a voice-tool implementation while a component is mounted.
 *
 * Uses a ref so the registered handler always calls the latest closure
 * without re-registering on every render.
 */
export function useVoiceTool(name: string, handler: VoiceToolHandler): void {
  const ref = useRef(handler);
  useEffect(() => {
    ref.current = handler;
  }, [handler]);
  useEffect(() => {
    return registerVoiceTool(name, (args) => ref.current(args));
    // We deliberately omit `handler` from deps — the ref keeps it fresh.
  }, [name]);
}
