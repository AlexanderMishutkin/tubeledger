// Remembered marks: which videos you have already called work, or entertainment.
//
// A tab's category lives in session storage and dies with the browser — that is
// right for a tab, which does not outlive the browser either. But the judgement
// behind the mark does outlive it: a lecture you marked educational on Friday is
// still a lecture on Monday. So the mark is kept against the video, and a tab
// that lands on a video you have already judged starts out judged.
//
// What is stored is a fingerprint of the video id, not the id: a one-way hash,
// truncated. Recognising a video you are on needs nothing more than that, and it
// keeps the store from being a readable history of what you watched — there is
// nothing in it to read back, only something to match against.
//
// The store is bounded twice over, because an unbounded one would grow for years:
// marks unused for MARK_TTL_MS fall out, and only the MARK_MAX most recently seen
// survive beyond that. Both are refreshed by *seeing* a video, not by marking it,
// so what you keep coming back to keeps its mark and the rest fades.

export const MARK_MAX = 500;
export const MARK_TTL_MS = 90 * 24 * 60 * 60 * 1000;

/** `tubeledger:` keeps the digest from matching one taken of the bare id elsewhere. */
export async function fingerprint(videoId) {
  const bytes = new TextEncoder().encode(`tubeledger:${videoId}`);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('').slice(0, 16);
}

/** The category remembered for this fingerprint, or null if there is none worth keeping. */
export function lookupMark(marks, fp, now = Date.now()) {
  const hit = fp && marks ? marks[fp] : null;
  if (!hit || (now - hit.t) > MARK_TTL_MS) return null;
  return hit.c;
}

/** Drop what has expired, then the least recently seen of whatever is over the cap. */
export function pruneMarks(marks, now = Date.now()) {
  const live = Object.entries(marks || {})
    .filter(([, m]) => m && (now - m.t) <= MARK_TTL_MS)
    .sort((a, b) => b[1].t - a[1].t)
    .slice(0, MARK_MAX);
  return Object.fromEntries(live);
}

/** Remember a mark, or move an existing one. Returns a new object; the input is untouched. */
export function putMark(marks, fp, category, now = Date.now()) {
  if (!fp) return { ...marks };
  return pruneMarks({ ...marks, [fp]: { c: category, t: now } }, now);
}

/** Say the mark was used just now, so it survives the next prune. */
export function touchMark(marks, fp, now = Date.now()) {
  if (!fp || !marks || !marks[fp]) return marks;
  return { ...marks, [fp]: { ...marks[fp], t: now } };
}

export function forgetMark(marks, fp) {
  if (!fp || !marks || !(fp in marks)) return marks;
  const next = { ...marks };
  delete next[fp];
  return next;
}

export function countMarks(marks, now = Date.now()) {
  return Object.values(marks || {}).filter((m) => m && (now - m.t) <= MARK_TTL_MS).length;
}
