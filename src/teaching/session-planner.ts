/**
 * §8 Phase 3 — generating a term's sessions from the timetable.
 *
 * Pure: takes the term's dates, the slots and the settings, returns the
 * sessions that should exist. R4 makes Friday the *default* lecture day, not a
 * hard rule, so the weekday comes from the slot rather than being assumed.
 */

/** ISO weekday: 1 = Monday … 5 = Friday … 7 = Sunday. */
export type IsoWeekday = 1 | 2 | 3 | 4 | 5 | 6 | 7;

export interface TimetableSlot {
  id: string;
  subjectId: number;
  teacherId: string | null;
  weekday: number;
  slotOrder: number;
  startsAt: string; // 'HH:MM'
  endsAt: string;
  room: string | null;
  mode: 'onsite' | 'online' | 'hybrid';
  effectiveFrom: Date | null;
  effectiveTo: Date | null;
}

export interface PlannedSession {
  slotId: string;
  subjectId: number;
  teacherId: string | null;
  sessionNo: number;
  sessionDate: Date;
  startsAt: string;
  endsAt: string;
  room: string | null;
  mode: 'onsite' | 'online' | 'hybrid';
}

export interface SessionPlanInput {
  termStart: Date;
  termEnd: Date;
  slots: TimetableSlot[];
  /** institute_settings.sessions_per_term — 15 by default. */
  sessionsPerTerm: number;
  /** Dates the institute is closed; a slot falling on one is skipped, and the
   * numbering continues on the next occurrence rather than losing a session. */
  offDays?: Date[];
}

/**
 * Numbers sessions 1…N per slot, matching the printed attendance grid's
 * columns (§6.1). Numbering is per slot, not per section: a section with two
 * subjects on the same day has two independent session-1s, which is what the
 * grid shows.
 */
export function planSessions(input: SessionPlanInput): PlannedSession[] {
  const offDayKeys = new Set(
    (input.offDays ?? []).map((date) => toDayKey(date)),
  );
  const planned: PlannedSession[] = [];

  for (const slot of input.slots) {
    let sessionNo = 1;
    let cursor = firstOccurrence(input.termStart, slot.weekday);

    while (sessionNo <= input.sessionsPerTerm && cursor <= input.termEnd) {
      const withinSlotWindow =
        (slot.effectiveFrom === null || cursor >= slot.effectiveFrom) &&
        (slot.effectiveTo === null || cursor <= slot.effectiveTo);

      if (withinSlotWindow && !offDayKeys.has(toDayKey(cursor))) {
        planned.push({
          slotId: slot.id,
          subjectId: slot.subjectId,
          teacherId: slot.teacherId,
          sessionNo,
          sessionDate: cursor,
          startsAt: slot.startsAt,
          endsAt: slot.endsAt,
          room: slot.room,
          mode: slot.mode,
        });
        sessionNo += 1;
      }
      cursor = addDays(cursor, 7);
    }
  }

  return planned;
}

/**
 * The first date on or after `from` that falls on `weekday`.
 *
 * `getUTCDay()` is 0=Sunday…6=Saturday; ISO is 1=Monday…7=Sunday. Converting
 * with `|| 7` maps Sunday's 0 to 7 — the one value that would otherwise be
 * wrong, and the reason this is a named function rather than inline
 * arithmetic.
 */
function firstOccurrence(from: Date, weekday: number): Date {
  const isoWeekdayOfFrom = from.getUTCDay() || 7;
  const daysAhead = (weekday - isoWeekdayOfFrom + 7) % 7;
  return addDays(from, daysAhead);
}

function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * 86_400_000);
}

function toDayKey(date: Date): string {
  return date.toISOString().slice(0, 10);
}

// -------------------------------------------------------------- clash rules

export interface SlotWindow {
  slotId: string;
  teacherId: string | null;
  weekday: number;
  startsAt: string;
  endsAt: string;
  effectiveFrom: Date | null;
  effectiveTo: Date | null;
}

/**
 * A teacher cannot be in two places at once (§8 Phase 3, "teacher clash
 * detection").
 *
 * Two slots clash when they share a teacher and a weekday, their time ranges
 * overlap, and their effective-date windows overlap. A slot that ended before
 * the other began is not a clash — the timetable changes mid-year.
 *
 * Times are 'HH:MM' strings compared lexicographically, which is exact for
 * zero-padded 24-hour times and avoids inventing a Date for a wall-clock time
 * that has no date.
 */
export function findClashes(
  candidate: SlotWindow,
  existing: SlotWindow[],
): SlotWindow[] {
  if (candidate.teacherId === null) {
    return [];
  }
  return existing.filter(
    (other) =>
      other.slotId !== candidate.slotId &&
      other.teacherId === candidate.teacherId &&
      other.weekday === candidate.weekday &&
      timesOverlap(candidate, other) &&
      datesOverlap(candidate, other),
  );
}

// Touching endpoints do not overlap: a 10:00–11:00 slot and an 11:00–12:00
// slot are back to back, which is how a timetable is meant to look.
function timesOverlap(a: SlotWindow, b: SlotWindow): boolean {
  return a.startsAt < b.endsAt && b.startsAt < a.endsAt;
}

function datesOverlap(a: SlotWindow, b: SlotWindow): boolean {
  const aStart = a.effectiveFrom?.getTime() ?? Number.NEGATIVE_INFINITY;
  const aEnd = a.effectiveTo?.getTime() ?? Number.POSITIVE_INFINITY;
  const bStart = b.effectiveFrom?.getTime() ?? Number.NEGATIVE_INFINITY;
  const bEnd = b.effectiveTo?.getTime() ?? Number.POSITIVE_INFINITY;
  return aStart <= bEnd && bStart <= aEnd;
}
