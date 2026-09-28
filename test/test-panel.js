/* Drives sidepanel.js inside jsdom with a stubbed chrome.* API. */

const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const EXT = path.join(__dirname, '..');

const dom = new JSDOM(fs.readFileSync(`${EXT}/sidepanel.html`, 'utf8'), {
  runScripts: 'outside-only',
  url: 'chrome-extension://test/sidepanel.html'
});
const { window } = dom;

const sent = [];
const noop = { addListener() {} };
window.chrome = {
  runtime: {
    connect: () => ({ onMessage: noop, onDisconnect: noop, postMessage: (m) => sent.push(m) })
  },
  tabs: {
    onActivated: noop,
    onUpdated: noop,
    query: async () => [{ id: 7, url: 'https://x.my.site.com/s/p' }]
  },
  windows: { getCurrent: async () => ({ id: 1 }), onFocusChanged: noop },
  permissions: { contains: async () => true },
  storage: {
    onChanged: noop,
    local: (() => {
      const db = new Map();
      return {
        db,
        async get(key) {
          const keys = Array.isArray(key) ? key : [key];
          const out = {};
          for (const k of keys) if (db.has(k)) out[k] = db.get(k);
          return out;
        },
        async set(obj) {
          for (const [k, v] of Object.entries(obj)) db.set(k, v);
        },
        async remove(key) {
          for (const k of Array.isArray(key) ? key : [key]) db.delete(k);
        }
      };
    })()
  }
};
window.Element.prototype.scrollIntoView = function () {};

const clipboard = [];
Object.defineProperty(window.navigator, 'clipboard', {
  configurable: true,
  value: {
    writeText: async (text) => {
      clipboard.push(text);
    }
  }
});

// Evaluate the panel and expose its internals in the same eval so the module's
// const/let bindings are in scope.
window.eval(
  `${fs.readFileSync(`${EXT}/sidepanel.js`, 'utf8')}
;window.__api = {
  get state() { return state; },
  ui, applyPayload, pathLabel, matchCount, gotoMatch, render, refreshSaves, openDiff
};`
);
const api = window.__api;
const doc = window.document;
const el = (id) => doc.getElementById(id);

const rows = () => Array.from(doc.querySelectorAll('#tree .row'));
const rowText = () => rows().map((r) => r.textContent);
const has = (s) => rowText().some((t) => t.includes(s));
const type = (value) => {
  api.ui.search.value = value;
  api.ui.search.dispatchEvent(new window.Event('input'));
};
const click = (node, detail = 1) =>
  node.dispatchEvent(new window.MouseEvent('click', { bubbles: true, detail }));
const dblclick = (node) =>
  node.dispatchEvent(new window.MouseEvent('dblclick', { bubbles: true, detail: 2 }));
const highlight = (node) => {
  const range = doc.createRange();
  range.selectNodeContents(node);
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(range);
};
const settle = () => new Promise((r) => setTimeout(r, 10));

let failures = 0;
const check = (name, cond, detail) => {
  console.log(`${cond ? '  ok  ' : ' FAIL '} ${name}${detail !== undefined ? ` — ${detail}` : ''}`);
  if (!cond) failures++;
};

// --------------------------------------------------------------- fixture data

const data = {
  ContextId: 'a0X5f000001abc',
  ApplicationYear: '2025-2026',
  Members: [
    { tier: 'T1', count: 120, site: 'Alpha Site' },
    { tier: 'T2', count: 240, site: 'Beta Site' }
  ],
  Budget: { total: 1000, lines: { salaries: 800, supplies: 200 } },
  'odd key.with-dots': true
};

const SCRIPT_A = {
  index: 0,
  key: 'ACME / MembershipApplication|Welcome_Instructions|2',
  label: 'ACME / MembershipApplication · English',
  steps: 2,
  rendered: true
};
const SCRIPT_B = {
  index: 1,
  key: 'ACME / SupportCase|Case_Details|2',
  label: 'ACME / SupportCase · English',
  steps: 2,
  rendered: false
};

const makePayload = (obj) => ({
  ok: true,
  detected: 2,
  ts: Date.now(),
  scripts: [SCRIPT_A],
  script: SCRIPT_A,
  scriptPinned: false,
  stepPinned: false,
  stepRendered: true,
  signal: 'chart',
  step: {
    index: 0,
    key: 'Welcome_Instructions',
    label: 'Welcome and Instructions'
  },
  steps: [
    { index: 0, key: 'Welcome_Instructions', label: 'Welcome and Inst…', visible: true, weight: 120 },
    {
      index: 1,
      key: 'Applicant_Details',
      label: 'Applicant Details',
      visible: false,
      weight: 0
    }
  ],
  sources: [
    {
      id: 'step',
      label: 'Active step · jsonData',
      json: JSON.stringify(obj),
      bytes: JSON.stringify(obj).length
    }
  ]
});

// ------------------------------------------------------------------ the tests

api.state.tabId = 7;
api.applyPayload(makePayload(data));

check('header shows the step label',
  el('stepLabel').textContent === 'Welcome and Instructions');
check('tree is visible', !el('tree').classList.contains('hidden'));
check('empty state hidden', el('empty').classList.contains('hidden'));
check('rendered rows', rows().length > 5, `${rows().length} rows`);
check('top-level keys present', has('ApplicationYear'));
check('expanded two levels by default', has('tier') && has('salaries'), 'nested keys shown');

// a data table must not blow the default view open
const bulk = { Rows: Array.from({ length: 400 }, (_, i) => ({ id: i, name: `Row ${i}` })) };
api.applyPayload(makePayload(bulk));
check('large collections stay collapsed by default', !has('Row 12'), `${rows().length} rows`);
check('the large collection is still listed', has('Rows') && has('400 items'));
api.applyPayload(makePayload(data));

// --- search
type('beta');
check('search finds a value', api.matchCount() === 1, api.matchCount());
check('counter reads 1/1', el('count').textContent === '1/1', el('count').textContent);
check('match highlighted', doc.querySelectorAll('#tree mark').length > 0);
check('current match distinguished', doc.querySelectorAll('#tree mark.cur').length === 1);
check('auto-expanded to reveal the hit', has('Beta Site'));

type('salaries');
check('finds a deeply nested key', api.matchCount() === 1, api.matchCount());
check('auto-expanded the deep branch', has('salaries'));

// --- filter mode
const beforeFilter = rows().length;
api.ui.filter.click();
const afterFilter = rows().length;
check('filter prunes non-matching branches', afterFilter < beforeFilter,
  `${beforeFilter} -> ${afterFilter} rows`);
check('filtered view still shows the match', has('salaries'));
api.ui.filter.click();

// --- navigation across multiple matches
type('site');
const n = api.matchCount();
check('multiple matches found', n >= 2, `${n} matches`);
check('starts at the first match', el('count').textContent === `1/${n}`);
api.gotoMatch(1);
check('next advances', el('count').textContent === `2/${n}`, el('count').textContent);
api.gotoMatch(-1);
check('previous goes back', el('count').textContent === `1/${n}`, el('count').textContent);
api.gotoMatch(-1);
check('previous wraps around', el('count').textContent === `${n}/${n}`, el('count').textContent);

type('');
check('clearing search drops highlights', doc.querySelectorAll('#tree mark').length === 0);
check('counter clears', el('count').textContent === '');

// --- path labels
check('path label for an array element',
  api.pathLabel(['Members', 1, 'site']) === '$.Members[1].site',
  api.pathLabel(['Members', 1, 'site']));
check('path label quotes awkward keys',
  api.pathLabel(['odd key.with-dots']) === '$["odd key.with-dots"]',
  api.pathLabel(['odd key.with-dots']));

// --- expand / collapse
api.ui.expand.click();
check('expand all opens every branch', has('supplies'));
api.ui.collapse.click();
check('collapse all leaves just the top level', rows().length === 6, `${rows().length} rows`);
check('collapse all closes every branch', !has('total') && !has('tier'));

api.ui.expand.click();
rows()
  .find((r) => r.textContent.includes('Budget'))
  .dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
check('clicking a container collapses it', !has('supplies'));
check('clicking selects it and shows the path', el('path').textContent === '$.Budget',
  el('path').textContent);

// --- copying, and not losing the selection while doing it
api.ui.expand.click();
const leaf = () => rows().find((r) => r.textContent.includes('ApplicationYear'));

clipboard.length = 0;
dblclick(leaf().querySelector('.k'));
check('double-clicking a key copies the key name', clipboard[0] === 'ApplicationYear', clipboard[0]);

clipboard.length = 0;
dblclick(leaf().querySelector('.v'));
check('double-clicking a value copies the bare value, unquoted',
  clipboard[0] === '2025-2026', clipboard[0]);

clipboard.length = 0;
dblclick(rows().find((r) => r.textContent.includes('Budget')));
check('double-clicking a container copies its whole subtree',
  clipboard[0] && JSON.parse(clipboard[0]).lines.salaries === 800, clipboard[0]);

// A click used to rebuild the tree, which wiped whatever was highlighted.
const kept = leaf();
click(kept);
check('clicking a leaf leaves the DOM in place', kept.isConnected === true);
check('and still updates the footer path', el('path').textContent === '$.ApplicationYear',
  el('path').textContent);

// The second click of a double-click must not toggle a container open/shut.
const container = rows().find((r) => r.textContent.includes('Budget'));
const openBefore = has('salaries');
click(container, 2);
check('the second click of a double-click is ignored', has('salaries') === openBefore);

// A live payload must not redraw over an active highlight.
const highlighted = leaf();
highlight(highlighted.querySelector('.v'));
check('the highlight registers', !window.getSelection().isCollapsed);
api.applyPayload(makePayload({ ...data, ContextId: 'ticked' }));
check('a live update leaves the highlighted node alone', highlighted.isConnected === true);

// ...but a real step change still redraws.
const moved = makePayload({ Applicant: 1 });
moved.step = { index: 1, key: 'Applicant_Details', label: 'Applicant Details' };
api.applyPayload(moved);
check('moving to another step redraws regardless', highlighted.isConnected === false);
window.getSelection().removeAllRanges();
api.applyPayload(makePayload(data));

// --- flashing what just changed
const flashRows = () => rows().filter((r) => r.classList.contains('is-changed'));
check('a freshly loaded step starts with nothing flashing',
  api.state.changed.size === 0, api.state.changed.size);

api.applyPayload(makePayload({ ...data, ApplicationYear: '2026-2027' }));
check('a changed value is noticed', api.state.changed.size === 1, api.state.changed.size);
check('only the row that changed flashes', flashRows().length === 1, flashRows().length);
check('and it is the right row', flashRows()[0].textContent.includes('2026-2027'));
check('marked as a change, not an addition',
  flashRows()[0].classList.contains('flash-changed'));
// Age the flash, then redraw: it must resume partway through, not restart.
for (const info of api.state.changed.values()) info.at -= 2000;
api.render();
const resumedAt = parseFloat(flashRows()[0].style.animationDelay);
check('a redraw resumes the flash rather than restarting it',
  resumedAt <= -2000 && resumedAt > -2200, flashRows()[0].style.animationDelay);

// The marker must outlive the flash, and any number of later ticks.
for (const info of api.state.changed.values()) info.at -= 120000; // two minutes ago
api.render();
check('the marker survives long after the flash', flashRows().length === 1,
  flashRows().length);
api.applyPayload(makePayload({ ...data, ApplicationYear: '2026-2027' })); // no-op tick
api.applyPayload(makePayload({ ...data, ApplicationYear: '2026-2027' }));
check('and survives further live ticks', flashRows().length === 1, flashRows().length);
check('the pill is still offering it', !el('changePill').classList.contains('hidden'));
check('a pill offers to jump to it',
  !el('changePill').classList.contains('hidden') &&
    el('changePillText').textContent.includes('1 changed'),
  el('changePillText').textContent);

api.applyPayload(makePayload({ ...data, ApplicationYear: '2026-2027', NewKey: 'hello' }));
const addedRow = rows().find((r) => r.classList.contains('flash-added'));
check('an added key flashes as an addition',
  !!addedRow && addedRow.textContent.includes('NewKey'));

// a change hidden inside a shut branch must still be findable
api.ui.collapse.click();
api.applyPayload(
  makePayload({ ...data, Budget: { total: 1000, lines: { salaries: 1234, supplies: 200 } } })
);
const budgetRow = rows().find((r) => r.textContent.includes('Budget'));
check('a change inside a collapsed branch is marked', !!budgetRow.querySelector('.cdot'));
check('the collapsed branch is still shut', !has('1234'));
// Several things changed at once; the pill should go to the one out of sight,
// not to whichever happens to be first.
click(api.ui.changeJump);
check('clicking the pill opens the branch and reveals the hidden change', has('1234'));

// dismissing clears them
click(api.ui.changeDismiss);
check('dismissing clears every marker', api.state.changed.size === 0);
check('the rows go back to normal', flashRows().length === 0);
check('and the pill goes away', el('changePill').classList.contains('hidden'));
check('collapsed-branch dots go too', !doc.querySelector('#tree .cdot'));

// markers come back on the next edit, and accumulate until dismissed again
api.applyPayload(makePayload({ ...data, ContextId: 'edit-one' }));
const afterFirst = api.state.changed.size;
check('a later edit marks again after dismissal', afterFirst > 0, afterFirst);
api.applyPayload(makePayload({ ...data, ContextId: 'edit-one', ApplicationYear: '2030-2031' }));
check('separate edits accumulate rather than replacing each other',
  api.state.changed.size > afterFirst, `${afterFirst} then ${api.state.changed.size}`);

// moving on wipes the flashes rather than lighting up the whole new step
const movedOn = makePayload({ Applicant: 1 });
movedOn.step = { index: 1, key: 'Applicant_Details', label: 'Applicant Details' };
api.applyPayload(movedOn);
check('changing step clears the flashes', api.state.changed.size === 0);
check('and hides the pill', el('changePill').classList.contains('hidden'));
api.applyPayload(makePayload(data));

// --- raw view
api.ui.viewRaw.click();
check('raw view shows pretty JSON', el('raw').textContent.includes('"ApplicationYear": "2025-2026"'));
check('raw view hides the tree', el('tree').classList.contains('hidden'));
type('Site');
check('raw view counts matches', api.matchCount() > 0, api.matchCount());
check('raw view highlights matches', doc.querySelectorAll('#raw mark').length > 0);
api.ui.viewTree.click();
type('');

// --- step picker
check('step picker lists auto-detect plus every step', el('stepPick').options.length === 3,
  el('stepPick').options.length);
check('step picker marks the rendered step',
  el('stepPick').options[1].textContent.startsWith('●') &&
    el('stepPick').options[2].textContent.startsWith('○'));
api.ui.stepPick.value = 'Applicant_Details';
api.ui.stepPick.dispatchEvent(new window.Event('change'));
check('choosing a step sends its key to the page',
  sent.some((m) => m.type === 'PICK' && m.stepKey === 'Applicant_Details'),
  JSON.stringify(sent.slice(-1)));

// The pickers must not share the action row: in a side panel the non-shrinking
// buttons squeeze any dropdown next to them down to an unreadable sliver.
check('step picker lives in its own row, away from the buttons',
  el('stepPick').parentElement.id === 'pickers' && el('stepPick').closest('#tools') === null);
check('script picker lives there too', el('scriptPick').parentElement.id === 'pickers');
check('pickers row is visible when there are steps',
  !el('pickers').classList.contains('hidden'));
check('closed step picker names the step it auto-detected',
  el('stepPick').options[0].textContent.includes('step 1 of 2') &&
    el('stepPick').options[0].textContent.includes('Welcome'),
  el('stepPick').options[0].textContent);
check('step options are numbered', el('stepPick').options[1].textContent.includes('1. '),
  el('stepPick').options[1].textContent);

// --- OmniScript picker
check('script picker hidden when there is only one', el('scriptPick').classList.contains('hidden'));

const twoScripts = makePayload(data);
twoScripts.scripts = [SCRIPT_A, SCRIPT_B];
api.applyPayload(twoScripts);
check('script picker appears when there are two',
  !el('scriptPick').classList.contains('hidden'));
check('script picker lists auto plus both scripts', el('scriptPick').options.length === 3,
  el('scriptPick').options.length);
check('script picker marks which one is rendered',
  el('scriptPick').options[1].textContent.startsWith('●') &&
    el('scriptPick').options[2].textContent.startsWith('○'));
check('script picker shows step counts',
  el('scriptPick').options[1].textContent.includes('2 steps'),
  el('scriptPick').options[1].textContent);
check('header names the script when there is a choice',
  el('stepMeta').textContent.includes('MembershipApplication'), el('stepMeta').textContent);

api.ui.scriptPick.value = SCRIPT_B.key;
api.ui.scriptPick.dispatchEvent(new window.Event('change'));
const pick = sent[sent.length - 1];
check('choosing an OmniScript sends its key', pick.type === 'PICK' && pick.scriptKey === SCRIPT_B.key,
  JSON.stringify(pick));
check('switching OmniScript clears the step choice', pick.stepKey === null, JSON.stringify(pick));

// --- a selection the page can no longer resolve is dropped
api.state.pick.scriptKey = SCRIPT_B.key;
api.state.pick.stepKey = 'Case_Terms';
const dropped = makePayload(data);
dropped.scripts = [SCRIPT_A];
dropped.scriptPinned = false; // page says: that script is gone
api.applyPayload(dropped);
check('a stale OmniScript choice is forgotten', api.state.pick.scriptKey === null);
check('and its step choice goes with it', api.state.pick.stepKey === null);

api.state.pick.stepKey = 'Applicant_Details';
const stepGone = makePayload(data);
stepGone.stepPinned = false;
api.applyPayload(stepGone);
check('a stale step choice is forgotten on its own', api.state.pick.stepKey === null);

// --- viewing a step that is not the rendered one is called out
check('no pin warning while following the page', el('unpin').classList.contains('hidden'));

const pinned = makePayload(data);
pinned.stepPinned = true;
pinned.stepRendered = false;
pinned.step = { index: 1, key: 'Applicant_Details', label: 'Applicant Details' };
api.state.pick.stepKey = 'Applicant_Details';
api.applyPayload(pinned);
check('header warns when the step is not the rendered one',
  el('stepMeta').textContent.includes('not the rendered step'), el('stepMeta').textContent);
check('a pinned step raises a visible notice', !el('unpin').classList.contains('hidden'));
check('the notice names the pinned step',
  el('unpinText').textContent.includes('Applicant Details'), el('unpinText').textContent);

sent.length = 0;
click(api.ui.unpin);
check('clicking the notice clears both pins',
  sent.some((m) => m.type === 'PICK' && m.scriptKey === null && m.stepKey === null),
  JSON.stringify(sent));
check('and forgets them locally',
  api.state.pick.stepKey === null && api.state.pick.scriptKey === null);

// the warning does not depend on having pinned anything
const drifted = makePayload(data);
drifted.stepRendered = false;
api.applyPayload(drifted);
check('warns whenever the step is not the rendered one, pinned or not',
  el('stepMeta').textContent.includes('not the rendered step'), el('stepMeta').textContent);

api.applyPayload(makePayload(data));
check('pin notice clears once following again', el('unpin').classList.contains('hidden'));

// --- live update of the same step preserves expansion
api.state.expanded.add('Budget');
api.render();
const wasOpen = has('salaries');
api.applyPayload(makePayload({ ...data, ApplicationYear: '2026-2027' }));
check('live update shows new values', has('2026-2027'));
check('live update keeps branches open', wasOpen && has('salaries'));

// --- moving to another step swaps the payload
const other = makePayload({ Applicant: { rows: [1, 2, 3] } });
other.step = { index: 1, key: 'Applicant_Details', label: 'Applicant Details' };
api.applyPayload(other);
check('next step swaps the payload', has('Applicant') && !has('ApplicationYear'));
check('header follows the step', el('stepLabel').textContent === 'Applicant Details');

// --- degraded payloads
api.applyPayload({ ok: false, reason: 'no-omniscript' });
check('empty state returns', !el('empty').classList.contains('hidden'));
check('explains why', el('stepMeta').textContent.includes('No OmniScript'), el('stepMeta').textContent);

api.applyPayload({ ok: false, reason: 'no-omniscript', scanned: true });
check('says when nothing else on the page had JSON either',
  el('stepMeta').textContent.includes('no JSON on any other element'), el('stepMeta').textContent);

// --- other elements, when there is no OmniScript to read
const otherJson = { catalog: { items: [{ sku: 'A-1', qty: 4 }] } };
const OTHER = {
  ok: true,
  mode: 'other',
  reason: 'no-omniscript',
  href: 'https://example.my.salesforce.com/lightning/r/Account/001/view',
  detected: 0,
  scripts: [],
  found: 3,
  ts: Date.now(),
  sources: [
    {
      id: 'other:c-catalog.data#1',
      label: 'c-catalog#main · data',
      json: JSON.stringify(otherJson),
      bytes: JSON.stringify(otherJson).length
    },
    {
      id: 'other:script.application/ld+json#1',
      label: 'script · application/ld+json',
      json: JSON.stringify({ '@type': 'Organization', name: 'ACME' }),
      bytes: 40
    }
  ]
};
api.applyPayload(OTHER);
check('renders JSON found on another element',
  has('catalog') && has('items') && !el('tree').classList.contains('hidden'), rowText().join(' | '));
check('names the element in the header',
  el('stepLabel').textContent === 'c-catalog#main · data', el('stepLabel').textContent);
check('says why it fell back',
  el('stepMeta').textContent.includes('Other elements') &&
    el('stepMeta').textContent.includes('no OmniScript here'),
  el('stepMeta').textContent);
check('counts what it found', el('stepMeta').textContent.includes('2 of 3'), el('stepMeta').textContent);
check('offers the other sources', !el('source').classList.contains('hidden') &&
  el('source').options.length === 2, `${el('source').options.length} options`);
check('hides the step and script pickers', el('pickers').classList.contains('hidden'));
check('no pin banner', el('unpin').classList.contains('hidden'));

api.ui.source.value = 'other:script.application/ld+json#1';
api.ui.source.dispatchEvent(new window.Event('change'));
check('switching source swaps the payload', has('Organization') && !has('catalog'));

api.applyPayload(makePayload(data));
check('a real OmniScript takes the panel back',
  el('stepLabel').textContent === 'Welcome and Instructions' && has('ApplicationYear'));
check('pickers come back', !el('pickers').classList.contains('hidden'));

// --------------------------------------------------------------- snapshots

const saveRows = () => Array.from(doc.querySelectorAll('#saves .save'));

(async () => {
  const live = makePayload(data);
  live.href = 'https://example--dev.sandbox.my.site.com/portal/s/application';
  api.applyPayload(live);

  check('save button enabled with live data', api.ui.save.disabled === false);
  click(api.ui.save);
  await settle();

  check('snapshot written to storage', api.state.saves.length === 1, `${api.state.saves.length}`);
  const meta = api.state.saves[0];
  check('snapshot records the time', typeof meta.ts === 'number' && Date.now() - meta.ts < 5000);
  check('snapshot records the url', meta.url === live.href, meta.url);
  check('snapshot records the step', meta.stepKey === 'Welcome_Instructions', meta.stepKey);
  check('snapshot names itself after the step',
    meta.name === 'Welcome and Instructions', meta.name);
  check('badge shows the count', el('savesCount').textContent === '1' &&
    !el('savesCount').classList.contains('hidden'));

  // second snapshot, of a different step
  const other = makePayload({ Applicant: { rows: [1, 2, 3] } });
  other.step = { index: 1, key: 'Applicant_Details', label: 'Applicant Details' };
  other.href = 'https://example--dev.sandbox.my.site.com/portal/s/application#step2';
  api.applyPayload(other);
  click(api.ui.save);
  await settle();
  check('a second snapshot is kept alongside', api.state.saves.length === 2);
  check('newest snapshot is first', api.state.saves[0].stepKey === 'Applicant_Details');

  // --- the saves screen
  click(api.ui.savesBtn);
  await settle();
  check('saves screen opens', !el('saves').classList.contains('hidden'));
  check('data views hide behind it',
    el('tree').classList.contains('hidden') && el('tools').classList.contains('hidden'));
  check('pickers hide behind it too', el('pickers').classList.contains('hidden'));
  check('lists every snapshot', saveRows().length === 2, `${saveRows().length}`);
  check('shows when it was taken', saveRows()[0].textContent.includes('just now'));
  check('shows the url', saveRows()[0].textContent.includes('example--dev.sandbox.my.site.com'));

  // filter the list
  type('Applicant');
  check('search filters the list', saveRows().length === 1, `${saveRows().length}`);
  type('nothing-matches-this');
  check('no matches shows a message', saveRows().length === 0 &&
    el('saves').textContent.includes('No snapshots match'));
  type('');
  check('clearing restores the list', saveRows().length === 2);

  // --- open one
  click(saveRows()[1].querySelector('[data-act="open"]'));
  await settle();
  check('opening a snapshot shows its data', has('ApplicationYear'));
  check('opening returns to the data screen', !el('tree').classList.contains('hidden'));
  check('banner announces the snapshot', !el('banner').classList.contains('hidden') &&
    el('bannerTitle').textContent.includes('Saved'));
  check('banner carries the url', el('bannerMeta').textContent.includes('example--dev'),
    el('bannerMeta').textContent);
  check('saving is disabled while viewing a snapshot', api.ui.save.disabled === true);
  check('pickers hidden while viewing a snapshot', el('pickers').classList.contains('hidden'));

  // a live update must not disturb the snapshot being read
  api.applyPayload(makePayload({ SomethingElse: 'live-value' }));
  check('live updates do not overwrite an open snapshot',
    has('ApplicationYear') && !has('live-value'));

  // search still works inside a snapshot
  type('Beta');
  check('search works inside a snapshot', api.matchCount() === 1, api.matchCount());
  type('');

  click(el('backLive'));
  await settle();
  check('back to live restores the live payload', has('SomethingElse'));
  check('banner clears', el('banner').classList.contains('hidden'));
  check('saving re-enabled', api.ui.save.disabled === false);

  // --- rename
  click(api.ui.savesBtn);
  await settle();
  click(saveRows()[0].querySelector('[data-act="rename"]'));
  const input = doc.querySelector('.save-rename');
  check('rename opens an input', !!input);
  input.value = 'Before budget edit';
  input.focus();
  api.applyPayload(makePayload({ tick: 1 })); // a live payload lands mid-rename
  check('a live update does not clobber an in-progress rename',
    doc.querySelector('.save-rename') &&
      doc.querySelector('.save-rename').value === 'Before budget edit');
  input.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  await settle();
  check('rename persists', api.state.saves[0].name === 'Before budget edit', api.state.saves[0].name);
  check('rename shows in the list', saveRows()[0].textContent.includes('Before budget edit'));

  // --- delete needs confirming
  const delBtn = () => saveRows()[0].querySelector('[data-act="delete"]');
  click(delBtn());
  await settle();
  check('first delete click only arms', api.state.saves.length === 2);
  check('armed button asks for confirmation', delBtn().textContent === 'Delete?');
  click(delBtn());
  await settle();
  check('second click deletes', api.state.saves.length === 1, `${api.state.saves.length}`);
  check('deleting drops the stored body too', [...window.chrome.storage.local.db.keys()]
    .filter((k) => k.startsWith('ojv:body:')).length === 1);

  // --- clear all
  const clearBtn = () => doc.querySelector('[data-act="clear"]');
  click(clearBtn());
  await settle();
  check('clear all arms first', api.state.saves.length === 1);
  click(clearBtn());
  await settle();
  check('clear all empties the list', api.state.saves.length === 0);
  check('and empties storage', [...window.chrome.storage.local.db.keys()]
    .filter((k) => k.startsWith('ojv:body:')).length === 0);
  check('empty state explains how to save',
    el('saves').textContent.includes('No saved payloads'));

  // ------------------------------------------------------------- comparing

  const diffRows = () => Array.from(doc.querySelectorAll('#diff .drow'));
  const diffText = () => el('diff').textContent;

  const baseline = {
    ApplicationYear: '2025-2026',
    Budget: { total: 1000, lines: { salaries: 800, supplies: 200 } },
    Removed: 'gone soon',
    Rows: [{ id: 1, count: 10 }, { id: 2, count: 20 }]
  };
  const changed = {
    ApplicationYear: '2025-2026',
    Budget: { total: 1400, lines: { salaries: 1200, supplies: 200 } },
    Added: 'brand new',
    Rows: [{ id: 1, count: 10 }, { id: 2, count: 99 }, { id: 3, count: 30 }]
  };

  // Save the baseline, then let the live payload move on.
  const basePayload = makePayload(baseline);
  basePayload.href = 'https://example--dev.sandbox.my.site.com/portal/s/application';
  api.applyPayload(basePayload);
  click(api.ui.save);
  await settle();
  const baseId = api.state.saves[0].id;

  api.applyPayload(makePayload(changed));
  await api.openDiff(baseId, 'live');
  await settle();

  check('comparison screen opens', !el('diff').classList.contains('hidden'));
  check('other screens step aside',
    el('tree').classList.contains('hidden') && el('saves').classList.contains('hidden') &&
      el('tools').classList.contains('hidden'));
  check('comparison bar appears', !el('diffBar').classList.contains('hidden'));
  check('both sides are selectable', el('diffA').options.length === 2 &&
    el('diffB').options.length === 2, `${el('diffA').options.length}`);
  check('sides are set as asked',
    el('diffA').value === baseId && el('diffB').value === 'live');

  check('spots a changed scalar',
    diffText().includes('$.Budget.total') && diffText().includes('1000') &&
      diffText().includes('1400'));
  check('spots a nested change', diffText().includes('$.Budget.lines.salaries'));
  check('leaves identical values out', !diffText().includes('$.Budget.lines.supplies'));
  check('spots an added key', diffText().includes('$.Added'));
  check('spots a removed key', diffText().includes('$.Removed'));
  check('spots a changed array element', diffText().includes('$.Rows[1].count'));
  check('spots an appended array element', diffText().includes('$.Rows[2]'));
  // 2 added: the new key, plus the appended array element.
  check('counts them up',
    diffText().includes('3 changed') && diffText().includes('2 added') &&
      diffText().includes('1 removed'), diffText().slice(0, 60));
  check('counts the identical leaves too', diffText().includes('identical'));
  check('classifies each row',
    diffRows().filter((r) => r.classList.contains('kind-changed')).length === 3 &&
      diffRows().filter((r) => r.classList.contains('kind-added')).length === 2 &&
      diffRows().filter((r) => r.classList.contains('kind-removed')).length === 1,
    diffRows().map((r) => r.className).join(','));

  // filtering
  type('salaries');
  check('the search box filters the changes', diffRows().length === 1, `${diffRows().length}`);
  type('');
  check('clearing restores them', diffRows().length === 6, `${diffRows().length}`);

  // swap
  click(api.ui.diffSwap);
  await settle();
  check('swapping flips the sides',
    api.state.diff.a === 'live' && api.state.diff.b === baseId);
  check('and inverts added/removed',
    diffRows().filter((r) => r.classList.contains('kind-added')).length === 1 &&
      diffRows().filter((r) => r.classList.contains('kind-removed')).length === 2,
    diffRows().map((r) => r.className).join(','));

  // a live side tracks the page
  await api.openDiff(baseId, 'live');
  await settle();
  const beforeRows = diffRows().length;
  api.applyPayload(makePayload({ ...changed, Budget: { total: 9999, lines: { salaries: 1200, supplies: 200 } } }));
  await settle();
  check('comparing against live follows the page',
    diffText().includes('9999'), `${beforeRows} rows before`);

  // identical payloads
  api.applyPayload(makePayload(baseline));
  await api.openDiff(baseId, 'live');
  await settle();
  check('identical payloads report no differences',
    diffRows().length === 0 && diffText().includes('identical'), diffText().slice(0, 80));

  // copying a path out of a comparison
  api.applyPayload(makePayload(changed));
  await api.openDiff(baseId, 'live');
  await settle();
  clipboard.length = 0;
  dblclick(diffRows()[0]);
  check('double-clicking a difference copies its path',
    clipboard[0] && clipboard[0].startsWith('$.'), clipboard[0]);

  // deleting a side closes the comparison
  click(api.ui.diffClose);
  check('closing returns to the saves list', !el('saves').classList.contains('hidden'));

  console.log(failures ? `\n${failures} FAILURE(S)` : '\nall checks passed');
  process.exit(failures ? 1 : 0);
})();
