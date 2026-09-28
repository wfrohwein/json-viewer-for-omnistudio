# JSON Viewer for OmniStudio

[![test](https://github.com/wfrohwein/json-viewer-for-omnistudio/actions/workflows/test.yml/badge.svg)](https://github.com/wfrohwein/json-viewer-for-omnistudio/actions/workflows/test.yml)

A Chrome extension for Salesforce OmniStudio that shows the **live `jsonData`
payload of the OmniScript step you're currently looking at**, and the data behind
any **FlexCards** on the page, in a side panel — kept updated as you move between
steps and fill in fields.

It automates this DevTools ritual:

1. Right-click the step header → **Inspect**
2. Walk up the DOM to `runtime_omnistudio_omniscript-omniscript-step`
3. **Store as global variable** → `temp1`
4. `JSON.stringify(temp1.jsonData)`

It reads **FlexCards** too: each card's `records` — its data-source result,
with the card's UI state under `_flex` — is offered by card name, whether or not
there's an OmniScript on the page. See [FlexCards](#flexcards).

Search it, copy any value or path, snapshot payloads to compare later, and see
what changed as you fill a form.

**Everything stays on your machine.** The extension makes no network requests of
any kind — no telemetry, no analytics, no remote logging. Payloads are read from
the page you're on and, if you save one, stored in your own browser. Nothing is
ever transmitted anywhere. It has no runtime dependencies and no build step.

## Install

1. Download the zip from the [latest release](https://github.com/wfrohwein/json-viewer-for-omnistudio/releases/latest)
   and unzip it (or clone this repo)
2. Open `chrome://extensions`
3. Turn on **Developer mode** (top right)
4. **Load unpacked** → select the unzipped `json-viewer-for-omnistudio` folder
5. Open an OmniScript or FlexCard page and click the extension icon in the toolbar

The side panel opens on the right. Pin the extension to the toolbar
(puzzle-piece icon → pin) so the icon is always one click away.

## Using it

| | |
|---|---|
| **Search** | Matches keys *and* values. Branches auto-expand to reveal hits. `Enter` / `Shift+Enter` step through matches, `Cmd/Ctrl+F` focuses the box, `Esc` clears it. |
| **Filter** (funnel) | Hides every branch that doesn't contain a match. |
| **Tree / Raw** | Collapsible tree, or the pretty-printed JSON. |
| **Double-click** | Copies straight to the clipboard: a **key** copies its name, a **value** copies the bare value (no wrapping quotes), a **collapsed node** copies its whole subtree as JSON. |
| **Click a row** | Selects it — the footer shows its path (`$.Members[1].site`); **Path** / **Value** copy it. |
| **Alt+click a container row** | Expands or collapses that whole subtree at once. |
| **Expand / Collapse / Copy** | Open everything, shut everything, or copy the whole payload. |
| **Pause / Refresh** | Freeze the view while the page keeps changing, or force a re-read now. |
| **Source dropdown** | Appears when there's more than one payload to show: the OmniScript root's `jsonData` when it differs from the step's, any [FlexCards](#flexcards) on the page, or — when there's no OmniScript at all — [other elements on the page holding JSON](#when-theres-no-omniscript-other-elements). |

Hand-highlighting text works as you'd expect: selecting a leaf row updates in
place rather than redrawing, and a live payload tick will not rebuild the view
while you have text selected in it — so a selection you're about to copy can't
be yanked out from under you. A real step or script change always redraws.

The panel follows the active tab, so switching tabs switches payloads.

## Choosing what to read

Two dropdowns sit in their own full-width row just under the header, both
defaulting to auto-detect:

- **OmniScript** — only appears when the page actually has more than one.
  Steps are grouped by the OmniScript that owns them, and each is named from
  its component (e.g. `ACME / MembershipApplication · English`) with its step count.
- **Step** — every step in the selected OmniScript, including ones that aren't
  currently rendered.

In both lists `●` marks what's rendered right now and `○` what isn't. Switching
OmniScript clears any step you'd chosen inside the previous one.

Picking anything other than auto **stops the panel following the page** — that's
the point, but it's also easy to forget, so a pinned selection puts an amber
notice under the dropdowns naming what it's pinned to; clicking it resumes
following. The header also says *not the rendered step* whenever what you're
reading isn't what the page is showing, pinned or not.

**Selections are held loosely by design.** They're stored as keys — the
OmniScript's identity and the step's `data-omni-key` — not positions. As soon
as a choice stops resolving on the page (you navigate, the OmniScript
re-renders, a SPA route changes), it's dropped, the panel snaps back to
auto-detect and tells you so. A stale pick can never silently point at whatever
happens to occupy that slot now.

## FlexCards

FlexCards on the page are listed in the source dropdown by name, decoded from
the generated component tag the same way OmniScript names are:

```
forcegenerated-flex-card_-a-c-m-e_-account-actions___salesforce___1___false_gen
  → FlexCard · ACME_AccountActions · records
```

Each shows the card's `records`: the rows its data source returned, each with a
`_flex` object holding the card's per-record UI state (which state and elements
are showing). Cards that appear more than once are numbered (`(2)`), and cards
hidden on the page are listed after visible ones. A card whose data source
returned nothing still shows, as `[]`.

- **With an OmniScript on the page**, the step comes first and the cards follow
  it in the dropdown. Picking one switches the header to the card.
- **Without one**, the cards lead the [other elements](#when-theres-no-omniscript-other-elements)
  list, and the generic sweep doesn't list them a second time.

## When there's no OmniScript: other elements

If no OmniScript step can be read — none on the page, none rendered yet, or the
one that's there exposes no `jsonData` — the panel doesn't just go blank. It
sweeps the page (including open shadow roots) for **anything else holding JSON**
and offers what it finds in the source dropdown:

- **Component properties** — any custom element carrying a JSON object or array,
  either under a conventional name (`jsonData`, `data`, `value`, `record`,
  `records`, `items`, `config`, `payload`, …) or under its own property names.
- **`<script type="application/json">`** and `application/ld+json` blocks.
- **JSON parked in a `data-*` attribute.**

The header reads *Other elements* with the reason it fell back, and each source
is named after the element it came from (`c-record-form#billing · record`), so
you can tell what you're looking at. The biggest payload opens first, since
that's nearly always the interesting one. Everything else — search, tree, raw,
copy, snapshots, compare — works exactly as it does for a step payload.

Only plain objects and arrays with something in them are offered: DOM nodes,
dates, class instances, empty objects and framework internals (`_`/`$`-prefixed
properties) are filtered out, and the same object reached from two elements is
listed once. The scan is bounded — it stops after 40 candidates, offers at most
12, and re-runs at most every couple of seconds — so it stays cheap on pages the
extension knows nothing about. A real OmniScript always wins: the moment one
becomes readable, in any frame, the panel switches back to it.

## Sites on custom domains

Experience Cloud sites are often served from a company domain that no built-in
pattern matches. You never need to edit the extension for those — add them at
runtime:

- **From the panel.** On an unrecognised site the panel shows **Enable on this
  site**. One click grants permission for that origin only, injects the scanner
  into the page you're on, and registers it for future visits.
- **From Manage sites.** The *Manage sites…* link at the bottom of that same
  screen (also the extension's Options page, via `chrome://extensions` → Details
  → Extension options) opens a manager that lists **your open tabs** that aren't
  reachable yet with an **Add** button each — so you can enable the site you're
  on without typing anything. You can also paste any URL (only its domain is
  kept) or a wildcard host like `*.example.org`, review everything you've
  added, and remove any of it.

Permissions are per-origin, requested one at a time, and revocable — the
extension never asks for blanket access to every site. Once granted, a dynamic
content script is registered for that origin so it keeps working across
navigations and browser restarts.

If Chrome refuses to show its permission prompt over the side panel (it won't
always anchor one there), the panel falls back to opening Manage sites, which is
an ordinary tab where the prompt always works.

## Saving payloads

**Save** (or `Cmd/Ctrl+S`) keeps a snapshot of what you're looking at. Each one
records **when** you took it, the **page URL**, the step name and key, which
source it came from, and its size. The bookmark icon in the header opens the
list — the badge is how many you have.

From the list you can **open** a snapshot (click its name), **rename** it,
**download** it as a `.json` file, or **delete** it. The search box filters the
list by name, step or URL. Clicking a snapshot's URL opens that page in a new
tab. Delete and *Clear all* ask once before acting.

An open snapshot is read-only and clearly banded at the top with when it was
captured — the live page keeps updating underneath without disturbing what
you're reading, and **Back to live** returns you. Search, the tree, and copying
all work inside a snapshot exactly as they do live.

Snapshots live in `chrome.storage.local` under the `unlimitedStorage`
permission, so they survive browser restarts and aren't capped at the usual
10 MB. The list holds only metadata; payload bodies load on demand, so a long
list stays fast.

## Seeing what just changed

When the live payload updates, whatever moved is flashed in place — amber for a
changed value, green for an addition. Only the rows that actually changed light
up, so a single edited field is easy to spot in a large payload.

**The markers stay until you dismiss them.** The flash is brief, just to catch
your eye, but a coloured edge remains on every changed row afterwards. So you
can look away, fill in half a step, come back, and still see everything that
moved. Edits accumulate: each new change adds to the set rather than replacing
it.

The pill in the corner counts them and has two halves — the left jumps to a
change (preferring one you *can't* currently see, since one already on screen
needs no jumping), the **✕** clears every marker. Changes buried in a collapsed
branch would otherwise be invisible, so each container hiding one gets a small
`●`.

Moving to a different step clears the markers rather than lighting up the entire
new payload — a fresh document isn't a change. The flash also survives redraws:
a live tick mid-flash resumes the animation where it was instead of restarting
it, and once it finishes the row returns to normal styling so hover and
selection still work. Honours `prefers-reduced-motion`, where the persistent
marker alone carries the information.

## Comparing payloads

The **⇄** button on any snapshot compares it against the live payload; the
**Compare** button in the snapshot banner does the same for the one you're
reading. Once the comparison is open, the two dropdowns at the top let you point
either side anywhere — snapshot vs live, or snapshot vs snapshot — and **⇄**
swaps them.

Differences are listed by path, with the baseline (the left-hand dropdown) on
the left of each `→`:

```
~  $.Budget.lines.salaries      800 → 1200
+  $.Rows[2]                    {…} 2 keys
−  $.Removed                    "gone soon"
```

`~` changed, `+` added, `−` removed, with counts (and how many leaves were
identical) across the top. The search box filters the list; double-clicking a
row copies that path.

When one side is **Live payload**, the comparison re-runs as the page changes —
so you can pin a baseline before filling a step and watch the differences appear
as you type.

One thing to know: **arrays are compared by index.** That's predictable and
right for OmniScript tables, but inserting a row near the top of a long array
reads as a run of changes rather than one insertion.

## How it works

Salesforce sites are covered out of the box: `*.my.site.com` (including
sandboxes such as `example--dev.sandbox.my.site.com`), `*.force.com`,
`*.salesforce.com`, `*.visualforce.com`, `*.cloudforce.com`,
`*.salesforce-sites.com` and `*.salesforce-experience.com`.

| File | Role |
|---|---|
| `content-main.js` | Runs in the page's **MAIN world** — the only place `element.jsonData` is visible, since an isolated content script can't see properties set by page JavaScript. Groups steps by OmniScript, picks the rendered one, serializes its payload, posts it out. |
| `content-bridge.js` | Isolated world. Relays between the page and the extension (the MAIN-world script has no `chrome.*` access). |
| `background.js` | Caches the latest payload per tab/frame, fans it out to the panel, turns the scanner on only while a panel is watching, and registers content scripts for sites you add. |
| `sidepanel.html/.css/.js` | The viewer: tree, search, snapshots, comparison, change markers. |
| `options.html/.css/.js` | The Sites manager. |
| `theme.css` | Colour tokens shared by both pages. |
| `tools/make-icons.js` | Regenerates `icons/` — no image libraries, shapes are rasterised and PNG-encoded directly. |

Requires Chrome 114+ (side panel). MAIN-world content scripts need 111+.

**Finding the right step.** Steps are grouped by their nearest
`…-omniscript-container` ancestor, so each OmniScript on the page (nested ones
included) forms its own group. Within a group the current step is resolved from
the strongest signal available:

1. **The OmniScript's own step chart.** The chart marks the current entry with
   `.slds-is-active`, and its `data-index` is the step element's position among
   its siblings — an exact identification, straight from the component.
2. The chart's active **label**, matched against step labels.
3. The visible step that **has layout** (non-zero height) and the most content.
4. The visible step with the most content.

Signals 3 and 4 are last resorts on purpose. "Biggest visible step wins" breaks
as soon as a visited step's markup lingers in the DOM — the panel then sticks on
whichever step is fattest rather than the one you're on. The payload reports
which signal was used; hover the step dropdown to see it.

Unknown namespaces and native shadow DOM are handled by a deeper fallback scan.

When no step can be read at all, the same deep walk is reused to collect JSON
from anywhere else on the page (see [Other elements](#when-theres-no-omniscript-other-elements)).
That payload is tagged `mode: 'other'` and is scored *below* every real
OmniScript payload, so a script in a subframe still wins over a page-wide sweep
of the top frame.

**Staying current.** `jsonData` mutates in place as you type, without any DOM
change, so a MutationObserver alone isn't enough — the scanner polls every 750ms
while the panel is open (and reacts to DOM changes within 250ms) and only sends a
payload when its fingerprint actually changes. **While the panel is closed it
does no serialization at all**, just a 5-second heartbeat so the background can
re-activate it after a navigation.

Serialization survives what `JSON.stringify` normally chokes on: circular
references become `[Circular]`, DOM nodes `[DOM div]`, functions `[Function]`.

## Development

```sh
npm install     # jsdom, for the tests only
npm test        # scanner + fallback + FlexCard + panel + sites suites (~295 assertions)
npm run icons   # regenerate icons/ from tools/make-icons.js
```

Five suites, all driven through jsdom with stubbed `chrome.*` APIs:

- **`test/test-scan.js`** runs `content-main.js` against a DOM fixture shaped
  like a real OmniScript page — two OmniScripts, each with rendered and
  unrendered steps — and checks grouping, name decoding, step detection,
  labelling, serialization, script/step selection, stale-selection fallback,
  live in-place updates, and following the page when a visited step's markup
  lingers.
- **`test/test-other.js`** runs the same scanner against a page with *no*
  readable OmniScript and checks the fallback: component properties, JSON script
  tags and `data-*` attributes are found; empty objects, scalars, dates,
  duplicates and framework internals are not; a real OmniScript appearing takes
  over, and its removal falls back again.
- **`test/test-flexcard.js`** runs the scanner against FlexCards using real
  generated tag names: name decoding, numbering repeated cards, hidden cards
  last, empty cards, no duplicates from the generic sweep, live updates, and the
  cards riding alongside an OmniScript.
- **`test/test-panel.js`** drives the side panel: tree, search, filtering,
  navigation, copying (double-click and hand-highlighting), step transitions,
  the snapshot lifecycle (save, list, filter, open, rename, download, delete,
  clear), comparison (changed/added/removed, nested and array differences,
  swapping sides, tracking a live side) and change markers (flash, persistence,
  accumulation, dismissal).
- **`test/test-options.js`** drives the Sites manager: pattern normalising,
  coverage tests, tab suggestions, adding, declined and failed requests, and
  removal.

jsdom has no layout engine, so `test-scan.js` stubs `checkVisibility()` to
emulate Chrome. Step detection is verified against a fixture, not live browser
layout.

After editing any file, press the reload arrow on the extension card in
`chrome://extensions`, then reload the Salesforce tab.

## Contributing

Pull requests are welcome — see [CONTRIBUTING.md](CONTRIBUTING.md). The short
version: `npm test` must pass, new behaviour comes with a test, no new runtime
dependencies, no network calls, and **never commit real org data**. The fixtures
are deliberately fictional and CI fails the build if a real-looking Salesforce
host, org ID or token shows up.

Every pull request is reviewed before it's merged, and CI must pass first.

## Security

Found a security problem? Please report it privately rather than in an issue.
See [SECURITY.md](SECURITY.md).

## Privacy

No data leaves your browser. The extension makes no network requests. It reads
`jsonData` from the page you have open, renders it in the side panel, and — only
if you press Save — stores a copy in `chrome.storage.local` on your own machine.
There is no telemetry, no analytics, and no remote error reporting.

Host access is per-origin. Salesforce's own domains are declared in the
manifest; anything else is only reachable after you explicitly grant it, and you
can revoke it at any time from Manage sites.

## Licence

[MIT](LICENSE) — do what you like with it, no warranty.

## Disclaimer

This is an independent, unofficial tool. It is **not affiliated with, endorsed
by, or supported by Salesforce, Inc.** "Salesforce", "OmniStudio", "OmniScript",
"Experience Cloud" and "Lightning" are trademarks of Salesforce, Inc., used here
only to describe what this tool works with.

It reads data that is already present in your own browser session, on pages you
are already authorised to view — it does not bypass any authentication or
access control. You are responsible for using it in line with your
organisation's policies and any agreements covering the data you're looking at.
