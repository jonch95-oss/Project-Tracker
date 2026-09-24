/**
 * @mentions in comments. The composer inserts mentions as @[Name](userId)
 * tokens, so a mention is unambiguous even when two people share a first
 * name; the display turns tokens back into "@Name". Pure.
 */
export interface Person {
  id: string;
  name: string;
}

const TOKEN = /@\[([^\]\n]{1,80})\]\(([A-Za-z0-9_-]{1,64})\)/g;

/** User ids mentioned in a comment body, limited to people allowed on the task (in order, no repeats). */
export function mentionedIds(body: string, allowed: readonly Person[]): string[] {
  const ok = new Set(allowed.map((p) => p.id));
  const out: string[] = [];
  for (const m of body.matchAll(TOKEN)) {
    const id = m[2]!;
    if (ok.has(id) && !out.includes(id)) out.push(id);
  }
  return out;
}

export type CommentPart = { kind: "text"; text: string } | { kind: "mention"; id: string; name: string };

/** Split a body into text and mentions for display. Unknown ids show the name that was typed. */
export function parseComment(body: string, people: readonly Person[] = []): CommentPart[] {
  const parts: CommentPart[] = [];
  let last = 0;
  for (const m of body.matchAll(TOKEN)) {
    if (m.index! > last) parts.push({ kind: "text", text: body.slice(last, m.index) });
    const id = m[2]!;
    parts.push({ kind: "mention", id, name: people.find((p) => p.id === id)?.name ?? m[1]! });
    last = m.index! + m[0].length;
  }
  if (last < body.length) parts.push({ kind: "text", text: body.slice(last) });
  return parts;
}

/** Plain text of a comment (for notifications and search): "@Name" instead of tokens. */
export function commentPlainText(body: string): string {
  return body.replace(TOKEN, (_m, name: string) => `@${name}`);
}

export function mentionToken(p: Person): string {
  return `@[${p.name.replace(/[\]\n]/g, "")}](${p.id})`;
}

/** People whose name starts with (or has a word starting with) what's typed after "@". */
export function mentionMatches(query: string, people: readonly Person[], limit = 6): Person[] {
  const q = query.trim().toLowerCase();
  if (!q) return people.slice(0, limit);
  return people.filter((p) => p.name.toLowerCase().split(/\s+/).some((w) => w.startsWith(q)) || p.name.toLowerCase().startsWith(q)).slice(0, limit);
}
