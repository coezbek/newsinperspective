function formatDateParts(date: Date, timeZone: string): Intl.DateTimeFormatPart[] {
  return new Intl.DateTimeFormat("en", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
}

function readPart(parts: Intl.DateTimeFormatPart[], type: "year" | "month" | "day"): string {
  const value = parts.find((part) => part.type === type)?.value;
  if (!value) {
    throw new Error(`Unable to resolve ${type} for timezone date formatting.`);
  }
  return value;
}

export function getAppDateTimeZone(): string {
  return process.env.APP_DATE_TIMEZONE?.trim() || "UTC";
}

export function formatDateInTimeZone(date: Date, timeZone = getAppDateTimeZone()): string {
  const parts = formatDateParts(date, timeZone);
  const year = readPart(parts, "year");
  const month = readPart(parts, "month");
  const day = readPart(parts, "day");
  return `${year}-${month}-${day}`;
}

export function getCurrentDateString(now = new Date(), timeZone = getAppDateTimeZone()): string {
  return formatDateInTimeZone(now, timeZone);
}

export function startOfUtcDay(date: string): Date {
  return new Date(`${date}T00:00:00.000Z`);
}
