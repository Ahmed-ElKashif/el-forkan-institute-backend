import {
  escapeTemplateValue,
  renderTemplate,
  toWhatsAppRecipient,
} from './message-rendering';

// The template seeded by schema-v1.1.sql.
const FRIDAY_TEMPLATE = 'تذكير: جدول يوم الجمعة {{date}}\n{{schedule}}';

describe('renderTemplate', () => {
  it('substitutes every placeholder', () => {
    const { body, missing } = renderTemplate(FRIDAY_TEMPLATE, {
      date: '2026-04-03',
      schedule: 'النحو 09:00',
    });

    expect(body).toBe('تذكير: جدول يوم الجمعة 2026-04-03\nالنحو 09:00');
    expect(missing).toEqual([]);
  });

  it('tolerates whitespace inside the braces', () => {
    expect(renderTemplate('مرحبا {{ name }}', { name: 'أحمد' }).body).toBe(
      'مرحبا أحمد',
    );
  });

  // Sending "تذكير: جدول يوم {{date}}" to a real student is worse than not
  // sending at all, and blanking it silently would hide the bug.
  it('reports a missing variable instead of blanking it', () => {
    const { body, missing } = renderTemplate(FRIDAY_TEMPLATE, {
      date: '2026-04-03',
    });

    expect(missing).toEqual(['schedule']);
    expect(body).toContain('{{schedule}}');
  });

  it('reports each missing name once, however often it appears', () => {
    expect(renderTemplate('{{a}} {{a}} {{b}}', {}).missing).toEqual(['a', 'b']);
  });

  it('leaves a template with no placeholders untouched', () => {
    expect(renderTemplate('تنبيه عام', {}).body).toBe('تنبيه عام');
  });

  it('does not re-expand a placeholder that arrived inside a value', () => {
    const { body } = renderTemplate('مرحبا {{name}}', {
      name: '{{schedule}}',
    });

    // The braces are stripped, so the injected placeholder cannot be
    // substituted on a later pass or read as template syntax.
    expect(body).toBe('مرحبا schedule');
  });
});

// Spec §9: "Escape student names before interpolating into WhatsApp
// templates."
describe('escapeTemplateValue', () => {
  it('leaves an ordinary Arabic name exactly as it is', () => {
    expect(escapeTemplateValue('أحمد مصطفى')).toBe('أحمد مصطفى');
  });

  it('strips braces so a value cannot become template syntax', () => {
    expect(escapeTemplateValue('{{date}}')).toBe('date');
  });

  // This is a right-to-left message: an embedded override reorders the
  // displayed text so a "name" can read as part of the institute's wording.
  it.each([
    ['a right-to-left override', `أحمد${String.fromCodePoint(0x202e)}`],
    ['a left-to-right embedding', `${String.fromCodePoint(0x202a)}أحمد`],
    ['a first-strong isolate', `${String.fromCodePoint(0x2068)}أحمد`],
  ])('removes %s', (_label, input) => {
    expect(escapeTemplateValue(input)).toBe('أحمد');
  });

  it.each([
    ['a newline', 'أحمد\nمصطفى', 'أحمدمصطفى'],
    ['a carriage return', 'أحمد\rمصطفى', 'أحمدمصطفى'],
    ['a NUL byte', `أحمد${String.fromCodePoint(0)}`, 'أحمد'],
    ['DEL', `أحمد${String.fromCodePoint(0x7f)}`, 'أحمد'],
  ])('removes %s from a value', (_label, input, expected) => {
    expect(escapeTemplateValue(input)).toBe(expected);
  });

  it('trims surrounding whitespace', () => {
    expect(escapeTemplateValue('  أحمد  ')).toBe('أحمد');
  });

  it('handles an empty value', () => {
    expect(escapeTemplateValue('')).toBe('');
  });

  // The template's own newline is structure, not a value, so it must survive.
  it('does not strip newlines from the template itself', () => {
    expect(
      renderTemplate(FRIDAY_TEMPLATE, { date: 'x', schedule: 'y' }).body,
    ).toContain('\n');
  });
});

describe('toWhatsAppRecipient', () => {
  it('drops the leading + that E.164 requires and Meta does not', () => {
    expect(toWhatsAppRecipient('+201001234567')).toBe('201001234567');
  });

  it('leaves an already-bare number alone', () => {
    expect(toWhatsAppRecipient('201001234567')).toBe('201001234567');
  });
});
