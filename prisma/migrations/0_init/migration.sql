-- ---------------------------------------------------------------------------
-- 0_init - BASELINE migration.
--
-- Reproduces the production database as it stood on 2026-08-30, in full. It is
-- marked as already-applied on the existing database via
--     npx prisma migrate resolve --applied 0_init
-- so it only ever RUNS against a fresh database (a new environment, CI, or a
-- local dev copy).
--
-- IMPORTANT: the two sections at the bottom exist because prisma/schema.prisma
-- cannot express them, so "prisma migrate diff" will never regenerate them and
-- "prisma db push" actively DROPS the partial unique indexes. Any future
-- migration touching these tables must preserve them by hand.
-- See agent/memory.md.
-- ---------------------------------------------------------------------------

-- Extensions: pgcrypto for the gen_random_uuid() column defaults, pg_trgm for
-- the gin_trgm_ops index on students.full_name. (The Supabase platform also
-- installs pg_stat_statements / supabase_vault / uuid-ossp; those are not ours
-- and are deliberately not recreated here.)
CREATE EXTENSION IF NOT EXISTS "pgcrypto";
CREATE EXTENSION IF NOT EXISTS "pg_trgm";

-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "assessment_t" AS ENUM ('written', 'oral', 'memorization', 'research', 'practical');

-- CreateEnum
CREATE TYPE "attend_mode_t" AS ENUM ('onsite', 'online');

-- CreateEnum
CREATE TYPE "attendance_t" AS ENUM ('present', 'absent', 'late', 'excused');

-- CreateEnum
CREATE TYPE "carry_status_t" AS ENUM ('pending', 'cleared', 'failed');

-- CreateEnum
CREATE TYPE "decision_t" AS ENUM ('promote', 'promote_with_carry', 'repeat', 'makeup_required', 'graduate', 'withdrawn');

-- CreateEnum
CREATE TYPE "delivery_mode_t" AS ENUM ('onsite', 'online', 'hybrid');

-- CreateEnum
CREATE TYPE "enrollment_status_t" AS ENUM ('active', 'completed', 'withdrawn');

-- CreateEnum
CREATE TYPE "entry_type_t" AS ENUM ('new', 'promoted', 'promoted_with_carry', 'repeater', 'skipped_prep', 'transfer');

-- CreateEnum
CREATE TYPE "exam_type_t" AS ENUM ('term_1', 'term_2', 'makeup', 'placement');

-- CreateEnum
CREATE TYPE "exceed_action_t" AS ENUM ('warn_only', 'block_exam');

-- CreateEnum
CREATE TYPE "gender_t" AS ENUM ('male', 'female');

-- CreateEnum
CREATE TYPE "grading_mode_t" AS ENUM ('score', 'pass_fail');

-- CreateEnum
CREATE TYPE "import_action_t" AS ENUM ('create', 'update', 'skip', 'error');

-- CreateEnum
CREATE TYPE "job_status_t" AS ENUM ('pending', 'running', 'completed', 'failed');

-- CreateEnum
CREATE TYPE "message_status_t" AS ENUM ('queued', 'sent', 'delivered', 'read', 'failed');

-- CreateEnum
CREATE TYPE "period_status_t" AS ENUM ('planned', 'active', 'closed');

-- CreateEnum
CREATE TYPE "placement_method_t" AS ENUM ('entrance_exam', 'recommendation');

-- CreateEnum
CREATE TYPE "result_t" AS ENUM ('pass', 'fail', 'absent', 'pending');

-- CreateEnum
CREATE TYPE "session_status_t" AS ENUM ('scheduled', 'held', 'cancelled');

-- CreateEnum
CREATE TYPE "student_status_t" AS ENUM ('active', 'graduated', 'withdrawn', 'suspended');

-- CreateEnum
CREATE TYPE "user_role_t" AS ENUM ('head_teacher', 'teacher');

-- CreateTable
CREATE TABLE "academic_years" (
    "id" SMALLSERIAL NOT NULL,
    "hijri_year" SMALLINT NOT NULL,
    "starts_on" DATE NOT NULL,
    "ends_on" DATE NOT NULL,
    "status" "period_status_t" NOT NULL DEFAULT 'planned',
    "created_by" UUID,
    "updated_by" UUID,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "academic_years_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "attendance" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "session_id" UUID NOT NULL,
    "enrollment_id" UUID NOT NULL,
    "status" "attendance_t" NOT NULL,
    "attended_mode" "attend_mode_t",
    "minutes_late" SMALLINT,
    "note" TEXT,
    "recorded_by" UUID,
    "recorded_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "attendance_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "attendance_policies" (
    "id" SERIAL NOT NULL,
    "academic_year_id" SMALLINT NOT NULL,
    "level_id" SMALLINT,
    "max_absences" SMALLINT NOT NULL DEFAULT 4,
    "warn_at_absences" SMALLINT NOT NULL DEFAULT 3,
    "auto_warn_enabled" BOOLEAN NOT NULL DEFAULT true,
    "exceeding_action" "exceed_action_t" NOT NULL DEFAULT 'warn_only',
    "updated_by" UUID,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "attendance_policies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "attendance_warnings" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "enrollment_id" UUID NOT NULL,
    "term_id" INTEGER NOT NULL,
    "threshold" SMALLINT NOT NULL,
    "absence_count" SMALLINT NOT NULL,
    "message_id" BIGINT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "attendance_warnings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_logs" (
    "id" BIGSERIAL NOT NULL,
    "actor_id" UUID,
    "action" TEXT NOT NULL,
    "entity_type" TEXT NOT NULL,
    "entity_id" TEXT,
    "before" JSONB,
    "after" JSONB,
    "ip_address" INET,
    "user_agent" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "books" (
    "id" SERIAL NOT NULL,
    "title_ar" TEXT NOT NULL,
    "author_ar" TEXT,
    "notes" TEXT,
    "is_active" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "books_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "branches" (
    "id" SMALLSERIAL NOT NULL,
    "name_ar" TEXT NOT NULL,
    "governorate_id" SMALLINT,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "branches_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "carried_subjects" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "enrollment_id" UUID NOT NULL,
    "from_enrollment_id" UUID NOT NULL,
    "subject_id" INTEGER NOT NULL,
    "origin_level_id" SMALLINT NOT NULL,
    "status" "carry_status_t" NOT NULL DEFAULT 'pending',
    "cleared_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "carried_subjects_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "certificates" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "student_id" UUID NOT NULL,
    "level_id" SMALLINT NOT NULL,
    "enrollment_id" UUID,
    "academic_year_id" SMALLINT,
    "branch_id" SMALLINT,
    "serial_no" TEXT,
    "issued_by" UUID NOT NULL,
    "issued_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revoked_at" TIMESTAMPTZ(6),
    "revoked_by" UUID,
    "revoke_reason" TEXT,
    "notes" TEXT,

    CONSTRAINT "certificates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "curriculum" (
    "id" SERIAL NOT NULL,
    "academic_year_id" SMALLINT NOT NULL,
    "level_id" SMALLINT NOT NULL,
    "subject_id" INTEGER NOT NULL,
    "term_number" SMALLINT NOT NULL,
    "parent_curriculum_id" INTEGER,
    "is_examinable" BOOLEAN NOT NULL DEFAULT true,
    "is_mandatory" BOOLEAN NOT NULL DEFAULT false,
    "grading_mode" "grading_mode_t" NOT NULL DEFAULT 'score',
    "assessment_type" "assessment_t" NOT NULL DEFAULT 'written',
    "max_score" DECIMAL(6,2) NOT NULL DEFAULT 100,
    "pass_score" DECIMAL(6,2) NOT NULL DEFAULT 50,
    "weight" DECIMAL(5,2) NOT NULL DEFAULT 1.00,
    "teaching_order" SMALLINT,
    "updated_by" UUID,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "curriculum_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "curriculum_units" (
    "id" SERIAL NOT NULL,
    "curriculum_id" INTEGER NOT NULL,
    "book_id" INTEGER,
    "unit_label" TEXT,
    "syllabus_scope_ar" TEXT NOT NULL,
    "alternative_group" SMALLINT,
    "sort_order" SMALLINT NOT NULL DEFAULT 1,
    "updated_by" UUID,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "curriculum_units_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "enrollments" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "student_id" UUID NOT NULL,
    "section_id" UUID NOT NULL,
    "academic_year_id" SMALLINT NOT NULL,
    "branch_id" SMALLINT NOT NULL,
    "gender" "gender_t" NOT NULL,
    "entry_type" "entry_type_t" NOT NULL DEFAULT 'new',
    "status" "enrollment_status_t" NOT NULL DEFAULT 'active',
    "default_attendance_mode" "attend_mode_t" NOT NULL DEFAULT 'onsite',
    "final_decision" "decision_t",
    "decided_at" TIMESTAMPTZ(6),
    "decided_by" UUID,
    "is_historical" BOOLEAN NOT NULL DEFAULT false,
    "created_by" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "enrollments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "exam_eligibility" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "exam_id" UUID NOT NULL,
    "enrollment_id" UUID NOT NULL,
    "is_eligible" BOOLEAN NOT NULL,
    "reason_code" TEXT NOT NULL,
    "reason_note" TEXT,
    "seat_no" TEXT,
    "computed_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "overridden_by" UUID,
    "overridden_at" TIMESTAMPTZ(6),

    CONSTRAINT "exam_eligibility_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "exam_results" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "exam_id" UUID NOT NULL,
    "enrollment_id" UUID NOT NULL,
    "score" DECIMAL(6,2),
    "is_absent" BOOLEAN NOT NULL DEFAULT false,
    "result" "result_t" NOT NULL DEFAULT 'pending',
    "entered_by" UUID,
    "entered_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_by" UUID,
    "updated_at" TIMESTAMPTZ(6),

    CONSTRAINT "exam_results_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "exams" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "branch_id" SMALLINT NOT NULL,
    "academic_year_id" SMALLINT NOT NULL,
    "term_id" INTEGER NOT NULL,
    "curriculum_id" INTEGER NOT NULL,
    "gender" "gender_t",
    "exam_type" "exam_type_t" NOT NULL,
    "scheduled_at" TIMESTAMPTZ(6),
    "duration_min" SMALLINT,
    "venue" TEXT,
    "is_locked" BOOLEAN NOT NULL DEFAULT false,
    "locked_at" TIMESTAMPTZ(6),
    "created_by" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "exams_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "governorates" (
    "id" SMALLSERIAL NOT NULL,
    "name_ar" TEXT NOT NULL,
    "name_en" TEXT,

    CONSTRAINT "governorates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "grade_changes" (
    "id" BIGSERIAL NOT NULL,
    "exam_result_id" UUID NOT NULL,
    "old_score" DECIMAL(6,2),
    "new_score" DECIMAL(6,2),
    "old_result" "result_t",
    "new_result" "result_t",
    "reason" TEXT NOT NULL,
    "changed_by" UUID NOT NULL,
    "changed_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "grade_changes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "import_jobs" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "import_type" TEXT NOT NULL,
    "branch_id" SMALLINT,
    "academic_year_id" SMALLINT,
    "is_historical" BOOLEAN NOT NULL DEFAULT false,
    "storage_path" TEXT NOT NULL,
    "original_filename" TEXT,
    "status" "job_status_t" NOT NULL DEFAULT 'pending',
    "total_rows" INTEGER,
    "ok_rows" INTEGER,
    "failed_rows" INTEGER,
    "error_report_path" TEXT,
    "committed_at" TIMESTAMPTZ(6),
    "created_by" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finished_at" TIMESTAMPTZ(6),

    CONSTRAINT "import_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "import_rows" (
    "id" BIGSERIAL NOT NULL,
    "import_job_id" UUID NOT NULL,
    "sheet_name" TEXT,
    "row_number" INTEGER NOT NULL,
    "raw" JSONB NOT NULL,
    "parsed" JSONB,
    "action" "import_action_t",
    "match_student_id" UUID,
    "error_message" TEXT,

    CONSTRAINT "import_rows_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "institute_settings" (
    "id" SMALLINT NOT NULL DEFAULT 1,
    "name_ar" TEXT NOT NULL DEFAULT 'دورات الفرقان التثقيفية',
    "default_lecture_weekday" SMALLINT NOT NULL DEFAULT 5,
    "timezone" TEXT NOT NULL DEFAULT 'Africa/Cairo',
    "year_start_hijri_month" SMALLINT NOT NULL DEFAULT 10,
    "year_start_hijri_day" SMALLINT NOT NULL DEFAULT 15,
    "year_end_hijri_month" SMALLINT NOT NULL DEFAULT 8,
    "year_end_hijri_day" SMALLINT NOT NULL DEFAULT 15,
    "sessions_per_term" SMALLINT NOT NULL DEFAULT 15,
    "default_max_score" DECIMAL(6,2) NOT NULL DEFAULT 100,
    "default_pass_score" DECIMAL(6,2) NOT NULL DEFAULT 50,
    "placement_default_max" DECIMAL(6,2) NOT NULL DEFAULT 100,
    "placement_default_pass" DECIMAL(6,2) NOT NULL DEFAULT 50,
    "reminder_weekday" SMALLINT NOT NULL DEFAULT 4,
    "reminder_send_time" TIME(6) NOT NULL DEFAULT '18:00:00'::time without time zone,
    "whatsapp_business_phone" TEXT,
    "whatsapp_phone_number_id" TEXT,
    "whatsapp_owner_user_id" UUID,
    "updated_by" UUID,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "institute_settings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "job_runs" (
    "id" BIGSERIAL NOT NULL,
    "job_name" TEXT NOT NULL,
    "run_key" TEXT NOT NULL,
    "status" "job_status_t" NOT NULL DEFAULT 'running',
    "started_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finished_at" TIMESTAMPTZ(6),
    "error" TEXT,

    CONSTRAINT "job_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "levels" (
    "id" SMALLSERIAL NOT NULL,
    "code" TEXT NOT NULL,
    "name_ar" TEXT NOT NULL,
    "sort_order" SMALLINT NOT NULL,
    "is_optional" BOOLEAN NOT NULL DEFAULT false,
    "is_terminal" BOOLEAN NOT NULL DEFAULT false,
    "allows_carry" BOOLEAN NOT NULL DEFAULT true,
    "grants_certificate" BOOLEAN NOT NULL DEFAULT true,
    "requires_clean_entry" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "levels_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "markazes" (
    "id" SERIAL NOT NULL,
    "governorate_id" SMALLINT NOT NULL,
    "name_ar" TEXT NOT NULL,
    "name_en" TEXT,

    CONSTRAINT "markazes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "message_campaigns" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "template_id" INTEGER NOT NULL,
    "section_id" UUID,
    "target_date" DATE,
    "target_filter" JSONB NOT NULL DEFAULT '{}',
    "scheduled_at" TIMESTAMPTZ(6),
    "sent_at" TIMESTAMPTZ(6),
    "status" "job_status_t" NOT NULL DEFAULT 'pending',
    "created_by" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "message_campaigns_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "message_templates" (
    "id" SERIAL NOT NULL,
    "code" TEXT NOT NULL,
    "channel" TEXT NOT NULL DEFAULT 'whatsapp',
    "language" TEXT NOT NULL DEFAULT 'ar',
    "body" TEXT NOT NULL,
    "provider_template_name" TEXT,
    "variables" JSONB NOT NULL DEFAULT '[]',
    "is_active" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "message_templates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "messages" (
    "id" BIGSERIAL NOT NULL,
    "campaign_id" UUID,
    "student_id" UUID,
    "phone" TEXT NOT NULL,
    "rendered_body" TEXT,
    "status" "message_status_t" NOT NULL DEFAULT 'queued',
    "provider_message_id" TEXT,
    "error_code" TEXT,
    "error_message" TEXT,
    "attempts" SMALLINT NOT NULL DEFAULT 0,
    "sent_at" TIMESTAMPTZ(6),
    "delivered_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "messages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "placement_assessments" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "student_id" UUID NOT NULL,
    "method" "placement_method_t" NOT NULL,
    "score" DECIMAL(6,2),
    "max_score" DECIMAL(6,2),
    "pass_score" DECIMAL(6,2),
    "is_passed" BOOLEAN,
    "recommended_by" UUID,
    "placed_level_id" SMALLINT NOT NULL,
    "assessed_on" DATE NOT NULL DEFAULT CURRENT_DATE,
    "notes" TEXT,
    "created_by" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "placement_assessments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "progression_rules" (
    "id" SERIAL NOT NULL,
    "academic_year_id" SMALLINT NOT NULL,
    "level_id" SMALLINT,
    "max_carried_subjects" SMALLINT NOT NULL DEFAULT 3,
    "makeup_round_enabled" BOOLEAN NOT NULL DEFAULT true,
    "carry_forward_enabled" BOOLEAN NOT NULL DEFAULT true,
    "mandatory_can_be_carried" BOOLEAN NOT NULL DEFAULT false,
    "failure_counting_unit" TEXT NOT NULL DEFAULT 'leaf',
    "updated_by" UUID,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "progression_rules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "refresh_tokens" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" UUID NOT NULL,
    "token_hash" TEXT NOT NULL,
    "family_id" UUID NOT NULL,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "consumed_at" TIMESTAMPTZ(6),
    "revoked_at" TIMESTAMPTZ(6),
    "ip_address" INET,
    "user_agent" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "refresh_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "section_teachers" (
    "section_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "gender" "gender_t" NOT NULL,
    "is_primary" BOOLEAN NOT NULL DEFAULT false,
    "assigned_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "section_teachers_pkey" PRIMARY KEY ("section_id","user_id")
);

-- CreateTable
CREATE TABLE "sections" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "branch_id" SMALLINT NOT NULL,
    "academic_year_id" SMALLINT NOT NULL,
    "level_id" SMALLINT NOT NULL,
    "gender" "gender_t" NOT NULL,
    "name" TEXT NOT NULL,
    "default_mode" "delivery_mode_t" NOT NULL DEFAULT 'onsite',
    "supervisor_id" UUID,
    "whatsapp_group_id" TEXT,
    "capacity" SMALLINT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sections_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sessions" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "section_id" UUID NOT NULL,
    "subject_id" INTEGER NOT NULL,
    "teacher_id" UUID,
    "slot_id" UUID,
    "session_no" SMALLINT,
    "session_date" DATE NOT NULL,
    "starts_at" TIME(6) NOT NULL,
    "ends_at" TIME(6) NOT NULL,
    "mode" "delivery_mode_t" NOT NULL DEFAULT 'onsite',
    "room" TEXT,
    "meeting_url" TEXT,
    "is_exception" BOOLEAN NOT NULL DEFAULT false,
    "status" "session_status_t" NOT NULL DEFAULT 'scheduled',
    "cancel_reason" TEXT,
    "created_by" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "students" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "student_code" TEXT NOT NULL,
    "full_name" TEXT NOT NULL,
    "gender" "gender_t" NOT NULL,
    "branch_id" SMALLINT,
    "phone" TEXT,
    "whatsapp_phone" TEXT,
    "governorate_id" SMALLINT,
    "markaz_id" INTEGER,
    "address" TEXT,
    "birth_date" DATE,
    "national_id_enc" BYTEA,
    "status" "student_status_t" NOT NULL DEFAULT 'active',
    "whatsapp_opt_in" BOOLEAN NOT NULL DEFAULT true,
    "notes" TEXT,
    "created_by" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deleted_at" TIMESTAMPTZ(6),
    "deleted_by" UUID,
    "delete_reason" TEXT,

    CONSTRAINT "students_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "subject_aliases" (
    "id" SERIAL NOT NULL,
    "subject_id" INTEGER NOT NULL,
    "alias_ar" TEXT NOT NULL,
    "normalized" TEXT NOT NULL,

    CONSTRAINT "subject_aliases_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "subjects" (
    "id" SERIAL NOT NULL,
    "code" TEXT NOT NULL,
    "name_ar" TEXT NOT NULL,
    "short_name_ar" TEXT,
    "name_en" TEXT,
    "is_active" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "subjects_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "term_results" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "enrollment_id" UUID NOT NULL,
    "term_id" INTEGER NOT NULL,
    "total_score" DECIMAL(8,2),
    "max_total" DECIMAL(8,2),
    "percentage" DECIMAL(5,2),
    "subjects_failed" SMALLINT NOT NULL DEFAULT 0,
    "mandatory_failed" SMALLINT NOT NULL DEFAULT 0,
    "result" "result_t" NOT NULL DEFAULT 'pending',
    "decision" "decision_t",
    "computed_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finalized_by" UUID,
    "finalized_at" TIMESTAMPTZ(6),

    CONSTRAINT "term_results_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "terms" (
    "id" SERIAL NOT NULL,
    "academic_year_id" SMALLINT NOT NULL,
    "term_number" SMALLINT NOT NULL,
    "starts_on" DATE NOT NULL,
    "ends_on" DATE NOT NULL,
    "exam_starts_on" DATE,
    "exam_ends_on" DATE,
    "status" "period_status_t" NOT NULL DEFAULT 'planned',
    "updated_by" UUID,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "terms_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "timetable_slots" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "section_id" UUID NOT NULL,
    "subject_id" INTEGER NOT NULL,
    "teacher_id" UUID,
    "weekday" SMALLINT NOT NULL DEFAULT 5,
    "slot_order" SMALLINT NOT NULL,
    "starts_at" TIME(6) NOT NULL,
    "ends_at" TIME(6) NOT NULL,
    "room" TEXT,
    "mode" "delivery_mode_t" NOT NULL DEFAULT 'onsite',
    "effective_from" DATE,
    "effective_to" DATE,
    "updated_by" UUID,

    CONSTRAINT "timetable_slots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "users" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "full_name" TEXT NOT NULL,
    "username" TEXT NOT NULL,
    "gender" "gender_t" NOT NULL,
    "phone" TEXT NOT NULL,
    "email" TEXT,
    "password_hash" TEXT NOT NULL,
    "role" "user_role_t" NOT NULL DEFAULT 'teacher',
    "branch_id" SMALLINT,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "failed_logins" SMALLINT NOT NULL DEFAULT 0,
    "locked_until" TIMESTAMPTZ(6),
    "last_login_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deleted_at" TIMESTAMPTZ(6),
    "deleted_by" UUID,
    "delete_reason" TEXT,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "academic_years_hijri_year_key" ON "academic_years"("hijri_year");

-- CreateIndex
CREATE INDEX "attendance_enrollment_id_status_idx" ON "attendance"("enrollment_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "attendance_session_id_enrollment_id_key" ON "attendance"("session_id", "enrollment_id");

-- CreateIndex
CREATE UNIQUE INDEX "attendance_policies_academic_year_id_level_id_key" ON "attendance_policies"("academic_year_id", "level_id");

-- CreateIndex
CREATE UNIQUE INDEX "attendance_warnings_enrollment_id_term_id_threshold_key" ON "attendance_warnings"("enrollment_id", "term_id", "threshold");

-- CreateIndex
CREATE INDEX "audit_logs_actor_id_created_at_idx" ON "audit_logs"("actor_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "audit_logs_entity_type_entity_id_created_at_idx" ON "audit_logs"("entity_type", "entity_id", "created_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "books_title_ar_author_ar_key" ON "books"("title_ar", "author_ar");

-- CreateIndex
CREATE UNIQUE INDEX "branches_name_ar_key" ON "branches"("name_ar");

-- CreateIndex
CREATE INDEX "carried_subjects_enrollment_id_status_idx" ON "carried_subjects"("enrollment_id", "status");

-- CreateIndex
CREATE INDEX "carried_subjects_status_idx" ON "carried_subjects"("status") WHERE (status = 'pending'::carry_status_t);

-- CreateIndex
CREATE UNIQUE INDEX "carried_subjects_enrollment_id_subject_id_origin_level_id_key" ON "carried_subjects"("enrollment_id", "subject_id", "origin_level_id");

-- CreateIndex
CREATE UNIQUE INDEX "certificates_serial_no_key" ON "certificates"("serial_no");

-- CreateIndex
CREATE INDEX "certificates_level_id_issued_at_idx" ON "certificates"("level_id", "issued_at" DESC);

-- CreateIndex
CREATE INDEX "certificates_student_id_idx" ON "certificates"("student_id");

-- CreateIndex
CREATE INDEX "curriculum_academic_year_id_is_mandatory_idx" ON "curriculum"("academic_year_id", "is_mandatory") WHERE (is_mandatory);

-- CreateIndex
CREATE INDEX "curriculum_academic_year_id_level_id_term_number_idx" ON "curriculum"("academic_year_id", "level_id", "term_number");

-- CreateIndex
CREATE INDEX "curriculum_parent_curriculum_id_idx" ON "curriculum"("parent_curriculum_id");

-- CreateIndex
CREATE UNIQUE INDEX "curriculum_academic_year_id_level_id_subject_id_term_number_key" ON "curriculum"("academic_year_id", "level_id", "subject_id", "term_number");

-- CreateIndex
CREATE UNIQUE INDEX "curriculum_id_academic_year_id_key" ON "curriculum"("id", "academic_year_id");

-- CreateIndex
CREATE UNIQUE INDEX "curriculum_id_academic_year_id_level_id_term_number_key" ON "curriculum"("id", "academic_year_id", "level_id", "term_number");

-- CreateIndex
CREATE INDEX "curriculum_units_curriculum_id_idx" ON "curriculum_units"("curriculum_id");

-- CreateIndex
CREATE UNIQUE INDEX "curriculum_units_curriculum_id_sort_order_key" ON "curriculum_units"("curriculum_id", "sort_order");

-- CreateIndex
CREATE INDEX "enrollments_section_id_status_idx" ON "enrollments"("section_id", "status");

-- CreateIndex
CREATE INDEX "enrollments_student_id_idx" ON "enrollments"("student_id");

-- CreateIndex
CREATE UNIQUE INDEX "enrollments_id_academic_year_id_key" ON "enrollments"("id", "academic_year_id");

-- CreateIndex
CREATE UNIQUE INDEX "enrollments_student_id_academic_year_id_key" ON "enrollments"("student_id", "academic_year_id");

-- CreateIndex
CREATE INDEX "exam_eligibility_exam_id_is_eligible_reason_code_idx" ON "exam_eligibility"("exam_id", "is_eligible", "reason_code");

-- CreateIndex
CREATE UNIQUE INDEX "exam_eligibility_exam_id_enrollment_id_key" ON "exam_eligibility"("exam_id", "enrollment_id");

-- CreateIndex
CREATE INDEX "exam_results_enrollment_id_idx" ON "exam_results"("enrollment_id");

-- CreateIndex
CREATE UNIQUE INDEX "exam_results_exam_id_enrollment_id_key" ON "exam_results"("exam_id", "enrollment_id");

-- CreateIndex
CREATE INDEX "exams_branch_id_academic_year_id_idx" ON "exams"("branch_id", "academic_year_id");

-- CreateIndex
CREATE INDEX "exams_term_id_exam_type_idx" ON "exams"("term_id", "exam_type");

-- CreateIndex
CREATE UNIQUE INDEX "exams_branch_id_term_id_curriculum_id_gender_exam_type_key" ON "exams"("branch_id", "term_id", "curriculum_id", "gender", "exam_type");

-- CreateIndex
CREATE UNIQUE INDEX "governorates_name_ar_key" ON "governorates"("name_ar");

-- CreateIndex
CREATE INDEX "grade_changes_exam_result_id_changed_at_idx" ON "grade_changes"("exam_result_id", "changed_at" DESC);

-- CreateIndex
CREATE INDEX "import_rows_import_job_id_action_idx" ON "import_rows"("import_job_id", "action");

-- CreateIndex
CREATE UNIQUE INDEX "import_rows_import_job_id_sheet_name_row_number_key" ON "import_rows"("import_job_id", "sheet_name", "row_number");

-- CreateIndex
CREATE UNIQUE INDEX "job_runs_job_name_run_key_key" ON "job_runs"("job_name", "run_key");

-- CreateIndex
CREATE UNIQUE INDEX "levels_code_key" ON "levels"("code");

-- CreateIndex
CREATE UNIQUE INDEX "levels_sort_order_key" ON "levels"("sort_order");

-- CreateIndex
CREATE UNIQUE INDEX "markazes_governorate_id_name_ar_key" ON "markazes"("governorate_id", "name_ar");

-- CreateIndex
CREATE UNIQUE INDEX "message_campaigns_template_id_section_id_target_date_key" ON "message_campaigns"("template_id", "section_id", "target_date");

-- CreateIndex
CREATE UNIQUE INDEX "message_templates_code_key" ON "message_templates"("code");

-- CreateIndex
CREATE INDEX "messages_campaign_id_status_idx" ON "messages"("campaign_id", "status");

-- CreateIndex
CREATE INDEX "messages_student_id_idx" ON "messages"("student_id");

-- CreateIndex
CREATE INDEX "placement_assessments_student_id_idx" ON "placement_assessments"("student_id");

-- CreateIndex
CREATE UNIQUE INDEX "progression_rules_academic_year_id_level_id_key" ON "progression_rules"("academic_year_id", "level_id");

-- CreateIndex
CREATE UNIQUE INDEX "refresh_tokens_token_hash_key" ON "refresh_tokens"("token_hash");

-- CreateIndex
CREATE INDEX "refresh_tokens_user_id_family_id_idx" ON "refresh_tokens"("user_id", "family_id");

-- CreateIndex
CREATE INDEX "section_teachers_user_id_idx" ON "section_teachers"("user_id");

-- CreateIndex
CREATE INDEX "sections_academic_year_id_gender_idx" ON "sections"("academic_year_id", "gender");

-- CreateIndex
CREATE INDEX "sections_branch_id_academic_year_id_idx" ON "sections"("branch_id", "academic_year_id");

-- CreateIndex
CREATE UNIQUE INDEX "sections_branch_id_academic_year_id_level_id_gender_name_key" ON "sections"("branch_id", "academic_year_id", "level_id", "gender", "name");

-- CreateIndex
CREATE UNIQUE INDEX "sections_id_academic_year_id_key" ON "sections"("id", "academic_year_id");

-- CreateIndex
CREATE UNIQUE INDEX "sections_id_branch_id_key" ON "sections"("id", "branch_id");

-- CreateIndex
CREATE UNIQUE INDEX "sections_id_gender_key" ON "sections"("id", "gender");

-- CreateIndex
CREATE INDEX "sessions_section_id_session_date_idx" ON "sessions"("section_id", "session_date");

-- CreateIndex
CREATE INDEX "sessions_session_date_idx" ON "sessions"("session_date");

-- CreateIndex
CREATE INDEX "sessions_teacher_id_session_date_idx" ON "sessions"("teacher_id", "session_date");

-- CreateIndex
CREATE UNIQUE INDEX "sessions_section_id_session_date_starts_at_key" ON "sessions"("section_id", "session_date", "starts_at");

-- CreateIndex
CREATE UNIQUE INDEX "students_student_code_key" ON "students"("student_code");

-- CreateIndex
CREATE INDEX "students_branch_id_idx" ON "students"("branch_id");

-- CreateIndex
CREATE INDEX "students_full_name_idx" ON "students" USING GIN ("full_name" gin_trgm_ops);

-- CreateIndex
CREATE INDEX "students_gender_status_idx" ON "students"("gender", "status") WHERE (deleted_at IS NULL);

-- CreateIndex
CREATE INDEX "students_phone_idx" ON "students"("phone") WHERE (phone IS NOT NULL);

-- CreateIndex
CREATE UNIQUE INDEX "students_id_gender_key" ON "students"("id", "gender");

-- CreateIndex
CREATE UNIQUE INDEX "subject_aliases_normalized_key" ON "subject_aliases"("normalized");

-- CreateIndex
CREATE UNIQUE INDEX "subjects_code_key" ON "subjects"("code");

-- CreateIndex
CREATE UNIQUE INDEX "term_results_enrollment_id_term_id_key" ON "term_results"("enrollment_id", "term_id");

-- CreateIndex
CREATE UNIQUE INDEX "terms_academic_year_id_term_number_key" ON "terms"("academic_year_id", "term_number");

-- CreateIndex
CREATE UNIQUE INDEX "terms_id_academic_year_id_key" ON "terms"("id", "academic_year_id");

-- CreateIndex
CREATE UNIQUE INDEX "timetable_slots_section_id_weekday_slot_order_key" ON "timetable_slots"("section_id", "weekday", "slot_order");

-- CreateIndex
CREATE UNIQUE INDEX "users_username_key" ON "users"("username");

-- CreateIndex
CREATE UNIQUE INDEX "users_phone_key" ON "users"("phone");

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE INDEX "users_branch_id_idx" ON "users"("branch_id");

-- CreateIndex
CREATE INDEX "users_role_idx" ON "users"("role") WHERE (deleted_at IS NULL);

-- CreateIndex
CREATE UNIQUE INDEX "users_id_gender_key" ON "users"("id", "gender");

-- AddForeignKey
ALTER TABLE "academic_years" ADD CONSTRAINT "academic_years_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "academic_years" ADD CONSTRAINT "academic_years_updated_by_fkey" FOREIGN KEY ("updated_by") REFERENCES "users"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "attendance" ADD CONSTRAINT "attendance_enrollment_id_fkey" FOREIGN KEY ("enrollment_id") REFERENCES "enrollments"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "attendance" ADD CONSTRAINT "attendance_recorded_by_fkey" FOREIGN KEY ("recorded_by") REFERENCES "users"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "attendance" ADD CONSTRAINT "attendance_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "sessions"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "attendance_policies" ADD CONSTRAINT "attendance_policies_academic_year_id_fkey" FOREIGN KEY ("academic_year_id") REFERENCES "academic_years"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "attendance_policies" ADD CONSTRAINT "attendance_policies_level_id_fkey" FOREIGN KEY ("level_id") REFERENCES "levels"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "attendance_policies" ADD CONSTRAINT "attendance_policies_updated_by_fkey" FOREIGN KEY ("updated_by") REFERENCES "users"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "attendance_warnings" ADD CONSTRAINT "attendance_warnings_enrollment_id_fkey" FOREIGN KEY ("enrollment_id") REFERENCES "enrollments"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "attendance_warnings" ADD CONSTRAINT "attendance_warnings_message_fk" FOREIGN KEY ("message_id") REFERENCES "messages"("id") ON DELETE SET NULL ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "attendance_warnings" ADD CONSTRAINT "attendance_warnings_term_id_fkey" FOREIGN KEY ("term_id") REFERENCES "terms"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_actor_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "users"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "branches" ADD CONSTRAINT "branches_governorate_id_fkey" FOREIGN KEY ("governorate_id") REFERENCES "governorates"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "carried_subjects" ADD CONSTRAINT "carried_subjects_enrollment_id_fkey" FOREIGN KEY ("enrollment_id") REFERENCES "enrollments"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "carried_subjects" ADD CONSTRAINT "carried_subjects_from_enrollment_id_fkey" FOREIGN KEY ("from_enrollment_id") REFERENCES "enrollments"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "carried_subjects" ADD CONSTRAINT "carried_subjects_origin_level_id_fkey" FOREIGN KEY ("origin_level_id") REFERENCES "levels"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "carried_subjects" ADD CONSTRAINT "carried_subjects_subject_id_fkey" FOREIGN KEY ("subject_id") REFERENCES "subjects"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "certificates" ADD CONSTRAINT "certificates_academic_year_id_fkey" FOREIGN KEY ("academic_year_id") REFERENCES "academic_years"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "certificates" ADD CONSTRAINT "certificates_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "certificates" ADD CONSTRAINT "certificates_enrollment_id_fkey" FOREIGN KEY ("enrollment_id") REFERENCES "enrollments"("id") ON DELETE SET NULL ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "certificates" ADD CONSTRAINT "certificates_issued_by_fkey" FOREIGN KEY ("issued_by") REFERENCES "users"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "certificates" ADD CONSTRAINT "certificates_level_id_fkey" FOREIGN KEY ("level_id") REFERENCES "levels"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "certificates" ADD CONSTRAINT "certificates_revoked_by_fkey" FOREIGN KEY ("revoked_by") REFERENCES "users"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "certificates" ADD CONSTRAINT "certificates_student_id_fkey" FOREIGN KEY ("student_id") REFERENCES "students"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "curriculum" ADD CONSTRAINT "curriculum_academic_year_id_fkey" FOREIGN KEY ("academic_year_id") REFERENCES "academic_years"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "curriculum" ADD CONSTRAINT "curriculum_level_id_fkey" FOREIGN KEY ("level_id") REFERENCES "levels"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "curriculum" ADD CONSTRAINT "curriculum_parent_curriculum_id_academic_year_id_level_id__fkey" FOREIGN KEY ("parent_curriculum_id", "academic_year_id", "level_id", "term_number") REFERENCES "curriculum"("id", "academic_year_id", "level_id", "term_number") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "curriculum" ADD CONSTRAINT "curriculum_subject_id_fkey" FOREIGN KEY ("subject_id") REFERENCES "subjects"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "curriculum" ADD CONSTRAINT "curriculum_updated_by_fkey" FOREIGN KEY ("updated_by") REFERENCES "users"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "curriculum_units" ADD CONSTRAINT "curriculum_units_book_id_fkey" FOREIGN KEY ("book_id") REFERENCES "books"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "curriculum_units" ADD CONSTRAINT "curriculum_units_curriculum_id_fkey" FOREIGN KEY ("curriculum_id") REFERENCES "curriculum"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "curriculum_units" ADD CONSTRAINT "curriculum_units_updated_by_fkey" FOREIGN KEY ("updated_by") REFERENCES "users"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "enrollments" ADD CONSTRAINT "enrollments_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "enrollments" ADD CONSTRAINT "enrollments_decided_by_fkey" FOREIGN KEY ("decided_by") REFERENCES "users"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "enrollments" ADD CONSTRAINT "enrollments_section_id_academic_year_id_fkey" FOREIGN KEY ("section_id", "academic_year_id") REFERENCES "sections"("id", "academic_year_id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "enrollments" ADD CONSTRAINT "enrollments_section_id_branch_id_fkey" FOREIGN KEY ("section_id", "branch_id") REFERENCES "sections"("id", "branch_id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "enrollments" ADD CONSTRAINT "enrollments_section_id_fkey" FOREIGN KEY ("section_id") REFERENCES "sections"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "enrollments" ADD CONSTRAINT "enrollments_section_id_gender_fkey" FOREIGN KEY ("section_id", "gender") REFERENCES "sections"("id", "gender") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "enrollments" ADD CONSTRAINT "enrollments_student_id_fkey" FOREIGN KEY ("student_id") REFERENCES "students"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "enrollments" ADD CONSTRAINT "enrollments_student_id_gender_fkey" FOREIGN KEY ("student_id", "gender") REFERENCES "students"("id", "gender") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "exam_eligibility" ADD CONSTRAINT "exam_eligibility_enrollment_id_fkey" FOREIGN KEY ("enrollment_id") REFERENCES "enrollments"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "exam_eligibility" ADD CONSTRAINT "exam_eligibility_exam_id_fkey" FOREIGN KEY ("exam_id") REFERENCES "exams"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "exam_eligibility" ADD CONSTRAINT "exam_eligibility_overridden_by_fkey" FOREIGN KEY ("overridden_by") REFERENCES "users"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "exam_results" ADD CONSTRAINT "exam_results_enrollment_id_fkey" FOREIGN KEY ("enrollment_id") REFERENCES "enrollments"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "exam_results" ADD CONSTRAINT "exam_results_entered_by_fkey" FOREIGN KEY ("entered_by") REFERENCES "users"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "exam_results" ADD CONSTRAINT "exam_results_exam_id_fkey" FOREIGN KEY ("exam_id") REFERENCES "exams"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "exam_results" ADD CONSTRAINT "exam_results_updated_by_fkey" FOREIGN KEY ("updated_by") REFERENCES "users"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "exams" ADD CONSTRAINT "exams_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "exams" ADD CONSTRAINT "exams_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "exams" ADD CONSTRAINT "exams_curriculum_id_academic_year_id_fkey" FOREIGN KEY ("curriculum_id", "academic_year_id") REFERENCES "curriculum"("id", "academic_year_id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "exams" ADD CONSTRAINT "exams_term_id_academic_year_id_fkey" FOREIGN KEY ("term_id", "academic_year_id") REFERENCES "terms"("id", "academic_year_id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "grade_changes" ADD CONSTRAINT "grade_changes_changed_by_fkey" FOREIGN KEY ("changed_by") REFERENCES "users"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "grade_changes" ADD CONSTRAINT "grade_changes_exam_result_id_fkey" FOREIGN KEY ("exam_result_id") REFERENCES "exam_results"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "import_jobs" ADD CONSTRAINT "import_jobs_academic_year_id_fkey" FOREIGN KEY ("academic_year_id") REFERENCES "academic_years"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "import_jobs" ADD CONSTRAINT "import_jobs_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "import_jobs" ADD CONSTRAINT "import_jobs_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "import_rows" ADD CONSTRAINT "import_rows_import_job_id_fkey" FOREIGN KEY ("import_job_id") REFERENCES "import_jobs"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "import_rows" ADD CONSTRAINT "import_rows_match_student_id_fkey" FOREIGN KEY ("match_student_id") REFERENCES "students"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "institute_settings" ADD CONSTRAINT "institute_settings_updated_by_fkey" FOREIGN KEY ("updated_by") REFERENCES "users"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "institute_settings" ADD CONSTRAINT "institute_settings_whatsapp_owner_user_id_fkey" FOREIGN KEY ("whatsapp_owner_user_id") REFERENCES "users"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "markazes" ADD CONSTRAINT "markazes_governorate_id_fkey" FOREIGN KEY ("governorate_id") REFERENCES "governorates"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "message_campaigns" ADD CONSTRAINT "message_campaigns_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "message_campaigns" ADD CONSTRAINT "message_campaigns_section_id_fkey" FOREIGN KEY ("section_id") REFERENCES "sections"("id") ON DELETE SET NULL ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "message_campaigns" ADD CONSTRAINT "message_campaigns_template_id_fkey" FOREIGN KEY ("template_id") REFERENCES "message_templates"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "messages" ADD CONSTRAINT "messages_campaign_id_fkey" FOREIGN KEY ("campaign_id") REFERENCES "message_campaigns"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "messages" ADD CONSTRAINT "messages_student_id_fkey" FOREIGN KEY ("student_id") REFERENCES "students"("id") ON DELETE SET NULL ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "placement_assessments" ADD CONSTRAINT "placement_assessments_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "placement_assessments" ADD CONSTRAINT "placement_assessments_placed_level_id_fkey" FOREIGN KEY ("placed_level_id") REFERENCES "levels"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "placement_assessments" ADD CONSTRAINT "placement_assessments_recommended_by_fkey" FOREIGN KEY ("recommended_by") REFERENCES "users"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "placement_assessments" ADD CONSTRAINT "placement_assessments_student_id_fkey" FOREIGN KEY ("student_id") REFERENCES "students"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "progression_rules" ADD CONSTRAINT "progression_rules_academic_year_id_fkey" FOREIGN KEY ("academic_year_id") REFERENCES "academic_years"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "progression_rules" ADD CONSTRAINT "progression_rules_level_id_fkey" FOREIGN KEY ("level_id") REFERENCES "levels"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "progression_rules" ADD CONSTRAINT "progression_rules_updated_by_fkey" FOREIGN KEY ("updated_by") REFERENCES "users"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "refresh_tokens" ADD CONSTRAINT "refresh_tokens_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "section_teachers" ADD CONSTRAINT "section_teachers_section_id_fkey" FOREIGN KEY ("section_id") REFERENCES "sections"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "section_teachers" ADD CONSTRAINT "section_teachers_section_id_gender_fkey" FOREIGN KEY ("section_id", "gender") REFERENCES "sections"("id", "gender") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "section_teachers" ADD CONSTRAINT "section_teachers_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "section_teachers" ADD CONSTRAINT "section_teachers_user_id_gender_fkey" FOREIGN KEY ("user_id", "gender") REFERENCES "users"("id", "gender") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "sections" ADD CONSTRAINT "sections_academic_year_id_fkey" FOREIGN KEY ("academic_year_id") REFERENCES "academic_years"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "sections" ADD CONSTRAINT "sections_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "sections" ADD CONSTRAINT "sections_level_id_fkey" FOREIGN KEY ("level_id") REFERENCES "levels"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "sections" ADD CONSTRAINT "sections_supervisor_id_fkey" FOREIGN KEY ("supervisor_id") REFERENCES "users"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_section_id_fkey" FOREIGN KEY ("section_id") REFERENCES "sections"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_slot_id_fkey" FOREIGN KEY ("slot_id") REFERENCES "timetable_slots"("id") ON DELETE SET NULL ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_subject_id_fkey" FOREIGN KEY ("subject_id") REFERENCES "subjects"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_teacher_id_fkey" FOREIGN KEY ("teacher_id") REFERENCES "users"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "students" ADD CONSTRAINT "students_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "students" ADD CONSTRAINT "students_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "students" ADD CONSTRAINT "students_deleted_by_fkey" FOREIGN KEY ("deleted_by") REFERENCES "users"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "students" ADD CONSTRAINT "students_governorate_id_fkey" FOREIGN KEY ("governorate_id") REFERENCES "governorates"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "students" ADD CONSTRAINT "students_markaz_id_fkey" FOREIGN KEY ("markaz_id") REFERENCES "markazes"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "subject_aliases" ADD CONSTRAINT "subject_aliases_subject_id_fkey" FOREIGN KEY ("subject_id") REFERENCES "subjects"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "term_results" ADD CONSTRAINT "term_results_enrollment_id_fkey" FOREIGN KEY ("enrollment_id") REFERENCES "enrollments"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "term_results" ADD CONSTRAINT "term_results_finalized_by_fkey" FOREIGN KEY ("finalized_by") REFERENCES "users"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "term_results" ADD CONSTRAINT "term_results_term_id_fkey" FOREIGN KEY ("term_id") REFERENCES "terms"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "terms" ADD CONSTRAINT "terms_academic_year_id_fkey" FOREIGN KEY ("academic_year_id") REFERENCES "academic_years"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "terms" ADD CONSTRAINT "terms_updated_by_fkey" FOREIGN KEY ("updated_by") REFERENCES "users"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "timetable_slots" ADD CONSTRAINT "timetable_slots_section_id_fkey" FOREIGN KEY ("section_id") REFERENCES "sections"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "timetable_slots" ADD CONSTRAINT "timetable_slots_subject_id_fkey" FOREIGN KEY ("subject_id") REFERENCES "subjects"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "timetable_slots" ADD CONSTRAINT "timetable_slots_teacher_id_fkey" FOREIGN KEY ("teacher_id") REFERENCES "users"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "timetable_slots" ADD CONSTRAINT "timetable_slots_updated_by_fkey" FOREIGN KEY ("updated_by") REFERENCES "users"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "users" ADD CONSTRAINT "users_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "users" ADD CONSTRAINT "users_deleted_by_fkey" FOREIGN KEY ("deleted_by") REFERENCES "users"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- ---------------------------------------------------------------------------
-- Prisma-invisible objects (hand-maintained)
-- ---------------------------------------------------------------------------

-- CHECK constraints (28) - Prisma has no way to declare these.
ALTER TABLE "academic_years" ADD CONSTRAINT "academic_years_check" CHECK ((ends_on > starts_on));
ALTER TABLE "attendance" ADD CONSTRAINT "attendance_check" CHECK (((status <> 'absent'::attendance_t) OR (attended_mode IS NULL)));
ALTER TABLE "attendance_policies" ADD CONSTRAINT "attendance_policies_check" CHECK ((warn_at_absences < max_absences));
ALTER TABLE "carried_subjects" ADD CONSTRAINT "carried_subjects_check" CHECK ((enrollment_id <> from_enrollment_id));
ALTER TABLE "certificates" ADD CONSTRAINT "certificates_check" CHECK (((revoked_at IS NULL) OR (revoke_reason IS NOT NULL)));
ALTER TABLE "curriculum" ADD CONSTRAINT "curriculum_check" CHECK (((parent_curriculum_id IS NULL) OR (parent_curriculum_id <> id)));
ALTER TABLE "curriculum" ADD CONSTRAINT "curriculum_check1" CHECK ((pass_score <= max_score));
ALTER TABLE "curriculum" ADD CONSTRAINT "curriculum_pass_score_check" CHECK ((pass_score >= (0)::numeric));
ALTER TABLE "curriculum" ADD CONSTRAINT "curriculum_term_number_check" CHECK ((term_number = ANY (ARRAY[1, 2])));
ALTER TABLE "curriculum" ADD CONSTRAINT "curriculum_weight_check" CHECK ((weight > (0)::numeric));
ALTER TABLE "exam_eligibility" ADD CONSTRAINT "exam_eligibility_check" CHECK (((overridden_by IS NULL) OR (reason_note IS NOT NULL)));
ALTER TABLE "exam_results" ADD CONSTRAINT "exam_results_check" CHECK (((NOT is_absent) OR (score IS NULL)));
ALTER TABLE "exam_results" ADD CONSTRAINT "exam_results_score_check" CHECK (((score IS NULL) OR (score >= (0)::numeric)));
ALTER TABLE "institute_settings" ADD CONSTRAINT "institute_settings_check" CHECK ((default_pass_score <= default_max_score));
ALTER TABLE "institute_settings" ADD CONSTRAINT "institute_settings_check1" CHECK ((placement_default_pass <= placement_default_max));
ALTER TABLE "institute_settings" ADD CONSTRAINT "institute_settings_id_check" CHECK ((id = 1));
ALTER TABLE "placement_assessments" ADD CONSTRAINT "placement_assessments_check" CHECK (((method <> 'entrance_exam'::placement_method_t) OR ((score IS NOT NULL) AND (max_score IS NOT NULL) AND (pass_score IS NOT NULL))));
ALTER TABLE "placement_assessments" ADD CONSTRAINT "placement_assessments_check1" CHECK (((method <> 'recommendation'::placement_method_t) OR (recommended_by IS NOT NULL)));
ALTER TABLE "placement_assessments" ADD CONSTRAINT "placement_assessments_check2" CHECK (((pass_score IS NULL) OR (max_score IS NULL) OR (pass_score <= max_score)));
ALTER TABLE "progression_rules" ADD CONSTRAINT "progression_rules_failure_counting_unit_check" CHECK ((failure_counting_unit = ANY (ARRAY['leaf'::text, 'parent'::text])));
ALTER TABLE "progression_rules" ADD CONSTRAINT "progression_rules_max_carried_subjects_check" CHECK ((max_carried_subjects >= 0));
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_check" CHECK ((ends_at > starts_at));
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_check1" CHECK (((mode <> 'online'::delivery_mode_t) OR (meeting_url IS NOT NULL) OR (status = 'cancelled'::session_status_t)));
ALTER TABLE "terms" ADD CONSTRAINT "terms_check" CHECK ((ends_on > starts_on));
ALTER TABLE "terms" ADD CONSTRAINT "terms_check1" CHECK (((exam_ends_on IS NULL) OR (exam_starts_on IS NULL) OR (exam_ends_on >= exam_starts_on)));
ALTER TABLE "terms" ADD CONSTRAINT "terms_term_number_check" CHECK ((term_number = ANY (ARRAY[1, 2])));
ALTER TABLE "timetable_slots" ADD CONSTRAINT "timetable_slots_check" CHECK ((ends_at > starts_at));
ALTER TABLE "timetable_slots" ADD CONSTRAINT "timetable_slots_weekday_check" CHECK (((weekday >= 1) AND (weekday <= 7)));

-- Partial UNIQUE indexes (2) - Prisma cannot express a partial unique index.
--   certificates:     one LIVE certificate per (student, level); revoked rows
--                     are history and must not block a re-issue.
--   section_teachers: at most one primary teacher per section.
CREATE UNIQUE INDEX IF NOT EXISTS certificates_one_active_per_student_level ON public.certificates USING btree (student_id, level_id) WHERE (revoked_at IS NULL);
CREATE UNIQUE INDEX IF NOT EXISTS section_teachers_one_primary_per_section ON public.section_teachers USING btree (section_id) WHERE is_primary;
