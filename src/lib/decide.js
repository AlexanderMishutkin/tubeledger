// The one rule that decides what the clock is running on right now.
// Pure on purpose: this is the piece most worth testing.

/** A tab with no category picked books its time as unattributed (yellow). */
export function classOf(tab, defaultCategory) {
  const cat = tab.category || defaultCategory;
  return cat === 'work' || cat === 'ent' ? cat : 'menu';
}

/**
 * Pick the single class of time that is running, or null for "count nothing".
 * Exactly one wins, so the ledger can never exceed wall-clock time.
 *
 *   foreground + playing      -> the tab's category      (green / red)
 *   foreground + not playing  -> menu                    (yellow)
 *   background + playing      -> same, flagged bg        (muted + hatched)
 *   background + not playing  -> nothing
 *
 * "Foreground" means visible, focused and not on a locked screen. Idleness only
 * stops *menu* time — sitting still through a video is what watching looks like.
 *
 * @param {Array<{playing:boolean, visible:boolean, focused:boolean, category?:string}>} tabStates
 * @param {{idleState?:string, countBackground?:boolean, defaultCategory?:string}} opts
 * @returns {{c:'work'|'ent'|'menu', bg:boolean}|null}
 */
export function decide(tabStates, opts = {}) {
  const {
    idleState = 'active',
    countBackground = true,
    defaultCategory = 'ent',
  } = opts;
  const locked = idleState === 'locked';
  const away = idleState !== 'active';

  let menuCandidate = null;
  let bgCandidate = null;

  for (const tab of tabStates) {
    const front = !!tab.visible && !!tab.focused && !locked;
    if (front && tab.playing) {
      return { c: classOf(tab, defaultCategory), bg: false };
    }
    if (front && !tab.playing && !away) {
      menuCandidate = menuCandidate || { c: 'menu', bg: false };
    }
    if (!front && tab.playing && countBackground) {
      bgCandidate = bgCandidate || { c: classOf(tab, defaultCategory), bg: true };
    }
  }
  return menuCandidate || bgCandidate;
}
