import { sql } from "drizzle-orm";
import {
  index,
  pgTable,
  text,
  timestamp,
  varchar,
} from "drizzle-orm/pg-core";
import { usersTable } from "./auth";

export const profileChatMessagesTable = pgTable(
  "profile_chat_messages",
  {
    id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
    userId: varchar("user_id")
      .notNull()
      .references(() => usersTable.id, { onDelete: "cascade" }),
    role: varchar("role").notNull(),
    content: text("content").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [index("profile_chat_messages_user_id_idx").on(t.userId)],
);

export type ProfileChatMessage = typeof profileChatMessagesTable.$inferSelect;
export type InsertProfileChatMessage =
  typeof profileChatMessagesTable.$inferInsert;
