/**
 * @mentions. Names can contain spaces ("Ana Lopez"), so a mention is "@" plus a known name of
 * someone on this video, followed by the end, a space or punctuation. The API applies the same
 * rule when it decides who to notify (main.mentioned_ids).
 */

/** The "@query" being typed just before the caret, if any. */
export function mentionQuery(text: string, caret: number): { start: number; query: string } | null {
  const before = text.slice(0, caret);
  const at = before.lastIndexOf('@');
  if (at < 0) return null;
  // Must start a word, and stay short and on one line.
  if (at > 0 && /[\w@]/.test(before[at - 1])) return null;
  const query = before.slice(at + 1);
  if (query.length > 40 || /[\n@]/.test(query)) return null;
  return { start: at, query };
}

/** Names that complete the query: starting with it first, then containing it. */
export function suggest(names: string[], query: string, limit = 6): string[] {
  const q = query.trim().toLowerCase();
  const starts = names.filter((n) => n.toLowerCase().startsWith(q));
  const contains = names.filter((n) => !n.toLowerCase().startsWith(q) && n.toLowerCase().includes(q));
  return [...starts, ...contains].slice(0, limit);
}

/** Replaces "@que|" with "@Name |" and returns the new text and caret. */
export function insertMention(text: string, start: number, caret: number, name: string): { text: string; caret: number } {
  const insert = `@${name} `;
  return { text: text.slice(0, start) + insert + text.slice(caret), caret: start + insert.length };
}

export type Segment = { text: string; mention: boolean };

/** Splits a comment into plain text and mentions of known names, for highlighting. */
export function splitMentions(body: string, names: string[]): Segment[] {
  const known = names.filter(Boolean).sort((a, b) => b.length - a.length);
  if (!known.length || !body.includes('@')) return [{ text: body, mention: false }];
  const escaped = known.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const pattern = new RegExp(`@(?:${escaped.join('|')})(?![\\p{L}\\p{N}_])`, 'giu');
  const out: Segment[] = [];
  let last = 0;
  for (const m of body.matchAll(pattern)) {
    const i = m.index ?? 0;
    if (i > 0 && /[\p{L}\p{N}_]/u.test(body[i - 1])) continue;
    if (i > last) out.push({ text: body.slice(last, i), mention: false });
    out.push({ text: m[0], mention: true });
    last = i + m[0].length;
  }
  if (last < body.length) out.push({ text: body.slice(last), mention: false });
  return out;
}
