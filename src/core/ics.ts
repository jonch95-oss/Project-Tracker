/**
 * Module H: the private calendar feed (RFC 5545). Pure.
 *
 * Every event is an all-day date in New York time. UIDs are stable per
 * source row, so a calendar app updates an event in place when a date moves
 * instead of adding a copy.
 */

export interface CalendarEvent {
  /** Stable across feeds, e.g. "task-<uuid>". */
  uid: string;
  /** YYYY-MM-DD. */
  date: string;
  title: string;
  description?: string | null;
  url?: string | null;
  /** e.g. the project name. */
  location?: string | null;
}

/** Escape text for an ICS value (backslash, semicolon, comma, newline). */
export function icsText(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");
}

/** Fold a content line at 75 octets (continuation lines start with a space), never splitting a UTF-8 character. */
export function foldLine(line: string): string {
  const enc = new TextEncoder();
  if (enc.encode(line).length <= 75) return line;
  const parts: string[] = [];
  let cur = "";
  let curBytes = 0;
  for (const ch of line) {
    const b = enc.encode(ch).length;
    const limit = parts.length === 0 ? 75 : 74;
    if (curBytes + b > limit) {
      parts.push(cur);
      cur = "";
      curBytes = 0;
    }
    cur += ch;
    curBytes += b;
  }
  parts.push(cur);
  return parts.join("\r\n ");
}

const compact = (d: string) => d.replace(/-/g, "");

function nextDay(d: string): string {
  const t = new Date(`${d}T12:00:00Z`);
  t.setUTCDate(t.getUTCDate() + 1);
  return t.toISOString().slice(0, 10);
}

/** A whole VCALENDAR. `stamp` is the feed's generation time (UTC). */
export function buildCalendar(input: { name: string; events: readonly CalendarEvent[]; stamp: Date; domain: string }): string {
  const stamp = input.stamp.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Project Command//Calendar feed//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    `X-WR-CALNAME:${icsText(input.name)}`,
    "X-WR-TIMEZONE:America/New_York",
    // Ask calendar apps to check back every few hours.
    "REFRESH-INTERVAL;VALUE=DURATION:PT4H",
    "X-PUBLISHED-TTL:PT4H",
  ];
  for (const e of input.events) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(e.date)) continue;
    lines.push(
      "BEGIN:VEVENT",
      `UID:${e.uid}@${input.domain}`,
      `DTSTAMP:${stamp}`,
      `DTSTART;VALUE=DATE:${compact(e.date)}`,
      `DTEND;VALUE=DATE:${compact(nextDay(e.date))}`,
      `SUMMARY:${icsText(e.title)}`,
      ...(e.location ? [`LOCATION:${icsText(e.location)}`] : []),
      ...(e.description ? [`DESCRIPTION:${icsText(e.description)}`] : []),
      ...(e.url ? [`URL:${e.url}`] : []),
      "TRANSP:TRANSPARENT",
      "END:VEVENT",
    );
  }
  lines.push("END:VCALENDAR");
  return lines.map(foldLine).join("\r\n") + "\r\n";
}
