import { type Request, type Response, type NextFunction } from "express";

export function requireAuth(req: Request, res: Response, next: NextFunction) {
  if (!req.user?.id) {
    res.status(401).json({ error: "Authentication required" });
    return;
  }
  next();
}

export async function requireAdmin(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  if (!req.user?.id) {
    res.status(401).json({ error: "Authentication required" });
    return;
  }
  const { db, profilesTable } = await import("@workspace/db");
  const { eq } = await import("drizzle-orm");
  const [profile] = await db
    .select()
    .from(profilesTable)
    .where(eq(profilesTable.userId, req.user.id))
    .limit(1);
  if (!profile || profile.isAdmin !== "true") {
    res.status(403).json({ error: "Admin access required" });
    return;
  }
  next();
}
