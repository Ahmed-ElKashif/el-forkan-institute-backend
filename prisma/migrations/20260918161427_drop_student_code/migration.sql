-- The student code carried no meaning: nothing referenced it, search never used
-- it, and the Excel import neither read nor exported it. It was generated only so
-- a NOT NULL column could be satisfied.
--
-- Prisma's diff emitted a `DROP INDEX "students_student_code_key"` above this,
-- which Postgres refuses (2BP01): that index backs a UNIQUE *constraint*, not a
-- bare index. Dropping the column drops the constraint and its index with it, so
-- the one statement is the whole migration.
ALTER TABLE "students" DROP COLUMN "student_code";
