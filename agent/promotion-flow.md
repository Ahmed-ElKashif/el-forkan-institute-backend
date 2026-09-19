# Promotion cycle — flow trace and findings

Written to answer a specific question: *"the year picker looks wrong."* It is not.
There is no year arithmetic anywhere in the promotion path — the target year is
whatever the caller sends. What is wrong is something else, and worse.

F1 and F2 were reported first and **fixed afterwards**, on the head teacher's
instruction. F3 turned out to be intended behaviour, not a defect. F4 and F5
remain open. `src/assessment/promotion.targeting.spec.ts` now asserts the fixed
behaviour outright; removing any one of the three fixes makes it fail.

---

## 1. The flow, end to end

```
POST /promotion/preview                     assessment.controller.ts:206
  └─ PromotionService.preview()             promotion.service.ts:140-308   WRITES NOTHING
       ├─ enrollments.findMany              academic_year_id = dto.academicYearId,
       │                                    status = 'active', scoped by viewer
       ├─ is_historical row                 → decision 'repeat' + blocker, no override
       ├─ no progression rule               → blocker (never defaults)
       ├─ failed units                      exam_results where result IN (fail, absent),
       │                                    one row per leaf subject (R14)
       ├─ decidePromotion()                 rules/promotion.ts:42-65
       │   or decideAfterMakeup()           rules/promotion.ts:95-123
       └─ decision = override ?? computed   promotion.service.ts:276-302

POST /promotion/confirm                     assessment.controller.ts:214
  └─ PromotionService.confirm()             promotion.service.ts:458-611
       ├─ replays preview under the caller's scope
       ├─ refuses if any selected row has a blocker            :479-484
       ├─ refuses if the id set does not match the preview     :485-489
       ├─ assertTargetFollowsSource(dto)     refuses a target year that is the
       │                                     source year or earlier (by hijri_year)
       ├─ loadTargetSections(dto, decisions) the DECISION picks the level:
       │                                     repeat stays, everything else advances
       └─ one $transaction (maxWait 10s, timeout 60s):
            enrollments.update   final_decision, decided_at, decided_by,
                                 status = makeup_required ? 'active' : 'completed'
            graduate           → students.status = 'graduated', stop
            makeup_required    → stop (still this year's business)
            no target section  → notMovedForward++, stop
            otherwise          → enrollments.upsert into next year's section
            promote_with_carry → carried_subjects.upsert per failed subject
            repeat             → the same rows, at the same level: a repeater
                                 retakes what they failed, not the whole level
```

### The decision itself — `rules/promotion.ts:42-65`

Order is load-bearing and correct:

1. no failures → `graduate` if the level is terminal, else `promote`
2. `!allowsCarry` → `repeat` (R15, PREP)
3. failed mandatory && `!mandatoryCanBeCarried` → `makeup_required` (R17)
4. `failed.length <= maxCarriedSubjects` → `makeup_required` if the makeup round
   is enabled, else `promote_with_carry`
5. otherwise → `repeat`

### Where the "next year" comes from — and it is not computed

`loadTargetSections` reads `dto.targetAcademicYearId` verbatim
(`assessment.schema.ts:140` validates only "a positive int"). If it is absent,
the target map is empty and nobody moves forward — deliberate, and documented at
`promotion.service.ts:455-457`: the head teacher may not have opened next year's
sections yet, and inventing one would put a student on a roster nobody chose.

The **only** year increment in the codebase is `endingHijriYear()`
(`calendar/year-planner.ts:73-81`), which adds 1 when the year-end month
precedes the year-start month — Sha'ban follows Shawwal into the next Hijri
year. That is correct and is now pinned by
`calendar/year-planner.characterisation.spec.ts`.

---

## 2. Findings

### F1 — A repeating student was advanced a level anyway  · **fixed**

`promotion.service.ts`. The method's own comment said *"A repeat stays put;
everything else advances one level"*, but it was handed only the DTO and never
read the decision:

```ts
const nextLevel = levelBySortOrder.get(current.sort_order + 1) ?? undefined;
const wanted = nextLevel && !nextLevel.requires_clean_entry ? nextLevel : current;
```

Every selected row advanced alike. A student decided `repeat` got next year's
enrolment in the **next** level's section, tagged `entry_type: 'repeater'` — the
verdict said they stayed, the roster said they moved up.

Measured before the fix:

```
● leaves a repeating student in the same level
  Expected: "sec-y2-L1"
  Received: "sec-y2-L2"
```

**Fixed.** `loadTargetSections` now receives the decision per enrolment and a
`repeat` stays at its own level.

And with it, what a repeat *means*: the student retakes the subjects they
failed, not the whole level. `confirm` writes one `carried_subjects` row per
failed subject against next year's enrolment for a `repeat` exactly as it
already did for a `promote_with_carry` — same rows, same `origin_level_id`, the
only difference being the level the new enrolment sits in. The roster's
`pendingCarryCount`, the COMP gate and the export's per-level carry columns all
read those rows already, so a repeater's real obligation now shows up in each
of them.

Which of the two a failed year means is the head teacher's call, through the
existing override: the preview flags every `repeat` row and the override dialog
spells out what each choice will write.

### F2 — Students could be promoted backwards  · **fixed**

Nothing compared the target year to the source year. `academic_years.id` is an
autoincrement carrying no chronology — `hijri_year` is what orders years — and
neither was checked in `loadTargetSections` or in `ConfirmPromotionSchema`. The
UI excludes only the *current* year (`PromotionPage.tsx:163-165`), so a closed
1445 was selectable from 1448.

```
● refuses a target year that precedes the source year
  Received promise resolved instead of rejected
  Resolved to value: {"applied": 1, "enrollmentsCreated": 1, ...}
```

**Fixed.** `assertTargetFollowsSource` compares the two years by `hijri_year`
before anything is written, and refuses a target that is the same year or
earlier. The check is in the service rather than the schema because the ordering
is a fact about rows, not about the request.

### F3 — The same year is labelled two different ways  · **intended, no change**

| Screen | Renders 1447/1448 as |
|---|---|
| Years & Terms (`AcademicYearsPage.tsx:37-41`) | `١٤٤٧/١٤٤٨` |
| Promotion target picker (`ar.json:1290`) | `العام ١٤٤٨ هـ` |
| Dashboard, exports, catalogue, level hub, certificate | `١٤٤٨` |

Raised as a likely off-by-one and **confirmed as deliberate by the head
teacher**: the academic year genuinely straddles two Hijri years — it does not
start at the first month of one — so "١٤٤٧/١٤٤٨" is the honest label for the
span, and the single year is the row's key. Left exactly as it is.

### F4 — The seed contradicts the engine

`prisma/seed-institute.ts:33-44` seeds `L4` with `isTerminal: false` and leaves
`requires_clean_entry` at its default `false`, making COMP the only terminal
level. Against `rules/promotion.ts` that means a clean L4 returns `promote` and
is auto-placed into COMP — defeating R20 ("COMP is elective, never automatic")
— and nobody ever reaches `graduate`. Note `promotion.confirm.spec.ts:26`
asserts graduation with `is_terminal: true` on an L4: the test's world and the
seeder's world disagree about the same level.

### F5 — `enrollmentsCreated` is a guess, not a count

`promotion.service.ts:557`: `if (next.created_at.getTime() > Date.now() - 60_000)`.
A re-run within 60s of the first counts rows it did not create; a batch slower
than 60s undercounts. The number is reported to the head teacher in the success
toast.

---

## 3. Coverage before and after

| Area | Before | After |
|---|---|---|
| `decidePromotion` / `decideAfterMakeup` | `rules/promotion.spec.ts`, 17 cases | unchanged |
| Overrides, scoping, blocked rows | `promotion.override.spec.ts` | unchanged |
| Graduation | `promotion.confirm.spec.ts`, 2 cases | unchanged |
| **Placement (`loadTargetSections`)** | **nothing** | `promotion.targeting.spec.ts`, 12 cases |

New coverage: next-level placement, graduation writing no forward enrolment,
clean-entry levels being skipped, carry rows written with the correct
`origin_level_id`, the no-target-year path, a repeater staying at their level
and retaking only their failed subjects, and both directions of the target-year
guard.

Run with `npx jest promotion`.
