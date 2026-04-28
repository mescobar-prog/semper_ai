import { Router, type IRouter, type Request } from "express";
import { and, desc, eq, gt, isNull } from "drizzle-orm";
import {
  db,
  toolsTable,
  launchesTable,
  launchTokensTable,
  sessionTokensTable,
  usersTable,
} from "@workspace/db";
import {
  ExchangeContextTokenBody,
  QueryLibraryBody,
} from "@workspace/api-zod";
import { requireAuth } from "../middlewares/requireAuth";
import { generateOpaqueToken } from "../lib/tokens";
import {
  generateRagQueries,
} from "../lib/gemini-helpers";
import { searchChunks, searchChunksMultiQuery } from "../lib/rag";
import {
  buildContextBlock,
  getOrCreateProfile,
  serializeProfile,
} from "../lib/profile-helpers";
import { logger } from "../lib/logger";

const router: IRouter = Router();

const LAUNCH_TOKEN_TTL_MS = 5 * 60 * 1000;
const SESSION_TOKEN_TTL_MS = 60 * 60 * 1000;

function getOrigin(req: Request): string {
  const proto = req.headers["x-forwarded-proto"] || "https";
  const host =
    req.headers["x-forwarded-host"] || req.headers["host"] || "localhost";
  return `${proto}://${host}`;
}

router.post("/tools/:toolId/launch", requireAuth, async (req, res) => {
  const [tool] = await db
    .select()
    .from(toolsTable)
    .where(eq(toolsTable.id, String(req.params.toolId)))
    .limit(1);
  if (!tool) {
    res.status(404).json({ error: "Tool not found" });
    return;
  }
  // isActive is stored as a varchar "true"|"false" in the catalog schema, so
  // a literal "false" is truthy. Compare against the string explicitly to
  // mirror catalog-list filtering (eq(toolsTable.isActive, "true")).
  if (tool.isActive !== "true") {
    res.status(403).json({ error: "Tool is not active" });
    return;
  }

  const [launch] = await db
    .insert(launchesTable)
    .values({
      userId: req.user!.id,
      toolId: tool.id,
      status: "token_issued",
    })
    .returning();

  const token = generateOpaqueToken();
  const expiresAt = new Date(Date.now() + LAUNCH_TOKEN_TTL_MS);
  await db.insert(launchTokensTable).values({
    token,
    launchId: launch.id,
    expiresAt,
  });

  let launchUrl = tool.launchUrl;
  if (launchUrl.startsWith("/")) {
    launchUrl = `${getOrigin(req)}${launchUrl}`;
  }
  const sep = launchUrl.includes("?") ? "&" : "?";
  launchUrl = `${launchUrl}${sep}token=${encodeURIComponent(token)}`;

  res.json({
    launchId: launch.id,
    launchToken: token,
    launchUrl,
    expiresAt: expiresAt.toISOString(),
  });
});

router.post("/tools/context-exchange", async (req, res) => {
  const parsed = ExchangeContextTokenBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid request" });
    return;
  }
  const { launchToken } = parsed.data;

  // Atomically claim the token: only one concurrent request can win this UPDATE.
  // The WHERE guard ensures the token is unused and unexpired in the same SQL
  // statement that flips usedAt, so concurrent exchanges cannot both pass the
  // pre-check and both mint a session.
  const claimNow = new Date();
  const [tokenRow] = await db
    .update(launchTokensTable)
    .set({ usedAt: claimNow })
    .where(
      and(
        eq(launchTokensTable.token, launchToken),
        isNull(launchTokensTable.usedAt),
        gt(launchTokensTable.expiresAt, claimNow),
      ),
    )
    .returning();

  if (!tokenRow) {
    // Either the token does not exist, was already consumed, or is expired.
    res.status(401).json({ error: "Invalid, used, or expired launch token" });
    return;
  }

  const [launch] = await db
    .select()
    .from(launchesTable)
    .where(eq(launchesTable.id, tokenRow.launchId))
    .limit(1);
  if (!launch) {
    res.status(401).json({ error: "Launch not found" });
    return;
  }

  const [tool] = await db
    .select()
    .from(toolsTable)
    .where(eq(toolsTable.id, launch.toolId))
    .limit(1);
  const [user] = await db
    .select()
    .from(usersTable)
    .where(eq(usersTable.id, launch.userId))
    .limit(1);
  if (!tool || !user) {
    res.status(401).json({ error: "Launch context unavailable" });
    return;
  }

  const profile = await getOrCreateProfile(user.id);

  let queries: string[] = [];
  let snippets: Awaited<ReturnType<typeof searchChunksMultiQuery>> = [];
  try {
    queries = await generateRagQueries(profile, {
      name: tool.name,
      vendor: tool.vendor,
      shortDescription: tool.shortDescription,
      longDescription: tool.longDescription,
      purpose: tool.purpose,
      ragQueryTemplates: tool.ragQueryTemplates,
    });
    snippets = await searchChunksMultiQuery(user.id, queries, 4, 12);
  } catch (err) {
    logger.warn({ err }, "RAG primer failed; returning empty primer");
  }

  const now = new Date();
  const sessionToken = generateOpaqueToken();
  const sessionExpiresAt = new Date(Date.now() + SESSION_TOKEN_TTL_MS);

  await db
    .update(launchesTable)
    .set({ status: "exchanged", exchangedAt: now })
    .where(eq(launchesTable.id, launch.id));

  await db.insert(sessionTokensTable).values({
    token: sessionToken,
    launchId: launch.id,
    userId: user.id,
    toolId: tool.id,
    expiresAt: sessionExpiresAt,
  });

  const displayName =
    [user.firstName, user.lastName].filter(Boolean).join(" ") ||
    user.email ||
    user.id;

  const userPayload = {
    id: user.id,
    displayName,
    email: user.email,
  };

  res.json({
    sessionToken,
    sessionExpiresAt: sessionExpiresAt.toISOString(),
    tool: {
      id: tool.id,
      slug: tool.slug,
      name: tool.name,
      vendor: tool.vendor,
      atoStatus: tool.atoStatus,
    },
    user: userPayload,
    profile: serializeProfile(profile),
    contextBlock: buildContextBlock(userPayload, profile),
    primer: { queries, snippets },
  });
});

router.post("/tools/library-query", async (req, res) => {
  const parsed = QueryLibraryBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid request" });
    return;
  }
  const { sessionToken, query, limit } = parsed.data;

  const [sess] = await db
    .select()
    .from(sessionTokensTable)
    .where(eq(sessionTokensTable.token, sessionToken))
    .limit(1);
  if (!sess) {
    res.status(401).json({ error: "Invalid session token" });
    return;
  }
  if (sess.expiresAt.getTime() < Date.now()) {
    res.status(401).json({ error: "Session token expired" });
    return;
  }

  const snippets = await searchChunks(
    sess.userId,
    query,
    Math.min(Math.max(limit ?? 6, 1), 20),
  );

  res.json({ query, snippets });
});

router.get("/launches/recent", requireAuth, async (req, res) => {
  const rows = await db
    .select({
      id: launchesTable.id,
      toolId: launchesTable.toolId,
      toolName: toolsTable.name,
      toolSlug: toolsTable.slug,
      status: launchesTable.status,
      createdAt: launchesTable.createdAt,
    })
    .from(launchesTable)
    .innerJoin(toolsTable, eq(launchesTable.toolId, toolsTable.id))
    .where(eq(launchesTable.userId, req.user!.id))
    .orderBy(desc(launchesTable.createdAt))
    .limit(10);

  res.json(
    rows.map((r) => ({
      id: r.id,
      toolId: r.toolId,
      toolName: r.toolName,
      toolSlug: r.toolSlug,
      status: r.status,
      createdAt: r.createdAt.toISOString(),
    })),
  );
});

export default router;
