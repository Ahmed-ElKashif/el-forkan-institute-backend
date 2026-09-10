-- One class per level per gender (R1 × R3).
--
-- WHAT CHANGES
-- `name` leaves the class's unique key. It stays as a column — it is the label
-- shown on rosters, sessions and exports — but it stops being part of identity.
-- Until now a level could hold unlimited classes that differed only by label.
--
-- WHY THIS IS SAFE FOR SUBJECTS
-- Subjects reach students through `curriculum` (academic_year, level, term),
-- never through the class. One class per level therefore still teaches every
-- subject that level offers, exactly as a university year does.
--
-- WHY `gender` STAYS IN THE KEY
-- R3 keeps the rosters separate, and `sections` carries UNIQUE (id, gender) so
-- `enrollments` and `section_teachers` can point at the pair with a composite
-- FK. Dropping gender here would remove the database-level guarantee that a
-- mixed roster cannot be created. Six levels x two genders = twelve classes.
--
-- BEFORE APPLYING
-- This will FAIL while any (branch, year, level, gender) still holds more than
-- one class. Run the read-only report first and resolve what it lists:
--     node prisma/tools/report-section-merge.mjs
-- The failure is the point: it refuses rather than silently picking a winner
-- and orphaning the other class's enrolments, sessions and attendance.

-- DROP CONSTRAINT, not DROP INDEX.
-- The unique is a table CONSTRAINT here (pg_constraint.contype = 'u'), and
-- Postgres refuses to drop the index out from under it:
--     cannot drop index ... because constraint ... requires it
-- `0_init` writes this key as `CREATE UNIQUE INDEX`, which is what a Prisma
-- diff would generate — but the live database was built from
-- `schema-v1.1.sql`, where it is declared inline on the table. Trust the
-- database over the migration history when the two disagree.

ALTER TABLE "sections"
  DROP CONSTRAINT "sections_branch_id_academic_year_id_level_id_gender_name_key";

ALTER TABLE "sections"
  ADD CONSTRAINT "sections_branch_id_academic_year_id_level_id_gender_key"
  UNIQUE ("branch_id", "academic_year_id", "level_id", "gender");
