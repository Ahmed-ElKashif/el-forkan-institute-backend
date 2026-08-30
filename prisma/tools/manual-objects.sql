-- ---------------------------------------------------------------------------
-- Prisma-INVISIBLE database objects — the source of truth for anything
-- `prisma/schema.prisma` cannot express.
--
-- WHY THIS FILE EXISTS
-- Prisma cannot represent a *partial* unique index, so the two below live in
-- the schema only as comments. `prisma db push` reconciles the database to
-- match the schema exactly and therefore SILENTLY DROPS them (confirmed:
-- a push on 2026-08-30 removed both). CHECK constraints, by contrast, survive
-- a push untouched, so they are not repeated here — they remain enforced in the
-- DB and documented in the bootstrap DDL.
--
-- RULE: do NOT run `prisma db push` against this database. If you ever do (or
-- after any operation that could have reconciled indexes), re-apply this file:
--     npm run db:manual
-- It is idempotent (IF NOT EXISTS), so running it repeatedly is safe.
--
-- THIS FILE IS A REPAIR TOOL, NOT THE SOURCE OF TRUTH. A fresh database gets
-- these indexes from prisma/migrations/0_init, which contains the same two
-- statements. Keep the two in step if they ever change.
-- ---------------------------------------------------------------------------

-- One LIVE certificate per (student, level). Revoked rows are kept as history
-- and must not block a re-issue, hence the partial predicate. (§4.5)
CREATE UNIQUE INDEX IF NOT EXISTS certificates_one_active_per_student_level
    ON certificates (student_id, level_id)
    WHERE revoked_at IS NULL;

-- At most one primary teacher per section. (spec §5.1 / section_teachers)
CREATE UNIQUE INDEX IF NOT EXISTS section_teachers_one_primary_per_section
    ON section_teachers (section_id)
    WHERE is_primary;
