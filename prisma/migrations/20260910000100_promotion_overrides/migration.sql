-- A human disagreeing with the promotion engine, on the record (§4.3).
--
-- WHY A TABLE AND NOT A COLUMN
-- `preview()` deliberately materialises nothing — unlike `exam_eligibility`,
-- there is no computed row to overwrite in place. And `enrollments` already
-- carries final_decision / decided_at / decided_by, meaning "the verdict that
-- was committed"; a second decision column beside them would be two sources of
-- truth for one fact.
--
-- WHY after_makeup IS IN THE KEY
-- §4.3 computes a different verdict before and after the makeup round
-- (decidePromotion vs decideAfterMakeup). An override recorded before the
-- makeup must not silently re-decide the post-makeup run on stale reasoning, so
-- each round holds at most one override per enrolment.
--
-- `reason` is NOT NULL with no default: an override with no stated reason is
-- exactly what the audit log exists to prevent.

CREATE TABLE "promotion_overrides" (
  "id"            UUID         NOT NULL DEFAULT gen_random_uuid(),
  "enrollment_id" UUID         NOT NULL,
  "after_makeup"  BOOLEAN      NOT NULL DEFAULT false,
  "decision"      "decision_t" NOT NULL,
  "reason"        TEXT         NOT NULL,
  "overridden_by" UUID         NOT NULL,
  "overridden_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),

  CONSTRAINT "promotion_overrides_pkey" PRIMARY KEY ("id")
);

-- Cascade: an override is a note about one enrolment and means nothing without
-- it. `overridden_by` does NOT cascade — deleting a user must never erase the
-- record of who made a decision.
ALTER TABLE "promotion_overrides"
  ADD CONSTRAINT "promotion_overrides_enrollment_id_fkey"
  FOREIGN KEY ("enrollment_id") REFERENCES "enrollments"("id")
  ON DELETE CASCADE ON UPDATE NO ACTION;

ALTER TABLE "promotion_overrides"
  ADD CONSTRAINT "promotion_overrides_overridden_by_fkey"
  FOREIGN KEY ("overridden_by") REFERENCES "users"("id")
  ON DELETE NO ACTION ON UPDATE NO ACTION;

CREATE UNIQUE INDEX "promotion_overrides_enrollment_id_after_makeup_key"
  ON "promotion_overrides"("enrollment_id", "after_makeup");

CREATE INDEX "promotion_overrides_enrollment_id_idx"
  ON "promotion_overrides"("enrollment_id");
