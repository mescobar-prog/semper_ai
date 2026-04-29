import type { Response } from "express";
import type { ZodError } from "zod";
import { logger } from "./logger";

export function respondInvalidRequest(
  res: Response,
  error: ZodError,
  message = "Invalid request",
  context?: string,
): void {
  logger.warn(
    { issues: error.issues, context },
    `${context ?? "request"} rejected: ${message}`,
  );
  res.status(400).json({ error: message, issues: error.issues });
}
