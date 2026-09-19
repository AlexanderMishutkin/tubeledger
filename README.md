# TubeLedger

A Chrome extension that keeps an honest ledger of your YouTube hours — how much
was **work & education**, how much was **entertainment**, and how much was just
scrolling the menus — and stops entertainment at a daily limit you set.

Built for one user (me). No account, no server, no telemetry: everything lives in
`chrome.storage.local` on this machine.

![The dashboard](docs/dashboard.png)

## What it counts, and what it refuses to count

The day runs **04:00 → 04:00**, so a late night stays on the evening it belongs to.

| What is happening | Counted as | Colour |
|---|---|---|
| Video playing, tab in front | the tab's category | green (work) / red (entertainment) |
| Browsing, searching, or a paused video, tab in front | menu time | yellow |
| Video playing, tab hidden or window unfocused | the same category, flagged *background* | muted + 45° hatch |
| Tab hidden with nothing playing | **nothing** | — |
| No input for a while (idle) while browsing | **nothing** — but a running video keeps counting | — |
| Screen locked | demoted to background | muted + hatch |

Two rules hold the whole thing together:

- **Only one thing is counted at a time.** With three tabs playing, one of them is
  billed — so the ledger can never add up to more than the clock did.
- **What you are looking at beats what is merely audible.** A front tab playing
  wins over a background tab playing.

Hover previews on the home feed (muted autoplay) don't count as watching; a muted
video on a `/watch` or `/shorts` page does.

## The daily limit

Default **60 minutes of entertainment**. When it's spent, playback pauses on any
tab marked *entertainment* and an overlay says so. Work & education is never
blocked, and menu time is never blocked.

The only one-click escape is "this is work & education" — for when something was
miscategorised. Anything else means opening the dashboard and changing the limit
on purpose, which is the point.

The toolbar badge counts the remaining entertainment minutes down: green, then
amber under ten minutes, then red at zero.

### What yesterday leaves behind

Going over does not just get logged, it gets charged. **Overtime is carried into
the next day** as entertainment time already spent — the brown band at the bottom
of tomorrow's column, gone before you open YouTube. Restraint earns the mirror
image: **two thirds of what you did not spend is banked**, and today's ceiling
becomes `limit + banked` everywhere a timer appears, while the limit in Settings
never moves. Time spent into the bank is gold in the chart and costs tomorrow
nothing; past it is magenta, and it travels.

Both directions are bounded, which is the difference between a budget and a
spiral:

| | cap | why |
|---|---|---|
| debt | 2 × limit | uncapped it compounds, the budget is permanently spent, and the extension gets switched off instead. Two clean days clear the worst case. |
| bank | 1 × limit | so the ceiling any timer can ever show is **2 × limit** — a saved-up evening is a bit longer than usual, not a different kind of evening. A fortnight away buys the same two hours a weekend away does. |

The chain is **derived** from the entries on every change, never accumulated, so
correcting a day from three weeks ago re-runs every day after it.

## The header indicator

YouTube's own header gets a pill, docked next to Create and the bell — real header
space, so it never covers a thumbnail, a video or the filter chips. It says a
different thing depending on what you are doing:

**Watching work & education** — a quiet green tick, always there, so you can stop
wondering whether the clock is running.

![The educational tick](docs/corner-educational.png)

**Anywhere that isn't playing — feeds, search, a paused video** — the explicit
bar: which mode this tab is in, what is left of today's budget, and a button to
switch mode without opening the popup.

![The status bar](docs/corner-status.png)

**Watching entertainment** — nothing stands in the way. Instead a reminder slides
into the corner below at each round figure of budget left (55m, 50m, 45m …) and
fades after seven seconds. The step is configurable, or off.

![The reminder](docs/corner-reminder.png)

**In fullscreen** there is no header to dock into — YouTube slides it away — so
the pill and the reminder float in the same top-right corner, over the video:
same information, same place. The same fallback covers YouTube rearranging its
markup. The indicator stays out of the way when the limit overlay is up, and can
be switched off entirely in Settings.

## Categories

Each YouTube **tab** carries a category. New tabs start at whatever
`New tabs count as` says (default: entertainment — the strict choice). The popup
flips the current tab between work and entertainment in one click, and so does
the button on the corner bar. A tab left uncategorised books its time as yellow,
not as entertainment.

### What is remembered

A tab dies with the browser, but the judgement behind the mark does not: a
lecture you called educational on Friday is still a lecture on Monday. So the
mark is kept **against the video**, not against the tab, and a tab that lands on
a video you have already judged starts out judged — after a restart too. The
indicator says so when that happens (*Educational · remembered*), because time
quietly kept off the limit by a decision made weeks ago should not be quiet
about where it came from.

The order a tab settles its category in:

| | |
|---|---|
| 1 | what you said about this tab while it was on this very video |
| 2 | what you once said about **this video**, in any tab, on any day |
| 3 | what you said about this tab on some other video — a tab stays as you set it |
| 4 | `New tabs count as` |

A mark that arrived by itself (2) is never inherited by the next video: autoplay
moving on lands back at the default. Marking a video again replaces what is
remembered, and *Uncategorised* takes the judgement back and forgets it.

What is stored is a **one-way fingerprint** of the video id — a truncated
SHA-256, never the id. That is enough to recognise a video you are on and not
enough to say which videos those were: the store cannot be read back into a
watch history. It is bounded twice over, at 500 marks and 90 days since a video
was last seen, and the dashboard counts them and forgets them all on request.
`Remember a video's category` in Settings switches the whole thing off. Marks
travel with an export and a backup like everything else in `storage.local` —
still as fingerprints.

## Backups

`chrome.storage.local` survives browser restarts, but not a wiped profile or a
removed extension. So the ledger also goes to a file — **quietly**.

Pick a folder once in Settings (*Choose backup folder…*) and a full export is
written there once a logical day:

```
<your folder>/tubeledger-latest.json   always the newest
<your folder>/tubeledger-2026-09.json  one per month
```

Two files on purpose — a bad day cannot quietly overwrite the only copy you have.
Both are exactly the format **Import JSON** accepts, so restoring is: Settings →
Import JSON → pick the file.

This uses the File System Access API, which writes straight into the folder with
**no download bubble and no prompt**. The trade-off is that it only works from an
extension page, never from the service worker, so the write happens when the
popup or the dashboard is next opened rather than on a timer. The popup is opened
most days; nothing is at risk in the meantime, since `chrome.storage.local` is
still the live store and this is only the copy that outlives it.

Chrome sometimes pauses a stored folder permission after a restart. That is
visible, not silent: the dashboard says so, and the popup shows a line you can
click. One press of **Back up now** restores it.

> An earlier version did this with `chrome.downloads`, which worked but popped the
> download bubble every time — and, worse, wrote its "already done today" marker
> only after an `await` that a service worker does not always survive, so it could
> repeat on every worker wake. Both are why the mechanism changed.

## Editing the record

Every entry on the dashboard can be re-typed, moved between *watching* and
*background*, re-timed, re-lengthed, or deleted, and you can add entries by hand
for time the tracker missed. **Only the type and the length are ever stored** —
never a video title, a channel, or a URL. The tracker keeps no history of what you
watched, only of what kind of time it was.

## Install

1. `git clone https://github.com/AlexanderMishutkin/tubeledger.git`
2. Open `chrome://extensions`, turn on **Developer mode**
3. **Load unpacked** → pick the cloned folder
4. Pin the icon; open the popup to check it's counting

Unpacked extensions don't auto-update — `git pull` and hit reload on
`chrome://extensions` when you want the newer code. **Reloading the extension
does not touch YouTube tabs that are already open**: they keep running the old
content script until they are refreshed. Tabs in that state say so in the header
pill — *TubeLedger updated · Refresh* — so a stale tab is visible rather than
puzzling.

## Permissions, and why each one is there

| Permission | Why |
|---|---|
| `storage` | the ledger and the settings, local only |
| `alarms` | a one-minute heartbeat so the worker closes an open session after the last YouTube tab goes away |
| `idle` | to stop counting menu time when you walk away |
| `*://*.youtube.com/*` | the content script that reports play/pause and pauses playback at the limit |

There is no `tabs` permission: the extension never reads a tab's URL or title. It
learns only what each content script reports about its own page — playing or not,
a video page or not, visible or not, focused or not, and the id of the video on
screen, which is hashed on arrival and kept only as a fingerprint (see *What is
remembered*). No playlist, no search terms, no titles, no channels.

No `fetch`, no `eval`, no `innerHTML`, no remote code, no `storage.sync`. Nothing
leaves the browser. `test/preview*.html` are dev harnesses that do use `fetch` to
load the real pages — they are not part of the extension.

## Layout

```
manifest.json
src/
  background.js     service worker: the accounting engine
  content.js        reports tab state, pauses playback at the limit
  popup.html/js/css today at a glance, category switch
  dashboard.html/…  timeline, 30-day history, entry editing, settings
  lib/
    decide.js       the one rule that picks what the clock runs on
    model.js        days, segments, totals — pure, no chrome.*
    store.js        chrome.storage.local wrapper
    marks.js        remembered categories, by fingerprint — pure, no chrome.*
    charts.js       hand-rolled SVG charts
    theme.css       palette and shared styles
scripts/make-icons.mjs   generates icons/*.png from code
test/                    node --test suites + browser preview harnesses
docs/                    screenshots
```

## Development

```sh
npm test                 # 86 tests: the model, the economy, the decision rule,
                         #           and the engine driven end-to-end
npm run icons            # regenerate icons/*.png
npm run preview          # then open http://localhost:8777/test/preview.html
```

`test/engine.test.mjs` runs the real service worker against a stubbed `chrome.*`
and a fake clock, so the counting rules are checked without a browser.
`test/preview.html` and `test/preview-popup.html` render the real pages against
seeded data, and `test/preview-hud.html?mode=work|ent-toast|menu|blocked` renders
the indicator over a mock YouTube carrying YouTube's real masthead ids — add
`&fs=1` for fullscreen (it stubs `document.fullscreenElement`, which is what the
script reads), `&theme=light`, `&stale=1`, `&nomasthead=1`, or `&from=memory` for the pill of a
mark the worker recalled by itself. `test/preview.html?marks=<n>` and
`test/preview-popup.html?cat=work&from=memory` show the same thing in the
dashboard and the popup.
`test/preview-recs.html?mode=soft|hard&left=<minutes>` builds a watch page (or
`&page=home`) carrying **both** of YouTube's card layouts and runs the real
content script against it — that is where the thinning rules are verified, since
headless Chrome renders YouTube's shell but never hydrates its recommendation
list. Add **`&markup=real`** to swap the mock cards for a sidebar captured from a
live watch page (`test/fixtures/related-sidebar.html`): YouTube's own nesting,
two links per card, real durations. It prints a probe underneath — which element
each card resolved to, whether its title is still visible, and every card's
height before and after, because the point of the blackout is that nothing moves.
`&flip=1` lifts the restriction again and re-probes, so the way back is checked
too. All four harnesses are for looking at the UI without loading the extension.

## When the budget runs low

The last stretch of an entertainment budget is when the feed argues hardest, so
it gets quieter instead:

- **under 20 minutes** — recommendations beside the video that are longer than
  `remaining × 1.9` go black. A card whose length cannot be read is left alone:
  only what can be *shown* to be too long is covered.
- **under 5 minutes** — every recommendation, the whole home feed and the search
  box. A banner says what happened and offers the one way out.

Marking the tab **work & education** lifts all of it at once, and so does
fullscreen, which has no recommendations to thin.

Nothing is ever removed from the page. A hidden card keeps its exact box and is
**painted black** instead, because collapsing it would make the page shorter,
YouTube would fetch another screenful to fill the gap, and that loop does not
end. Hiding is done with `visibility`, which covers the whole card however it is
built — a sidebar card carries two links, the thumbnail and the title, so hiding
the thumbnail alone left the title sitting there in plain sight — and the black
square is drawn by a pseudo-element on top. If a card is ever shaped oddly enough
that the square misses it, what is left is blank space of the same height: never
leaked content, never a changed layout.

## The daily chart

Entertainment sits at the **bottom** of every stacked column, because it is the
one series measured against a line and a segment only reads against a line when
it starts from the baseline. Below it sits any **debt carried in** (brown), above
it any **banked time** used (gold). The daily limit is drawn across both views, and
whatever went **over** everything is split off: a gradient running hot toward the top, a
bright cap line, and a glow around the mark — the one thing in the chart allowed
to be loud. The worst day of the month is labelled outright.

That colour is magenta rather than a brighter red, which is not a style choice:
dark-mode entertainment is already a light red, so every brighter red sits under
ΔE 15 against it — indistinguishable even with full colour vision, never mind
colour blindness. Magenta clears every gate in both themes (CVD ΔE 9.2 light /
13.3 dark, normal-vision 19.9 / 15.9).

## Colours

The rest of the palette is checked the same way, not eyeballed: green/amber/red with a large enough
lightness spread that the pairs stay apart under red-green colour blindness
(worst-pair ΔE 14.7 light, 8.5 dark, against a ≥8 target), in both light and dark
themes. Background playback is the muted step of the same hue **plus a 45° hatch**,
so foreground and background never rest on colour alone. Every colour is also
labelled in the legend, the tooltips and the entries table.

## Known limits

- Chrome/Chromium, Manifest V3. Not tested on Firefox.
- Tab categories live in session storage: they survive a service-worker restart,
  but reset when Chrome fully closes. What survives that is the mark on the
  *video* — a tab reopened on the home feed, or on a video never marked, starts
  at the default again.
- The indicator's clock ticks in whole minutes and updates every few seconds, so
  a reminder can land a few seconds after the exact figure.
- Docking into the header means reading YouTube's markup (`ytd-masthead #buttons`)
  — the one piece of the extension coupled to their DOM. If it changes, the pill
  re-appears as a floating card rather than disappearing; nothing else is affected.
  On a narrow window the pill sheds its label, then its button, to leave YouTube's
  own controls room.
- A sleeping machine or a suspended worker leaves a gap of up to a few seconds
  unbilled at each end. That is deliberate — a gap is never billed.
- Editing a day that is still in progress discards at most the last few seconds of
  the session in flight.

## License

MIT — see [LICENSE](LICENSE).
