import {
  boolean,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  serial,
  text,
  timestamp,
  uniqueIndex,
  varchar,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

/** Las tres fechas que lleva toda tabla de dominio (00-base/PLANTILLA.md). */
const timestamps = {
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
};

// ─── Base de siempre ──────────────────────────────────────────────────────────

export const users = pgTable(
  'users',
  {
    id: serial('id').primaryKey(),
    email: varchar('email', { length: 255 }).notNull(),
    passwordHash: varchar('password_hash', { length: 255 }).notNull(),
    fullName: varchar('full_name', { length: 150 }).notNull(),
    role: varchar('role', { length: 20 }).notNull().default('user'),
    /** Marca las cuentas de la demostración, para que el reinicio sepa cuáles son. */
    isDemo: boolean('is_demo').notNull().default(false),
    ...timestamps,
  },
  (t) => ({
    emailUnique: uniqueIndex('users_email_unique').on(sql`lower(${t.email})`),
  }),
);

export const refreshTokens = pgTable(
  'refresh_tokens',
  {
    id: serial('id').primaryKey(),
    userId: integer('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    tokenHash: varchar('token_hash', { length: 255 }).notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    userIdx: index('idx_refresh_tokens_user').on(t.userId),
  }),
);

export const revokedTokens = pgTable('revoked_tokens', {
  jti: varchar('jti', { length: 64 }).primaryKey(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
});

// ─── Chat ─────────────────────────────────────────────────────────────────────

export const messageRoleEnum = pgEnum('message_role', ['user', 'assistant', 'system']);

export const conversations = pgTable(
  'conversations',
  {
    id: serial('id').primaryKey(),
    userId: integer('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** Se genera con una llamada corta al modelo tras el primer intercambio. */
    title: varchar('title', { length: 200 }),
    model: varchar('model', { length: 80 }).notNull(),
    systemPrompt: text('system_prompt'),
    archivedAt: timestamp('archived_at', { withTimezone: true }),
    ...timestamps,
  },
  (t) => ({
    userIdx: index('idx_conversations_user').on(t.userId),
  }),
);

export const messages = pgTable(
  'messages',
  {
    id: serial('id').primaryKey(),
    conversationId: integer('conversation_id')
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),
    role: messageRoleEnum('role').notNull(),
    content: text('content').notNull().default(''),
    inputTokens: integer('input_tokens').notNull().default(0),
    outputTokens: integer('output_tokens').notNull().default(0),
    costCents: integer('cost_cents').notNull().default(0),
    model: varchar('model', { length: 80 }),
    /** El usuario cortó la respuesta a medias. Lo que quedó es lo que se ve. */
    stoppedByUser: boolean('stopped_by_user').notNull().default(false),
    /**
     * Mientras el modelo escribe. Sirve para que una reconexión del navegador
     * no dispare una segunda generación: si ya hay una viva, se reanuda.
     */
    streaming: boolean('streaming').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    conversationIdx: index('idx_messages_conversation').on(t.conversationId, t.id),
  }),
);

export const attachments = pgTable(
  'attachments',
  {
    id: serial('id').primaryKey(),
    conversationId: integer('conversation_id')
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),
    messageId: integer('message_id').references(() => messages.id, { onDelete: 'set null' }),
    filename: varchar('filename', { length: 255 }).notNull(),
    mimeType: varchar('mime_type', { length: 100 }).notNull(),
    sizeBytes: integer('size_bytes').notNull(),
    storageKey: varchar('storage_key', { length: 120 }).notNull(),
    /** El texto que se le pasa al modelo. El MVP no usa base vectorial. */
    extractedText: text('extracted_text'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    conversationIdx: index('idx_attachments_conversation').on(t.conversationId),
  }),
);

/**
 * Lo gastado en el periodo corriente.
 *
 * Es una fila por usuario y periodo, y se revisa **antes** de llamar al modelo.
 * Un bucle aquí no es un error de log: es una factura.
 */
export const usageLimits = pgTable(
  'usage_limits',
  {
    id: serial('id').primaryKey(),
    userId: integer('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    periodStart: timestamp('period_start', { withTimezone: true }).notNull(),
    inputTokens: integer('input_tokens').notNull().default(0),
    outputTokens: integer('output_tokens').notNull().default(0),
    costCents: integer('cost_cents').notNull().default(0),
    limitCents: integer('limit_cents').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    periodUnique: uniqueIndex('usage_limits_user_period').on(t.userId, t.periodStart),
  }),
);

export const auditLogs = pgTable(
  'audit_logs',
  {
    id: serial('id').primaryKey(),
    userId: integer('user_id').references(() => users.id, { onDelete: 'set null' }),
    action: varchar('action', { length: 80 }).notNull(),
    tableName: varchar('table_name', { length: 80 }),
    recordId: varchar('record_id', { length: 80 }),
    values: jsonb('values'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    userIdx: index('idx_audit_logs_user').on(t.userId),
  }),
);
