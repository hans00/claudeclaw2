/**
 * Cron expression evaluator. 5-field POSIX-style: minute hour day-of-month
 * month day-of-week. Supports `*`, `*\/N`, ranges `lo-hi`, comma-lists, and
 * range steps `lo-hi/N`. Direct port of v1 cron.ts.
 */
function matchCronField(field: string, value: number): boolean {
  for (const part of field.split(",")) {
    const [range, stepStr] = part.split("/");
    const step = stepStr ? parseInt(stepStr) : 1;

    if (range === "*") {
      if (value % step === 0) return true;
      continue;
    }

    if (range.includes("-")) {
      const [lo, hi] = range.split("-").map(Number);
      if (value >= lo && value <= hi && (value - lo) % step === 0) return true;
      continue;
    }

    if (parseInt(range) === value) return true;
  }
  return false;
}

function shiftDateToOffset(d: Date, offsetMinutes: number): Date {
  return new Date(d.getTime() + offsetMinutes * 60 * 1000);
}

export function cronMatches(expr: string, date: Date, timezoneOffsetMinutes = 0): boolean {
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5) return false;
  const [minute, hour, dayOfMonth, month, dayOfWeek] = fields;
  const shifted = shiftDateToOffset(date, timezoneOffsetMinutes);
  const d = {
    minute: shifted.getUTCMinutes(),
    hour: shifted.getUTCHours(),
    dayOfMonth: shifted.getUTCDate(),
    month: shifted.getUTCMonth() + 1,
    dayOfWeek: shifted.getUTCDay(),
  };
  return (
    matchCronField(minute, d.minute) &&
    matchCronField(hour, d.hour) &&
    matchCronField(dayOfMonth, d.dayOfMonth) &&
    matchCronField(month, d.month) &&
    matchCronField(dayOfWeek, d.dayOfWeek)
  );
}

export function nextCronMatch(expr: string, after: Date, timezoneOffsetMinutes = 0): Date {
  const d = new Date(after);
  d.setSeconds(0, 0);
  d.setMinutes(d.getMinutes() + 1);
  for (let i = 0; i < 2880; i++) {
    if (cronMatches(expr, d, timezoneOffsetMinutes)) return d;
    d.setMinutes(d.getMinutes() + 1);
  }
  return d;
}
