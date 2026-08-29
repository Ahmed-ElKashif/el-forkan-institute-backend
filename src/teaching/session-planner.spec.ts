import {
  findClashes,
  planSessions,
  SlotWindow,
  TimetableSlot,
} from './session-planner';

const d = (iso: string) => new Date(`${iso}T00:00:00Z`);
const day = (date: Date) => date.toISOString().slice(0, 10);

const FRIDAY_SLOT: TimetableSlot = {
  id: 'slot-1',
  subjectId: 8,
  teacherId: 'teacher-a',
  weekday: 5, // ISO Friday — R4's default lecture day
  slotOrder: 1,
  startsAt: '09:00',
  endsAt: '10:30',
  room: 'A1',
  mode: 'onsite',
  effectiveFrom: null,
  effectiveTo: null,
};

describe('planSessions', () => {
  // 2026-04-03 is itself a Friday: the term's first day IS a lecture day, and
  // the generator must not skip a week looking for the "next" one.
  it('uses the term start itself when it already falls on the lecture day', () => {
    const [first] = planSessions({
      termStart: d('2026-04-03'),
      termEnd: d('2026-08-28'),
      slots: [FRIDAY_SLOT],
      sessionsPerTerm: 15,
    });

    expect(day(first.sessionDate)).toBe('2026-04-03');
    expect(first.sessionNo).toBe(1);
  });

  it('finds the first Friday when the term starts mid-week', () => {
    const [first] = planSessions({
      termStart: d('2026-04-06'), // Monday
      termEnd: d('2026-08-28'),
      slots: [FRIDAY_SLOT],
      sessionsPerTerm: 15,
    });

    expect(day(first.sessionDate)).toBe('2026-04-10');
  });

  it('generates exactly sessions_per_term sessions, a week apart', () => {
    const sessions = planSessions({
      termStart: d('2026-04-03'),
      termEnd: d('2026-08-28'),
      slots: [FRIDAY_SLOT],
      sessionsPerTerm: 15,
    });

    expect(sessions).toHaveLength(15);
    expect(sessions.map((session) => session.sessionNo)).toEqual(
      Array.from({ length: 15 }, (_, index) => index + 1),
    );
    const gapDays =
      (sessions[1].sessionDate.getTime() - sessions[0].sessionDate.getTime()) /
      86_400_000;
    expect(gapDays).toBe(7);
  });

  it('stops at the end of the term even if that is short of the target', () => {
    const sessions = planSessions({
      termStart: d('2026-04-03'),
      termEnd: d('2026-05-01'),
      slots: [FRIDAY_SLOT],
      sessionsPerTerm: 15,
    });

    expect(sessions).toHaveLength(5);
    expect(day(sessions.at(-1)!.sessionDate)).toBe('2026-05-01');
  });

  // An institute holiday must not consume one of the fifteen numbered columns
  // on the printed grid — the term simply runs a week longer.
  it('skips an off day and keeps the numbering unbroken', () => {
    const sessions = planSessions({
      termStart: d('2026-04-03'),
      termEnd: d('2026-08-28'),
      slots: [FRIDAY_SLOT],
      sessionsPerTerm: 3,
      offDays: [d('2026-04-10')],
    });

    expect(sessions.map((session) => day(session.sessionDate))).toEqual([
      '2026-04-03',
      '2026-04-17',
      '2026-04-24',
    ]);
    expect(sessions.map((session) => session.sessionNo)).toEqual([1, 2, 3]);
  });

  // The timetable changes mid-year; a slot only generates inside its window.
  it('honours a slot that only becomes effective later in the term', () => {
    const sessions = planSessions({
      termStart: d('2026-04-03'),
      termEnd: d('2026-05-08'),
      slots: [{ ...FRIDAY_SLOT, effectiveFrom: d('2026-04-20') }],
      sessionsPerTerm: 15,
    });

    expect(sessions.map((session) => day(session.sessionDate))).toEqual([
      '2026-04-24',
      '2026-05-01',
      '2026-05-08',
    ]);
  });

  it('honours a slot that stops part-way through', () => {
    const sessions = planSessions({
      termStart: d('2026-04-03'),
      termEnd: d('2026-05-08'),
      slots: [{ ...FRIDAY_SLOT, effectiveTo: d('2026-04-17') }],
      sessionsPerTerm: 15,
    });

    expect(sessions).toHaveLength(3);
  });

  // §6.1: the printed grid numbers columns 1…15 per subject, so two subjects
  // on the same day each start at 1.
  it('numbers each slot independently', () => {
    const sessions = planSessions({
      termStart: d('2026-04-03'),
      termEnd: d('2026-04-17'),
      slots: [
        FRIDAY_SLOT,
        {
          ...FRIDAY_SLOT,
          id: 'slot-2',
          subjectId: 9,
          startsAt: '10:45',
          endsAt: '12:00',
        },
      ],
      sessionsPerTerm: 15,
    });

    expect(
      sessions.filter((s) => s.slotId === 'slot-1').map((s) => s.sessionNo),
    ).toEqual([1, 2, 3]);
    expect(
      sessions.filter((s) => s.slotId === 'slot-2').map((s) => s.sessionNo),
    ).toEqual([1, 2, 3]);
  });

  // R4: "Friday is the default lecture day, not a hard rule."
  it.each([
    [1, '2026-04-06'],
    [3, '2026-04-08'],
    [7, '2026-04-05'],
  ])('supports weekday %i, generating from %s', (weekday, expectedFirst) => {
    const [first] = planSessions({
      termStart: d('2026-04-03'),
      termEnd: d('2026-08-28'),
      slots: [{ ...FRIDAY_SLOT, weekday }],
      sessionsPerTerm: 15,
    });

    expect(day(first.sessionDate)).toBe(expectedFirst);
  });

  it('generates nothing when there are no slots', () => {
    expect(
      planSessions({
        termStart: d('2026-04-03'),
        termEnd: d('2026-08-28'),
        slots: [],
        sessionsPerTerm: 15,
      }),
    ).toEqual([]);
  });
});

const slotWindow = (overrides: Partial<SlotWindow> = {}): SlotWindow => ({
  slotId: 'candidate',
  teacherId: 'teacher-a',
  weekday: 5,
  startsAt: '09:00',
  endsAt: '10:30',
  effectiveFrom: null,
  effectiveTo: null,
  ...overrides,
});

describe('findClashes', () => {
  it('reports a teacher double-booked at overlapping times', () => {
    const clashes = findClashes(slotWindow(), [
      slotWindow({ slotId: 'other', startsAt: '10:00', endsAt: '11:00' }),
    ]);

    expect(clashes.map((slot) => slot.slotId)).toEqual(['other']);
  });

  // Back-to-back is how a timetable is meant to look, not a conflict.
  it('allows slots that merely touch at the boundary', () => {
    expect(
      findClashes(slotWindow(), [
        slotWindow({ slotId: 'other', startsAt: '10:30', endsAt: '12:00' }),
      ]),
    ).toEqual([]);
  });

  it.each([
    ['a different weekday', { weekday: 3 }],
    ['a different teacher', { teacherId: 'teacher-b' }],
  ])('allows an overlapping slot on %s', (_label, overrides) => {
    expect(
      findClashes(slotWindow(), [
        slotWindow({ slotId: 'other', ...overrides }),
      ]),
    ).toEqual([]);
  });

  // The timetable changes mid-year: the old slot ending before the new one
  // starts is a replacement, not a clash.
  it('allows the same teacher when the effective windows do not overlap', () => {
    expect(
      findClashes(slotWindow({ effectiveFrom: d('2026-06-01') }), [
        slotWindow({ slotId: 'other', effectiveTo: d('2026-05-31') }),
      ]),
    ).toEqual([]);
  });

  it('reports a clash when the effective windows do overlap', () => {
    expect(
      findClashes(slotWindow({ effectiveFrom: d('2026-05-01') }), [
        slotWindow({ slotId: 'other', effectiveTo: d('2026-06-30') }),
      ]),
    ).toHaveLength(1);
  });

  it('never reports a slot as clashing with itself', () => {
    expect(findClashes(slotWindow(), [slotWindow()])).toEqual([]);
  });

  // A slot with no teacher assigned yet cannot double-book anyone.
  it('reports nothing for a slot with no teacher', () => {
    expect(
      findClashes(slotWindow({ teacherId: null }), [
        slotWindow({ slotId: 'other' }),
      ]),
    ).toEqual([]);
  });
});
