import { sql } from "drizzle-orm";
import {
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  varchar,
} from "drizzle-orm/pg-core";
import { usersTable } from "./auth";
import { toolsTable } from "./catalog";

export const toolReviewsTable = pgTable(
  "tool_reviews",
  {
    id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
    userId: varchar("user_id")
      .notNull()
      .references(() => usersTable.id, { onDelete: "cascade" }),
    toolId: varchar("tool_id")
      .notNull()
      .references(() => toolsTable.id, { onDelete: "cascade" }),
    rating: integer("rating").notNull(),
    comment: text("comment"),
    hiddenAt: timestamp("hidden_at", { withTimezone: true }),
    hiddenReason: text("hidden_reason"),
    hiddenBy: varchar("hidden_by").references(() => usersTable.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    uniqueIndex("tool_reviews_user_tool_idx").on(t.userId, t.toolId),
    index("tool_reviews_tool_id_idx").on(t.toolId),
  ],
);

export type ToolReview = typeof toolReviewsTable.$inferSelect;
export type InsertToolReview = typeof toolReviewsTable.$inferInsert;
