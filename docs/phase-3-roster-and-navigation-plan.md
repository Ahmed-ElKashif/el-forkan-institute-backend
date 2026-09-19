# Phase 3 — De-bounce attendance/scores navigation + fold student management into the level roster

> Status: **implemented** (frontend only; no backend change was needed). Scope:
> `frontend/` routing + student management.
>
> **Deviation worth noting:** with `/students` folded away, teachers still need to
> reach a roster, which lives in the level hub. So the **Levels** nav entry became
> open to both roles (moved to the *teaching* group); its head-teacher-only tabs
> (catalogue, class days, teachers) stay gated inside the hub, as before. `/students`
> now redirects to `/levels`; `/students/:id` (the profile) stays.

## Context

The level hub shipped (Phase 1/2): six levels, a boys/girls filter, per-date class
days, date-first attendance and scores. Two problems remain in how a **teacher**
actually works day to day:

1. **Navigation bounces.** The Attendance and Scores nav entries reuse the level
   picker, but a row opens `/levels/:id?tab=attendance` — the whole level hub. So
   choosing a class inside "Attendance" throws the teacher onto the level page,
   then picking a day throws them back. Attendance and scores are the teacher's
   **daily task**, done across *all* levels; the level page is where you go to see
   **everything about one level**. These are two different jobs and should be two
   different destinations.

2. **Students can't be managed where the work is.** A teacher opens a level's
   roster but can only read it — no add, no edit, no way to record that a student
   dropped out or took the year off. The institute is a non-profit; students
   routinely take a year (or two) off and return to retake a level. There is no
   "add a student to this class" flow at all today (students only arrive via bulk
   import), and the standalone `/students` page is a separate stop.

**How comparable systems solve #1 (researched):** School/SIS products
(PowerSchool, Blackbaud, Gradelink, Google Classroom, Moodle) separate
**task-centric flows** ("Take Attendance", "Gradebook") from **entity-centric**
ones ("Classes → a class profile"). The rule they follow: *a task flow keeps you
in the task* — picking a class inside Attendance filters the attendance view in
place; it never navigates to the class's profile. That is the fix here.

**How comparable systems solve leave/return (researched, see Sources):** students
are **never deleted**. A student record is permanent; enrollment is **per academic
year** with its own status. "Took the year off" = the year's enrollment is
`withdrawn` (or none exists), the student stays findable, and returning is a
**re-enrollment**, not a re-creation. A one-year leave that doesn't require
re-applying is standard. This maps cleanly onto the existing two-level model
(`students.status` + `enrollments.status`) — **no new status enum needed**.

**Confirmed decisions:**
- "Delete someone" from a class = **withdraw the enrollment** (reversible), not
  delete the student. Head-teacher-only. Add/edit = both roles.
- **Fold `/students` into the level roster**, carrying its search and status-change
  ability. (Recommendation below reconciles this with keeping withdrawn/returning
  students findable.)

## Guiding principle — routing + frontend wiring, near-zero backend

Everything ask #2 needs already exists server-side: `POST /students`,
`PATCH /students/:id` (both roles), `POST /enrollments`, `PATCH /enrollments/:id`
(status → withdrawn, both roles), `DELETE /students/:id` (head-teacher, unused by
this plan). Ask #1 is new routes + one small shared-hook extraction. Net new
backend surface: **none** (one optional UI-parity gate noted under Open items).

---

## Part A — De-bounce attendance & scores (routing)

### A1. Shared cohort resolution (extract, don't duplicate) — `src/features/levels/`
`LevelDetailPage` already resolves `(levelId, gender, currentYear) → section` and
renders the boys/girls chip filter (`useGenderParam`, `findSection`,
`useListSectionsQuery`). Attendance and Scores pages need the same. Extract:
- `useLevelSection.ts`: `useGenderParam()` (move as-is) + `useLevelSection(levelId, gender)`
  returning `{ level, section, yearId, isLoading, notFound }`.
- A small presentational `LevelGenderHeader` (level name + back link + gender chips)
  reused by all three screens.
- Refactor `LevelDetailPage` to consume both — **behavior-preserving** (same tabs,
  same resolution). Its existing test must stay green untouched.

### A2. Two task pages — `src/features/attendance/AttendancePage.tsx`, `src/features/scores/ScoresPage.tsx`
Thin: `LevelGenderHeader` + the **existing** `AttendanceTab` / `ScoresTab`
(unchanged) fed the resolved `sectionId`. No level tabs. `notFound` → EmptyState.

### A3. Routes & picker — `src/app/App.tsx`, `src/features/levels/LevelsPage.tsx`
- Add `/attendance/:levelId` → `AttendancePage`, `/scores/:levelId` → `ScoresPage`
  (both open to both roles, inside `AppShell`). Declare `/scores/exams/:examId`
  **before** `/scores/:levelId` so the static segment wins.
- `LevelsPage`: `linkTab="attendance"` rows → `/attendance/:id`; `linkTab="scores"`
  → `/scores/:id` (replace the `?tab=` deep-link into the hub).
- The level hub (`/levels/:id`) is unchanged and still carries attendance/scores
  tabs — it remains "everything about one level" (a head teacher reviewing a level
  keeps them in context). The bounce is gone because the nav no longer routes
  through it.

---

## Part B — Student management inside the roster

### B1. Make `RosterTab` a real, reusable component — `src/features/sections/RosterTab.tsx`
Lift the roster out of `LevelDetailPage` into its own file (it will grow). Props:
`{ sectionId, sectionGender, sectionBranchId }`. Gains:
- **Search + status filter** (the `/students` capability the user wants here):
  a client-side name/code filter over the loaded cohort, plus a status
  `Select` (`active | withdrawn | completed`) that drives the enrollment query's
  `status` param (`ListEnrollmentsQuerySchema` already supports it). This is how a
  teacher sees *"who took this level off"* and can bring them back.
- **Add student** (both roles) → search-or-create dialog (B2).
- **Row edit** (both roles) → existing `StudentFormDialog` (loads `StudentDetail`
  via `useGetStudentQuery`, already has the status field for lifecycle changes).
- **Row withdraw / re-activate** (head-teacher only) → `ConfirmDialog` →
  `PATCH /enrollments/:id { status }`. This is the "remove from this class"
  action; reversible, so a returning student is re-activated or re-added.

### B2. Add-to-class = **search existing, or create new** — `src/features/students/AddToClassDialog.tsx`
This is the re-enrollment path the research calls for, folded into the roster:
- Search field → `useListStudentsQuery({ search, gender: sectionGender })`
  (gender-scoped so only enrollable students show). Pick a result → enroll
  (`POST /enrollments { studentId, sectionId }`). Covers returning/withdrawn/
  imported-but-unplaced students **without a separate directory page**.
- "Not found? Add new" → create form (reuse `StudentFormDialog`'s field layout in a
  create mode): `POST /students` with `gender = sectionGender`,
  `branchId = sectionBranchId`, code auto-generated → then `POST /enrollments`.
  Two sequential calls (not transactional — if enroll fails after create, the new
  student exists un-enrolled and is found by search to place; note in a comment).
- New api: `useCreateStudentMutation` + `useUpdateEnrollmentMutation`
  (in `students.api.ts` / `sections.api.ts`), invalidating `Student` + `Section`.

### B3. Fold away the `/students` page — `src/app/App.tsx`, `src/app/shell/navigation.ts`
- Remove the `students` nav destination and `StudentsPage` from `BUILT_SCREENS`;
  redirect `/students` → `/levels`. Keep `/students/:id` (`StudentProfilePage`) —
  roster rows still open profiles — and keep `students.api` (now consumed by the
  roster + add dialog).
- **Honest note / recommendation:** the roster is current-year + per-level, so a
  student with *no* enrollment this year is reachable only through B2's search
  (which is institute-wide) and the import screen. That covers the leave/return
  case. If a cross-level "all students" list is later missed, the cheapest re-add
  is a read-only directory — deferred (YAGNI), not built now.

### B4. i18n — `src/shared/i18n/ar.json`
New keys: roster add/edit/withdraw/reactivate, status filter labels, add-to-class
(search hint, "no match — add new", create title), withdraw-confirm text, the two
task-page headers. Arabic-first; Latin digits via `.ef-num`; no raw literals in
components.

---

## Reuse map (don't re-invent)
- `useGenderParam`, `findSection`, `useListSectionsQuery`, `useGetSectionQuery` —
  from `levels`/`sections` (extracted in A1).
- `AttendanceTab`, `ScoresTab` — from `attendance`/`scores`, **unchanged**.
- `StudentFormDialog` (edit + new create mode), `useListStudentsQuery`,
  `useGetStudentQuery`, `useListEnrollmentsQuery`, `useAssignEnrollmentMutation`,
  `StudentProfilePage` — from `students`/`sections`.
- `DataTable` + `rowActions`/`ActionMenu`, `ConfirmDialog`, `Field`/`Select`,
  `SearchInput`, `Badge`, `Toast` — DS barrel.

## Suggested execution order (incremental, each shippable)
- **A.** Extract `useLevelSection` + `LevelGenderHeader`; refactor `LevelDetailPage`
  (green). Add `AttendancePage`/`ScoresPage` + routes; repoint `LevelsPage` links.
- **B.** `RosterTab` file + search/status filter; `AddToClassDialog`
  (search-or-create); row edit/withdraw with role gating; create/enrollment api.
- **C.** Remove `/students` nav + page, redirect; i18n sweep; tests.

## Verification
- **Frontend:** `npm run typecheck`; `npx vitest run --no-file-parallelism`:
  - picking a level under `/attendance` lands on `/attendance/:id` and **stays**
    (no `/levels` navigation) — the de-bounce, asserted on `window.location`.
  - `AttendancePage`/`ScoresPage` resolve the section by gender and render the
    date-first grid; the gender chip switches cohort.
  - roster: Add-to-class enrolls an existing search hit (right `POST /enrollments`
    body); "add new" posts `POST /students` with the section's gender/branch then
    enrolls; withdraw posts `PATCH /enrollments/:id {status:'withdrawn'}` and the
    action is **absent for a teacher**, present for the head teacher; status filter
    re-queries.
  - `LevelDetailPage` existing test stays green (behavior-preserving refactor).
  - `App` routing: `/students` redirects to `/levels`; a teacher's sidebar no
    longer lists الطلاب.
- `npm run lint` (check-tokens) + `npm run build`.
- **Manual (`npm run start:dev` both ends):** teacher — Attendance → level → stays,
  mark a day; add a brand-new student to a roster; search-add a returning student;
  edit a student. Head teacher — withdraw a student from a class, then re-activate;
  confirm a teacher sees no withdraw action.
- Run **clean-code-guard / test-guard / docs-guard** on each phase's diff.

## Open items to settle in review
- Enrollment `PATCH` is open to both roles server-side; this plan gates **withdraw**
  in the UI only (per the "head-teacher deletes" rule). Add a server-side role
  check on status→withdrawn for defense-in-depth? (small, optional.)
- Whether a `suspended`/`on_leave` student-level label is wanted in addition to the
  per-year `withdrawn` enrollment (research says not needed; `withdrawn` enrollment
  + `active` student already means "on leave"). Default: don't add it.
- Whether roster search should become a server-side param on `GET /enrollments`
  (only if a cohort ever exceeds a page; client-side filter suffices at ~20/class).

## Sources (leave/withdraw/re-enroll model)
- Student Clearinghouse — enrollment statuses (Approved Leave of Absence vs
  Withdrawn): <https://help.studentclearinghouse.org/compliancecentral/knowledge-base/student-enrollment-statuses/>
- Penn State Registrar — leave of absence (interrupt enrollment ≤1yr, no re-apply):
  <https://www.registrar.psu.edu/enrollment/leaving/leave-absence.cfm>
- Columbia GS — leaves of absence, withdrawals & reinstatement:
  <https://bulletin.columbia.edu/general-studies/academic-policies/leaves-absence-withdrawals/>
