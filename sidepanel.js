/* JSON Viewer for OmniStudio — side panel UI. */

'use strict';

const $ = (sel) => document.querySelector(sel);

const ui = {
  dot: $('#dot'),
  stepLabel: $('#stepLabel'),
  stepMeta: $('#stepMeta'),
  pause: $('#pause'),
  refresh: $('#refresh'),
  search: $('#search'),
  count: $('#count'),
  prev: $('#prev'),
  next: $('#next'),
  filter: $('#filter'),
  viewTree: $('#viewTree'),
  viewRaw: $('#viewRaw'),
  tools: $('#tools'),
  save: $('#save'),
  savesBtn: $('#savesBtn'),
  savesCount: $('#savesCount'),
  saves: $('#saves'),
  banner: $('#banner'),
  bannerTitle: $('#bannerTitle'),
  bannerMeta: $('#bannerMeta'),
  bannerDiff: $('#bannerDiff'),
  backLive: $('#backLive'),
  diffBar: $('#diffBar'),
  diffA: $('#diffA'),
  diffB: $('#diffB'),
  diffSwap: $('#diffSwap'),
  diffClose: $('#diffClose'),
  diff: $('#diff'),
  source: $('#source'),
  pickers: $('#pickers'),
  scriptPick: $('#scriptPick'),
  stepPick: $('#stepPick'),
  unpin: $('#unpin'),
  unpinText: $('#unpinText'),
  expand: $('#expand'),
  collapse: $('#collapse'),
  copy: $('#copy'),
  body: $('#body'),
  empty: $('#empty'),
  emptyHint: $('#emptyHint'),
  grant: $('#grant'),
  inject: $('#inject'),
  manageSites: $('#manageSites'),
  tree: $('#tree'),
  raw: $('#raw'),
  path: $('#path'),
  copyPath: $('#copyPath'),
  copyValue: $('#copyValue'),
  stats: $('#stats'),
  toast: $('#toast'),
  changePill: $('#changePill'),
  changeJump: $('#changeJump'),
  changeDismiss: $('#changeDismiss'),
  changePillText: $('#changePillText')
};

const MAX_ROWS = 15000;
const MAX_INDEX_NODES = 400000;
const MAX_RAW_MARKS = 3000;
const MAX_EXPAND_ALL = 8000;
const MAX_AUTO_EXPAND_MATCHES = 4000;
const STR_PREVIEW = 400;

const state = {
  windowId: null,
  tabId: null,
  tabUrl: '',
  port: null,

  payload: null,
  sourceId: null,
  identity: '', // step + source; when this changes we reset expansion/scroll
  jsonText: '',
  data: undefined,
  parseError: null,
  prettyCache: null,

  expanded: new Set(),
  paths: new Map(), // pk -> path array, for every row currently rendered
  selected: null, // { pk, path }

  query: '',
  filter: false,
  view: 'tree',
  paused: false,

  screen: 'data', // 'data' | 'saves' | 'diff'
  diff: { a: 'live', b: 'live', rows: [], counts: {}, truncated: false, error: null },
  diffCache: new Map(), // snapshot id -> body text
  viewing: null, // metadata of the snapshot on screen, null when live
  saves: [], // snapshot index (metadata only; bodies load on demand)
  armed: null, // id (or 'all') of a delete awaiting confirmation
  renaming: null, // id of the snapshot being renamed

  // Manual overrides, sent to the page as keys. The page drops them when they
  // stop resolving, and reports back whether they took.
  pick: { scriptKey: null, stepKey: null },

  // What changed on the last live tick, so it can be flashed in place.
  changed: new Map(), // pk -> { kind, at, path }
  changedAncestors: new Set(), // pks of containers holding a recent change

  index: null,
  matches: [],
  rawMatchCount: 0,
  keepSet: null,
  matchPos: 0,
  rowLimitHit: false
};

/* ------------------------------------------------------------------ helpers */

/* Key for a node path. Only ever used as a Set/Map key — never parsed back
 * into a path, so paths keep real numbers for array indices. */
const SEP = '\u0001';
const pkOf = (path) => path.join(SEP);

const typeOf = (v) => (v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v);
const isContainer = (t) => t === 'object' || t === 'array';

/* True for the fallback payload: no OmniScript was readable, so the page was
 * swept for JSON sitting on other elements. There is no step or script to
 * describe, and nothing to pin. */
const isOther = (p) => !!p && p.mode === 'other';

/* A FlexCard's records — offered in either mode, beside a step or among the
 * other elements. */
const isCard = (s) => !!s && typeof s.id === 'string' && s.id.startsWith('flexcard:');

function pathLabel(path) {
  let out = '$';
  for (const seg of path) {
    if (typeof seg === 'number') out += `[${seg}]`;
    else if (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(seg)) out += `.${seg}`;
    else out += `[${JSON.stringify(seg)}]`;
  }
  return out;
}

function valueAt(path) {
  let cur = state.data;
  for (const seg of path) {
    if (cur === null || typeof cur !== 'object') return undefined;
    cur = cur[seg];
  }
  return cur;
}

function childKeys(value, type) {
  return type === 'array' ? value.map((_, i) => i) : Object.keys(value);
}

function truncate(text, max) {
  const s = String(text || '');
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

function fmtBytes(n) {
  if (n === null || n === undefined) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

let toastTimer = null;
function toast(msg) {
  ui.toast.textContent = msg;
  ui.toast.classList.add('is-on');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => ui.toast.classList.remove('is-on'), 1400);
}

async function copyText(text, what) {
  try {
    await navigator.clipboard.writeText(text);
    toast(`${what} copied`);
  } catch (e) {
    toast('Copy failed');
  }
}

function send(message) {
  if (!state.port || state.tabId === null) return;
  try {
    state.port.postMessage(message);
  } catch (e) {
    /* worker cycled; onDisconnect will reconnect */
  }
}

/* ---------------------------------------------------------------- snapshots
 *
 * The index (metadata only) lives under one key so the list renders without
 * pulling every payload into memory; each body is stored under its own key.
 */

const INDEX_KEY = 'ojv:index';
const bodyKey = (id) => `ojv:body:${id}`;

async function refreshSaves() {
  try {
    const got = await chrome.storage.local.get(INDEX_KEY);
    state.saves = Array.isArray(got[INDEX_KEY]) ? got[INDEX_KEY] : [];
  } catch (e) {
    state.saves = [];
  }
  return state.saves;
}

async function writeIndex(list) {
  state.saves = list;
  await chrome.storage.local.set({ [INDEX_KEY]: list });
}

async function saveSnapshot() {
  if (state.viewing || state.data === undefined) return;
  const p = state.payload;
  if (!p || !p.ok) return;

  const source = (p.sources || []).find((s) => s.id === state.sourceId);
  const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const other = isOther(p) || isCard(source);
  const meta = {
    id,
    ts: Date.now(),
    url: p.href || state.tabUrl || '',
    name: other ? (source && source.label) || 'Page JSON' : p.step.label || p.step.key || 'Snapshot',
    stepKey: other ? '' : p.step.key || '',
    stepIndex: other ? -1 : p.step.index,
    sourceId: state.sourceId,
    sourceLabel: source ? source.label : '',
    bytes: state.jsonText.length
  };

  try {
    await chrome.storage.local.set({ [bodyKey(id)]: state.jsonText });
    await writeIndex([meta].concat(state.saves));
    toast('Saved');
  } catch (e) {
    toast(`Save failed: ${(e && e.message) || e}`);
    return;
  }
  render();
}

async function openSnapshot(id) {
  const meta = state.saves.find((s) => s.id === id);
  if (!meta) return;
  let text = '';
  try {
    const got = await chrome.storage.local.get(bodyKey(id));
    text = got[bodyKey(id)] || '';
  } catch (e) {
    toast('Could not read that snapshot');
    return;
  }
  state.viewing = meta;
  state.screen = 'data';
  setQuery('');
  loadData(text, `snapshot:${id}`, null);
  render();
}

function backToLive() {
  if (!state.viewing) return;
  state.viewing = null;
  state.identity = ''; // force a clean reload of the live payload
  setQuery('');
  applyPayload(state.payload);
}

async function deleteSnapshot(id) {
  if (state.viewing && state.viewing.id === id) backToLive();
  state.diffCache.delete(id);
  if (state.screen === 'diff' && (state.diff.a === id || state.diff.b === id)) {
    state.screen = 'saves';
  }
  try {
    await chrome.storage.local.remove(bodyKey(id));
  } catch (e) {
    /* body may already be gone */
  }
  await writeIndex(state.saves.filter((s) => s.id !== id));
  render();
}

async function clearSnapshots() {
  if (state.viewing) backToLive();
  state.diffCache.clear();
  if (state.screen === 'diff') state.screen = 'saves';
  const keys = state.saves.map((s) => bodyKey(s.id));
  try {
    if (keys.length) await chrome.storage.local.remove(keys);
  } catch (e) {
    /* best effort */
  }
  await writeIndex([]);
  render();
  toast('All snapshots deleted');
}

async function renameSnapshot(id, name) {
  const trimmed = name.trim();
  if (!trimmed) return;
  await writeIndex(state.saves.map((s) => (s.id === id ? { ...s, name: trimmed } : s)));
  if (state.viewing && state.viewing.id === id) state.viewing.name = trimmed;
  render();
}

async function downloadSnapshot(id) {
  const meta = state.saves.find((s) => s.id === id);
  if (!meta) return;
  let text = '';
  try {
    const got = await chrome.storage.local.get(bodyKey(id));
    text = got[bodyKey(id)] || '';
  } catch (e) {
    return;
  }
  let pretty = text;
  try {
    pretty = JSON.stringify(JSON.parse(text), null, 2);
  } catch (e) {
    /* keep the raw text */
  }
  const stamp = new Date(meta.ts).toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const slug = (meta.stepKey || meta.name || 'omniscript')
    .replace(/[^A-Za-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  const url = URL.createObjectURL(new Blob([pretty], { type: 'application/json' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = `${slug || 'omniscript'}-${stamp}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

function relativeTime(ts) {
  const secs = Math.round((Date.now() - ts) / 1000);
  if (secs < 45) return 'just now';
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  return days < 30 ? `${days}d ago` : new Date(ts).toLocaleDateString();
}

function shortUrl(url) {
  try {
    const u = new URL(url);
    return `${u.host}${u.pathname}`;
  } catch (e) {
    return url || '';
  }
}

/* --------------------------------------------------------------- comparing
 *
 * A structural diff between any two payloads — a snapshot and the live page, or
 * two snapshots. Arrays are compared by index, which is predictable and right
 * for OmniScript tables; an insert near the top will read as a run of changes.
 */

const MAX_DIFF_ROWS = 5000;

function briefValue(value) {
  const type = typeOf(value);
  if (type === 'string') return `"${truncate(value, 80)}"`;
  if (type === 'array') return `[…] ${value.length} item${value.length === 1 ? '' : 's'}`;
  if (type === 'object') {
    const n = Object.keys(value).length;
    return `{…} ${n} key${n === 1 ? '' : 's'}`;
  }
  return String(value);
}

function walkDiff(a, b, path, out) {
  if (out.rows.length >= MAX_DIFF_ROWS) {
    out.truncated = true;
    return;
  }

  const ta = typeOf(a);
  const tb = typeOf(b);

  if (ta !== tb) {
    out.rows.push({ path, kind: 'changed', a, b });
    out.counts.changed++;
    return;
  }

  if (!isContainer(ta)) {
    if (a === b) out.counts.same++;
    else {
      out.rows.push({ path, kind: 'changed', a, b });
      out.counts.changed++;
    }
    return;
  }

  if (ta === 'array') {
    const len = Math.max(a.length, b.length);
    for (let i = 0; i < len; i++) {
      if (i >= a.length) {
        out.rows.push({ path: path.concat([i]), kind: 'added', b: b[i] });
        out.counts.added++;
      } else if (i >= b.length) {
        out.rows.push({ path: path.concat([i]), kind: 'removed', a: a[i] });
        out.counts.removed++;
      } else {
        walkDiff(a[i], b[i], path.concat([i]), out);
      }
    }
    return;
  }

  const keys = new Set(Object.keys(a).concat(Object.keys(b)));
  for (const key of keys) {
    const inA = Object.prototype.hasOwnProperty.call(a, key);
    const inB = Object.prototype.hasOwnProperty.call(b, key);
    if (!inA) {
      out.rows.push({ path: path.concat([key]), kind: 'added', b: b[key] });
      out.counts.added++;
    } else if (!inB) {
      out.rows.push({ path: path.concat([key]), kind: 'removed', a: a[key] });
      out.counts.removed++;
    } else {
      walkDiff(a[key], b[key], path.concat([key]), out);
    }
  }
}

function liveText() {
  const p = state.payload;
  if (!p || !p.ok) return null;
  const sources = p.sources || [];
  const source = sources.find((s) => s.id === state.sourceId) || sources[0];
  return source && source.json ? source.json : null;
}

async function sideText(id) {
  if (id === 'live') return liveText();
  if (state.diffCache.has(id)) return state.diffCache.get(id);
  try {
    const got = await chrome.storage.local.get(bodyKey(id));
    const text = got[bodyKey(id)];
    if (text === undefined) return null;
    state.diffCache.set(id, text);
    return text;
  } catch (e) {
    return null;
  }
}

function sideLabel(id) {
  if (id === 'live') return 'Live payload';
  const meta = state.saves.find((s) => s.id === id);
  return meta ? meta.name : 'Missing snapshot';
}

async function computeDiff() {
  const d = state.diff;
  d.rows = [];
  d.counts = { added: 0, removed: 0, changed: 0, same: 0 };
  d.truncated = false;
  d.error = null;

  const [aText, bText] = await Promise.all([sideText(d.a), sideText(d.b)]);
  if (aText === null || bText === null) {
    d.error =
      aText === null && bText === null
        ? 'Neither side is available right now.'
        : `No payload available for “${sideLabel(aText === null ? d.a : d.b)}”.`;
    return;
  }

  let a;
  let b;
  try {
    a = JSON.parse(aText || 'null');
    b = JSON.parse(bText || 'null');
  } catch (e) {
    d.error = 'One of the payloads could not be parsed.';
    return;
  }

  walkDiff(a, b, [], d);
}

async function openDiff(aId, bId) {
  state.screen = 'diff';
  state.diff.a = aId;
  state.diff.b = bId;
  state.armed = null;
  state.renaming = null;
  setQuery('');
  ui.body.scrollTop = 0;
  render();
  await computeDiff();
  render();
}

async function refreshDiff() {
  if (state.screen !== 'diff') return;
  await computeDiff();
  render();
}

/* -------------------------------------------------------------- tab wiring */

function connect() {
  state.port = chrome.runtime.connect({ name: 'ojv-panel' });
  state.port.onMessage.addListener(onPortMessage);
  state.port.onDisconnect.addListener(() => {
    // The service worker sleeps after ~30s idle; reconnect and re-subscribe.
    setTimeout(() => {
      connect();
      send({ type: 'WATCH', tabId: state.tabId });
    }, 300);
  });
}

function onPortMessage(msg) {
  if (!msg) return;
  if (msg.type === 'PAYLOAD') {
    if (msg.tabId !== state.tabId) return;
    if (state.paused && state.payload) return;
    applyPayload(msg.payload);
  } else if (msg.type === 'INJECTED') {
    ui.emptyHint.textContent = msg.ok
      ? 'Scanner injected — waiting for an OmniScript…'
      : `Could not inject: ${msg.error}`;
  }
}

async function resolveTab() {
  try {
    const win = await chrome.windows.getCurrent();
    state.windowId = win.id;
    const [tab] = await chrome.tabs.query({ active: true, windowId: win.id });
    if (!tab) return;
    const changed = tab.id !== state.tabId;
    state.tabId = tab.id;
    state.tabUrl = tab.url || '';
    if (changed) {
      state.payload = null;
      state.identity = '';
      state.data = undefined;
      render();
      send({ type: 'WATCH', tabId: state.tabId });
    }
    updateEmptyActions();
  } catch (e) {
    /* window closing */
  }
}

chrome.tabs.onActivated.addListener((info) => {
  if (info.windowId === state.windowId) resolveTab();
});

chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (tabId !== state.tabId) return;
  if (info.url) {
    state.tabUrl = info.url;
    updateEmptyActions();
  }
});

chrome.windows.onFocusChanged.addListener(() => resolveTab());

/* ------------------------------------------------------------ payload apply */

/* ---------------------------------------------------------- recent changes */

/* Markers persist until dismissed (or until the step changes) — the brief flash
 * is only there to catch the eye. Accumulating edits stay visible so you can
 * come back to the panel and see everything that moved while you were away. */
const MAX_TRACKED_CHANGES = 3000;

function clearChanges() {
  state.changed.clear();
  state.changedAncestors = new Set();
}

function dismissChanges() {
  if (!state.changed.size) return;
  clearChanges();
  render();
}

function rebuildChangedAncestors() {
  const set = new Set();
  for (const info of state.changed.values()) {
    for (let i = 0; i < info.path.length; i++) set.add(pkOf(info.path.slice(0, i)));
  }
  state.changedAncestors = set;
}

/** Oldest-first eviction, so a long editing session can't grow without bound. */
function capChanges() {
  const excess = state.changed.size - MAX_TRACKED_CHANGES;
  if (excess <= 0) return;
  const oldest = Array.from(state.changed.entries())
    .sort((a, b) => a[1].at - b[1].at)
    .slice(0, excess);
  for (const [pk] of oldest) state.changed.delete(pk);
}

/** Record what moved between two versions of the same document. */
function noteChanges(previous, next) {
  const out = { rows: [], counts: { added: 0, removed: 0, changed: 0, same: 0 }, truncated: false };
  try {
    walkDiff(previous, next, [], out);
  } catch (e) {
    return;
  }
  if (!out.rows.length) return;

  const now = Date.now();
  for (const row of out.rows) {
    state.changed.set(pkOf(row.path), { kind: row.kind, at: now, path: row.path });
  }
  capChanges();
  rebuildChangedAncestors();
}

function revealNewestChange() {
  const entries = Array.from(state.changed.values()).sort((a, b) => b.at - a.at);
  if (!entries.length) return;

  // A removed node has nowhere to jump to — its parent carries the marker
  // instead — so only aim at things that still exist.
  const alive = entries.filter((e) => e.kind !== 'removed');
  const pool = alive.length ? alive : entries;

  // Prefer a change you cannot currently see; one already on screen needs no
  // jumping. state.paths holds exactly the rows rendered right now.
  const target = pool.find((e) => !state.paths.has(pkOf(e.path))) || pool[0];
  const path = target.path;

  for (let i = 0; i < path.length; i++) state.expanded.add(pkOf(path.slice(0, i)));
  state.view = 'tree';
  render();
  const pk = pkOf(path);
  for (const row of ui.tree.querySelectorAll('.row')) {
    if (row.dataset.pk === pk) {
      row.scrollIntoView({ block: 'center', inline: 'nearest' });
      break;
    }
  }
}

/**
 * Swap in a JSON document. `identity` names what is being shown — when it
 * changes we treat it as a different document and reset the view; when it
 * stays the same (a live payload ticking) expansion and scroll are preserved.
 */
function loadData(text, identity, sourceError) {
  const fresh = identity !== state.identity;
  loadData.wasFresh = fresh;
  state.identity = identity;

  if (text !== state.jsonText || sourceError) {
    const previous = fresh ? undefined : state.data;
    state.jsonText = text;
    state.prettyCache = null;
    state.index = null;
    state.parseError = null;
    if (sourceError) {
      state.data = { error: sourceError };
    } else {
      try {
        state.data = JSON.parse(text || 'null');
      } catch (e) {
        state.data = undefined;
        state.parseError = String((e && e.message) || e);
      }
    }
    // Same document, new content: work out what moved so it can be flashed.
    if (previous !== undefined && state.data !== undefined) noteChanges(previous, state.data);
  }

  if (fresh) {
    clearChanges();
    state.expanded = defaultExpansion(state.data);
    state.selected = null;
    ui.body.scrollTop = 0;
  }

  if (state.query) runSearch({ keepPos: !fresh });
}

function applyPayload(payload) {
  state.payload = payload;

  // A comparison against the live payload tracks the page as it changes.
  if (state.screen === 'diff' && (state.diff.a === 'live' || state.diff.b === 'live')) {
    refreshDiff();
  }

  // A snapshot is on screen — keep the live payload current underneath, but
  // leave what the user is reading alone.
  if (state.viewing) return;

  if (!payload || !payload.ok) {
    state.data = undefined;
    state.jsonText = '';
    state.identity = '';
    render();
    return;
  }

  // A manual choice that no longer resolves on the page (a navigation, a
  // re-render, a different OmniScript) is dropped rather than left dangling.
  if (state.pick.scriptKey && !payload.scriptPinned) {
    state.pick.scriptKey = null;
    state.pick.stepKey = null;
    toast('OmniScript selection reset — back to auto');
  } else if (state.pick.stepKey && !payload.stepPinned) {
    state.pick.stepKey = null;
    toast('Step selection reset — back to auto');
  }

  const sources = payload.sources || [];
  const source = sources.find((s) => s.id === state.sourceId) || sources[0];
  state.sourceId = source ? source.id : null;

  // No OmniScript to name the document by — the page and the chosen element are
  // what identify it instead.
  const identity = isOther(payload)
    ? `other|${payload.href}|${state.sourceId}`
    : `${payload.script.key}|${payload.step.key}|${payload.step.index}|${state.sourceId}`;

  loadData(source && source.json ? source.json : '', identity, source && source.error);
  // Same document, just new numbers: let an in-progress text selection survive.
  // A genuinely different step or script always redraws.
  render({ keepSelection: !loadData.wasFresh });
}

/* Open the root plus two levels of containers — enough to see the shape of a
 * step payload at a glance. Big collections (enrollment tables and the like)
 * stay shut so a data-heavy step doesn't open into thousands of rows. */
const BULK_NODE_CHILDREN = 100;

function defaultExpansion(data) {
  const set = new Set();
  if (!isContainer(typeOf(data))) return set;
  set.add('');
  const walk = (value, path, depth) => {
    if (depth >= 2 || set.size > 500) return;
    for (const k of childKeys(value, typeOf(value))) {
      const child = value[k];
      const childType = typeOf(child);
      if (!isContainer(childType)) continue;
      if (childKeys(child, childType).length > BULK_NODE_CHILDREN) continue;
      const p = path.concat([k]);
      set.add(pkOf(p));
      walk(child, p, depth + 1);
    }
  };
  walk(data, [], 0);
  return set;
}

/* ------------------------------------------------------------------ search */

function buildIndex(data) {
  const out = [];
  const walk = (key, value, path) => {
    if (out.length >= MAX_INDEX_NODES) return;
    const type = typeOf(value);
    const keyStr = key === null ? '' : String(key);
    const valStr = isContainer(type) ? '' : value === null ? 'null' : String(value);
    out.push({ pk: pkOf(path), path, hay: `${keyStr} ${valStr}`.toLowerCase() });
    if (isContainer(type)) {
      for (const k of childKeys(value, type)) walk(k, value[k], path.concat([k]));
    }
  };
  walk(null, data, []);
  return out;
}

function countOccurrences(text, needle) {
  if (!needle) return 0;
  const lower = text.toLowerCase();
  let n = 0;
  let from = 0;
  let i;
  while ((i = lower.indexOf(needle, from)) !== -1) {
    n++;
    from = i + needle.length;
  }
  return n;
}

function matchCount() {
  return state.view === 'raw' ? state.rawMatchCount : state.matches.length;
}

function setQuery(value) {
  state.query = value;
  ui.search.value = value;
  runSearch();
}

function runSearch(opts = {}) {
  const q = state.query.trim().toLowerCase();

  state.matches = [];
  state.keepSet = null;
  state.rawMatchCount = 0;

  // On the snapshot and comparison screens the box filters rows instead.
  if (state.screen !== 'data' || !q || state.data === undefined) {
    state.matchPos = 0;
    return;
  }

  if (state.view === 'raw') {
    state.rawMatchCount = countOccurrences(prettyText(), q);
    if (!opts.keepPos || state.matchPos >= state.rawMatchCount) state.matchPos = 0;
    return;
  }

  if (!state.index) state.index = buildIndex(state.data);
  state.matches = state.index.filter((entry) => entry.hay.includes(q));

  // Every ancestor of a match must stay renderable (and open) so hits are visible.
  const keep = new Set();
  for (let i = 0; i < state.matches.length; i++) {
    const path = state.matches[i].path;
    for (let j = 0; j <= path.length; j++) keep.add(pkOf(path.slice(0, j)));
    if (i < MAX_AUTO_EXPAND_MATCHES) {
      for (let j = 0; j < path.length; j++) state.expanded.add(pkOf(path.slice(0, j)));
    }
  }
  state.keepSet = keep;

  if (!opts.keepPos || state.matchPos >= state.matches.length) state.matchPos = 0;
}

function gotoMatch(delta) {
  const n = matchCount();
  if (!n) return;
  state.matchPos = (state.matchPos + delta + n) % n;
  render();
  scrollToCurrent();
}

function scrollToCurrent() {
  const el = ui.body.querySelector('.is-cur') || ui.body.querySelector('mark.cur');
  if (el && el.scrollIntoView) el.scrollIntoView({ block: 'center', inline: 'nearest' });
}

/* ------------------------------------------------------------ tree building */

function buildRows() {
  const rows = [];
  state.rowLimitHit = false;
  state.paths = new Map();
  const filtering = state.filter && state.keepSet;

  const visit = (key, value, path, depth) => {
    if (rows.length >= MAX_ROWS) {
      state.rowLimitHit = true;
      return;
    }
    const type = typeOf(value);
    const pk = pkOf(path);
    const container = isContainer(type);
    const open = container && state.expanded.has(pk);

    state.paths.set(pk, path);
    rows.push({ key, value, type, path, pk, depth, container, open });
    if (!open) return;

    for (const k of childKeys(value, type)) {
      const childPath = path.concat([k]);
      if (filtering && !state.keepSet.has(pkOf(childPath))) continue;
      visit(k, value[k], childPath, depth + 1);
    }
  };

  if (state.data === undefined) return rows;
  visit(null, state.data, [], 0);
  return rows;
}

function highlight(text, isCurrentRow) {
  const q = state.query.trim();
  const frag = document.createDocumentFragment();
  if (!q) {
    frag.appendChild(document.createTextNode(text));
    return frag;
  }
  const lower = text.toLowerCase();
  const needle = q.toLowerCase();
  let from = 0;
  let first = true;
  let i;
  while ((i = lower.indexOf(needle, from)) !== -1) {
    if (i > from) frag.appendChild(document.createTextNode(text.slice(from, i)));
    const mark = document.createElement('mark');
    mark.textContent = text.slice(i, i + q.length);
    if (isCurrentRow && first) mark.className = 'cur';
    first = false;
    frag.appendChild(mark);
    from = i + q.length;
  }
  if (from < text.length) frag.appendChild(document.createTextNode(text.slice(from)));
  return frag;
}

function valueText(value, type) {
  if (type === 'string') {
    return `"${value.length > STR_PREVIEW ? `${value.slice(0, STR_PREVIEW)}…` : value}"`;
  }
  if (type === 'null') return 'null';
  return String(value);
}

function renderTree() {
  const rows = buildRows();
  const frag = document.createDocumentFragment();
  const current = state.view === 'tree' ? state.matches[state.matchPos] : null;
  const currentPk = current ? current.pk : null;

  for (const row of rows) {
    const el = document.createElement('div');
    el.className = 'row';
    el.dataset.pk = row.pk;
    el.style.paddingLeft = `${6 + row.depth * 13}px`;
    if (row.container) el.classList.add('is-container');
    if (state.selected && state.selected.pk === row.pk) el.classList.add('is-sel');
    const isCur = currentPk !== null && row.pk === currentPk;
    if (isCur) el.classList.add('is-cur');

    // Flash whatever just changed. The negative delay resumes the animation
    // partway through, so a redraw mid-fade doesn't restart it.
    const change = state.changed.get(row.pk);
    if (change) {
      el.classList.add('is-changed', `flash-${change.kind}`);
      el.style.animationDelay = `-${Date.now() - change.at}ms`;
    }

    const tw = document.createElement('span');
    tw.className = 'tw';
    tw.textContent = row.container ? (row.open ? '▾' : '▸') : '';
    el.appendChild(tw);

    if (row.key !== null) {
      const key = document.createElement('span');
      key.className = 'k';
      key.appendChild(highlight(String(row.key), isCur));
      el.appendChild(key);
      const colon = document.createElement('span');
      colon.className = 'c';
      colon.textContent = ':';
      el.appendChild(colon);
    }

    if (row.container) {
      const size = childKeys(row.value, row.type).length;
      const brace = document.createElement('span');
      brace.className = 'brace';
      if (row.type === 'array') brace.textContent = row.open ? '[' : '[ … ]';
      else brace.textContent = row.open ? '{' : '{ … }';
      el.appendChild(brace);
      const meta = document.createElement('span');
      meta.className = 'meta';
      meta.textContent = `${size} ${row.type === 'array' ? 'item' : 'key'}${size === 1 ? '' : 's'}`;
      el.appendChild(meta);

      // A change buried in a shut branch would otherwise be invisible.
      if (!row.open && state.changedAncestors.has(row.pk)) {
        const dot = document.createElement('span');
        dot.className = 'cdot';
        dot.textContent = '●';
        dot.title = 'Something in here just changed';
        el.appendChild(dot);
      }
    } else {
      const val = document.createElement('span');
      val.className = `v v-${row.type}`;
      val.appendChild(highlight(valueText(row.value, row.type), isCur));
      if (row.type === 'string' && row.value.length > STR_PREVIEW) val.title = row.value;
      el.appendChild(val);
    }

    frag.appendChild(el);
  }

  if (state.rowLimitHit) {
    const more = document.createElement('div');
    more.className = 'more';
    more.textContent = `… row limit (${MAX_ROWS}) reached — collapse a branch or search instead`;
    frag.appendChild(more);
  }

  ui.tree.replaceChildren(frag);
}

/* ------------------------------------------------------------- raw building */

function prettyText() {
  if (state.prettyCache === null) {
    try {
      const out = JSON.stringify(state.data, null, 2);
      state.prettyCache = out === undefined ? '' : out;
    } catch (e) {
      state.prettyCache = state.jsonText;
    }
  }
  return state.prettyCache;
}

function renderRaw() {
  const text = prettyText();
  const q = state.query.trim();
  if (!q) {
    ui.raw.textContent = text;
    return;
  }
  const lower = text.toLowerCase();
  const needle = q.toLowerCase();
  const frag = document.createDocumentFragment();
  let from = 0;
  let count = 0;
  let i;
  while ((i = lower.indexOf(needle, from)) !== -1 && count < MAX_RAW_MARKS) {
    if (i > from) frag.appendChild(document.createTextNode(text.slice(from, i)));
    const mark = document.createElement('mark');
    mark.textContent = text.slice(i, i + q.length);
    if (count === state.matchPos) mark.className = 'cur';
    frag.appendChild(mark);
    from = i + q.length;
    count++;
  }
  frag.appendChild(document.createTextNode(text.slice(from)));
  ui.raw.replaceChildren(frag);
}

/* ------------------------------------------------------------------ render */

function fillSelect(select, items, selectedValue) {
  select.replaceChildren();
  for (const item of items) {
    const opt = document.createElement('option');
    opt.value = String(item.value);
    opt.textContent = item.label;
    if (String(item.value) === String(selectedValue)) opt.selected = true;
    select.appendChild(opt);
  }
}

function describeProblem(p) {
  if (!p) return 'Waiting for an OmniScript page…';
  const swept = p.scanned ? ', and no JSON on any other element' : '';
  switch (p.reason) {
    case 'no-omniscript':
      return `No OmniScript step elements on this page${swept}`;
    case 'no-active-step':
      return `Found ${p.detected} steps, but none is rendered yet${swept}`;
    case 'no-jsondata':
      return `Step found, but it exposes no jsonData${swept}`;
    case 'error':
      return `Scanner error: ${p.message}`;
    default:
      return 'Waiting for an OmniScript page…';
  }
}

/** Why the panel is showing other elements instead of a step. */
function describeFallback(p) {
  switch (p.reason) {
    case 'no-active-step':
      return 'no rendered OmniScript step';
    case 'no-jsondata':
      return 'the step exposes no jsonData';
    default:
      return 'no OmniScript here';
  }
}

function renderSaves() {
  // Live payloads keep arriving while this screen is up; never rebuild the list
  // out from under someone who is typing a new name into it.
  const focused = document.activeElement;
  if (
    state.renaming &&
    focused &&
    focused.classList.contains('save-rename') &&
    focused.dataset.id === state.renaming
  ) {
    return;
  }

  const q = state.query.trim().toLowerCase();
  const list = q
    ? state.saves.filter((m) => `${m.name} ${m.stepKey} ${m.url}`.toLowerCase().includes(q))
    : state.saves;
  const totalBytes = state.saves.reduce((n, m) => n + (m.bytes || 0), 0);

  const frag = document.createDocumentFragment();

  const head = document.createElement('div');
  head.className = 'saves-head';
  const headText = document.createElement('div');
  headText.className = 'saves-head-text';
  const title = document.createElement('div');
  title.className = 'saves-title';
  title.textContent = 'Saved payloads';
  const sub = document.createElement('div');
  sub.className = 'saves-sub';
  sub.textContent = state.saves.length
    ? `${state.saves.length} snapshot${state.saves.length === 1 ? '' : 's'} · ${fmtBytes(totalBytes)}${
        q ? ` · ${list.length} shown` : ''
      }`
    : 'Nothing saved yet';
  headText.append(title, sub);
  head.appendChild(headText);

  if (state.saves.length) {
    const clear = document.createElement('button');
    clear.className = state.armed === 'all' ? 'text-btn danger' : 'text-btn';
    clear.dataset.act = 'clear';
    clear.textContent = state.armed === 'all' ? 'Delete all?' : 'Clear all';
    head.appendChild(clear);
  }
  frag.appendChild(head);

  if (!list.length) {
    const empty = document.createElement('div');
    empty.className = 'empty';
    const t = document.createElement('div');
    t.className = 'empty-title';
    t.textContent = state.saves.length ? 'No snapshots match' : 'No saved payloads';
    const body = document.createElement('p');
    body.className = 'empty-text';
    body.textContent = state.saves.length
      ? 'Try a different filter.'
      : 'Press Save while viewing a payload to keep a copy here, stamped with the time and page URL.';
    empty.append(t, body);
    frag.appendChild(empty);
  }

  for (const meta of list) {
    const row = document.createElement('div');
    row.className = 'save';
    row.dataset.id = meta.id;
    if (state.viewing && state.viewing.id === meta.id) row.classList.add('is-open');

    const main = document.createElement('div');
    main.className = 'save-main';

    if (state.renaming === meta.id) {
      const input = document.createElement('input');
      input.className = 'save-rename';
      input.value = meta.name;
      input.dataset.id = meta.id;
      main.appendChild(input);
      setTimeout(() => {
        input.focus();
        input.select();
      }, 0);
    } else {
      const name = document.createElement('div');
      name.className = 'save-name';
      name.dataset.act = 'open';
      name.textContent = meta.name;
      name.title = 'Open this snapshot';
      main.appendChild(name);
    }

    const metaLine = document.createElement('div');
    metaLine.className = 'save-meta';
    metaLine.textContent = [
      relativeTime(meta.ts),
      new Date(meta.ts).toLocaleString(),
      fmtBytes(meta.bytes)
    ].join(' · ');
    metaLine.title = meta.sourceLabel || '';
    main.appendChild(metaLine);

    if (meta.url) {
      const url = document.createElement('a');
      url.className = 'save-url';
      url.dataset.act = 'url';
      url.textContent = shortUrl(meta.url);
      url.title = `${meta.url}\n(opens in a new tab)`;
      main.appendChild(url);
    }

    const actions = document.createElement('div');
    actions.className = 'save-actions';
    const armed = state.armed === meta.id;
    const buttons = [
      {
        act: 'compare',
        label: 'Compare with the live payload',
        svg: 'M3 4.5h8V2l4 3.5L11 9V6.5H3zM13 11.5H5V14l-4-3.5L5 7v2.5h8z'
      },
      { act: 'rename', label: 'Rename', svg: 'M11.5 1.7l2.8 2.8-8 8L3 13l.5-3.3zM1 14.5h14V16H1z' },
      { act: 'download', label: 'Download JSON', svg: 'M7 1h2v6h3l-4 5-4-5h3zM2 13h12v2H2z' },
      { act: 'delete', label: 'Delete', svg: 'M6 1h4l.5 1H14v2H2V2h3.5zM3 5h10l-.8 10H3.8z' }
    ];
    for (const b of buttons) {
      const btn = document.createElement('button');
      btn.dataset.act = b.act;
      btn.title = b.label;
      btn.setAttribute('aria-label', b.label);
      if (b.act === 'delete' && armed) {
        btn.className = 'icon-btn armed';
        btn.textContent = 'Delete?';
      } else {
        btn.className = 'icon-btn';
        const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        svg.setAttribute('viewBox', '0 0 16 16');
        svg.setAttribute('aria-hidden', 'true');
        const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        path.setAttribute('d', b.svg);
        svg.appendChild(path);
        btn.appendChild(svg);
      }
      actions.appendChild(btn);
    }

    row.append(main, actions);
    frag.appendChild(row);
  }

  ui.saves.replaceChildren(frag);
}

/** True when the user is mid-selection inside `el` — rebuilding would wipe it. */
function hasTextSelectionIn(el) {
  const sel = window.getSelection && window.getSelection();
  if (!sel || sel.isCollapsed || !sel.rangeCount) return false;
  try {
    return el.contains(sel.getRangeAt(0).commonAncestorContainer);
  } catch (e) {
    return false;
  }
}

function renderFooter() {
  const onData = state.screen === 'data';
  const onDiff = state.screen === 'diff';
  const hasData = state.data !== undefined;

  ui.path.classList.toggle('is-hint', !onData || !state.selected);
  if (onDiff) {
    ui.path.textContent = 'Double-click a difference to copy its path';
  } else if (!onData) {
    ui.path.textContent = '';
  } else {
    ui.path.textContent = state.selected
      ? pathLabel(state.selected.path)
      : hasData
        ? 'Double-click a key or value to copy it'
        : '$';
  }

  ui.copyPath.classList.toggle('hidden', !onData);
  ui.copyValue.classList.toggle('hidden', !onData);

  if (onDiff) {
    ui.stats.textContent = `${sideLabel(state.diff.a)} → ${sideLabel(state.diff.b)}`;
  } else if (onData && hasData) {
    ui.stats.textContent = `${
      state.index ? `${state.index.length} nodes · ` : ''
    }${fmtBytes(state.jsonText.length)}`;
  } else {
    ui.stats.textContent = '';
  }
}

const KIND_MARK = { added: '+', removed: '−', changed: '~' };

function renderDiff() {
  const d = state.diff;
  const frag = document.createDocumentFragment();

  if (d.error) {
    const box = document.createElement('div');
    box.className = 'empty';
    const title = document.createElement('div');
    title.className = 'empty-title';
    title.textContent = 'Nothing to compare';
    const text = document.createElement('p');
    text.className = 'empty-text';
    text.textContent = d.error;
    box.append(title, text);
    frag.appendChild(box);
    ui.diff.replaceChildren(frag);
    return;
  }

  const q = state.query.trim().toLowerCase();
  const rows = q
    ? d.rows.filter((r) =>
        `${pathLabel(r.path)} ${briefValue(r.a)} ${briefValue(r.b)}`.toLowerCase().includes(q)
      )
    : d.rows;

  const head = document.createElement('div');
  head.className = 'diff-head';
  const counts = d.counts || {};
  for (const kind of ['changed', 'added', 'removed']) {
    if (!counts[kind]) continue;
    const chip = document.createElement('span');
    chip.className = `chip chip-${kind}`;
    chip.textContent = `${KIND_MARK[kind]} ${counts[kind]} ${kind}`;
    head.appendChild(chip);
  }
  const same = document.createElement('span');
  same.className = 'chip chip-same';
  same.textContent = d.rows.length
    ? `${counts.same || 0} identical`
    : 'The two payloads are identical';
  head.appendChild(same);
  if (q) {
    const shown = document.createElement('span');
    shown.className = 'chip chip-same';
    shown.textContent = `${rows.length} shown`;
    head.appendChild(shown);
  }
  frag.appendChild(head);

  for (const row of rows) {
    const el = document.createElement('div');
    el.className = `drow kind-${row.kind}`;
    el.dataset.path = pathLabel(row.path);

    const badge = document.createElement('span');
    badge.className = 'dbadge';
    badge.textContent = KIND_MARK[row.kind];
    badge.title = row.kind;

    const main = document.createElement('div');
    main.className = 'dmain';

    const path = document.createElement('code');
    path.className = 'dpath';
    path.appendChild(highlight(pathLabel(row.path), false));
    main.appendChild(path);

    const values = document.createElement('div');
    values.className = 'dvals';
    if (row.kind !== 'added') {
      const before = document.createElement('span');
      before.className = 'dold';
      before.appendChild(highlight(briefValue(row.a), false));
      before.title = truncate(JSON.stringify(row.a), 2000);
      values.appendChild(before);
    }
    if (row.kind === 'changed') {
      const arrow = document.createElement('span');
      arrow.className = 'darrow';
      arrow.textContent = '→';
      values.appendChild(arrow);
    }
    if (row.kind !== 'removed') {
      const after = document.createElement('span');
      after.className = 'dnew';
      after.appendChild(highlight(briefValue(row.b), false));
      after.title = truncate(JSON.stringify(row.b), 2000);
      values.appendChild(after);
    }
    main.appendChild(values);

    el.append(badge, main);
    frag.appendChild(el);
  }

  if (!rows.length && d.rows.length) {
    const none = document.createElement('div');
    none.className = 'more';
    none.textContent = 'No changes match the filter';
    frag.appendChild(none);
  }

  if (d.truncated) {
    const more = document.createElement('div');
    more.className = 'more';
    more.textContent = `… stopped after ${MAX_DIFF_ROWS} differences`;
    frag.appendChild(more);
  }

  ui.diff.replaceChildren(frag);
}

function render(opts = {}) {
  const p = state.payload;
  const ok = !!(p && p.ok);
  const snap = state.viewing;
  const onSaves = state.screen === 'saves';
  const onDiff = state.screen === 'diff';
  const onData = state.screen === 'data';
  const hasData = state.data !== undefined && (ok || !!snap);

  ui.dot.className = 'dot';
  if (ok && state.paused) ui.dot.classList.add('is-paused');
  else if (ok) ui.dot.classList.add('is-live');
  else if (p && p.detected) ui.dot.classList.add('is-warn');

  // snapshot banner
  ui.banner.classList.toggle('hidden', !snap || !onData);
  if (snap) {
    ui.bannerTitle.textContent = `Saved ${relativeTime(snap.ts)} — not live`;
    ui.bannerMeta.textContent = [
      new Date(snap.ts).toLocaleString(),
      shortUrl(snap.url),
      snap.sourceLabel
    ]
      .filter(Boolean)
      .join(' · ');
    ui.bannerMeta.title = snap.url || '';
  }

  // snapshot count badge
  ui.savesCount.textContent = String(state.saves.length);
  ui.savesCount.classList.toggle('hidden', state.saves.length === 0);
  ui.savesBtn.classList.toggle('is-on', onSaves);

  ui.unpin.classList.add('hidden'); // the live branch below re-shows it if held

  if (snap) {
    ui.stepLabel.textContent = snap.name;
    ui.stepMeta.textContent = [snap.stepKey, fmtBytes(snap.bytes), 'saved snapshot']
      .filter(Boolean)
      .join(' · ');
    ui.source.classList.add('hidden');
    ui.scriptPick.classList.add('hidden');
    ui.stepPick.classList.add('hidden');
  } else if (ok && isOther(p)) {
    // Fallback: JSON found elsewhere on the page. Nothing here belongs to an
    // OmniScript, so the step and script pickers have nothing to offer.
    const sources = p.sources || [];
    const source = sources.find((s) => s.id === state.sourceId) || sources[0];
    ui.stepLabel.textContent = (source && source.label) || 'Other page JSON';
    ui.stepMeta.textContent = [
      isCard(source) ? 'FlexCard — no OmniScript here' : `Other elements — ${describeFallback(p)}`,
      `${sources.length} of ${p.found}${p.capped ? '+' : ''} with JSON`,
      source ? fmtBytes(source.bytes) : null,
      state.paused ? 'paused' : `updated ${new Date(p.ts).toLocaleTimeString()}`
    ]
      .filter(Boolean)
      .join(' · ');

    fillSelect(
      ui.source,
      sources.map((s) => ({ value: s.id, label: s.label })),
      state.sourceId
    );
    ui.source.classList.toggle('hidden', sources.length < 2);
    ui.source.title = p.flexcards
      ? 'FlexCards and other elements on this page that are holding JSON'
      : 'Other elements on this page that are holding JSON';
    ui.scriptPick.classList.add('hidden');
    ui.stepPick.classList.add('hidden');
  } else if (ok) {
    const source = (p.sources || []).find((s) => s.id === state.sourceId);
    // A FlexCard beside the OmniScript isn't part of the step — don't say it is.
    const card = isCard(source);
    ui.stepLabel.textContent = card ? source.label : p.step.label || p.step.key || 'Step';
    ui.stepMeta.textContent = (card
      ? ['FlexCard on this page']
      : [
          (p.scripts || []).length > 1 ? p.script.label : null,
          p.step.key || null,
          `step ${p.step.index + 1} of ${(p.steps || []).length}`,
          // Be explicit whenever this isn't what the page is actually showing.
          p.stepRendered === false ? 'not the rendered step' : null
        ]
    )
      .concat([
        source ? fmtBytes(source.bytes) : null,
        state.paused ? 'paused' : `updated ${new Date(p.ts).toLocaleTimeString()}`
      ])
      .filter(Boolean)
      .join(' · ');

    fillSelect(
      ui.source,
      (p.sources || []).map((s) => ({ value: s.id, label: s.label })),
      state.sourceId
    );
    ui.source.classList.toggle('hidden', (p.sources || []).length < 2);
    ui.source.title = 'Payload source';

    const scripts = p.scripts || [];
    const steps = p.steps || [];

    fillSelect(
      ui.scriptPick,
      [{ value: '', label: `Auto-detect OmniScript (${scripts.length} on page)` }].concat(
        scripts.map((s) => ({
          value: s.key,
          label: `${s.rendered ? '● ' : '○ '}${s.label} · ${s.steps} step${
            s.steps === 1 ? '' : 's'
          }`
        }))
      ),
      p.scriptPinned ? p.script.key : ''
    );
    // Only worth showing when there is actually a choice to make.
    ui.scriptPick.classList.toggle('hidden', scripts.length < 2);

    // Name the step auto-detection landed on, so the closed dropdown still says
    // what you are reading.
    const autoLabel = p.stepPinned
      ? `Auto-detect step (${steps.length})`
      : `Auto · step ${p.step.index + 1} of ${steps.length}: ${truncate(
          p.step.label || p.step.key,
          44
        )}`;
    fillSelect(
      ui.stepPick,
      [{ value: '', label: autoLabel }].concat(
        steps.map((s) => ({
          value: s.key,
          label: `${s.visible && s.weight ? '● ' : '○ '}${s.index + 1}. ${
            s.label || s.key || `#${s.index}`
          }`
        }))
      ),
      p.stepPinned ? p.step.key : ''
    );
    ui.stepPick.classList.remove('hidden');
    ui.stepPick.title = `Active step detected from: ${p.signal || 'unknown'}`;

    // Held selections are the one way the panel legitimately stops following the
    // page, so make that state obvious instead of a quiet line of metadata.
    const held = p.stepPinned || p.scriptPinned;
    ui.unpin.classList.toggle('hidden', !held);
    if (held) {
      ui.unpinText.textContent = p.stepPinned
        ? `Pinned to “${truncate(p.step.label || p.step.key, 30)}” — click to follow the page`
        : 'Pinned to one OmniScript — click to follow the page';
    }
  } else {
    ui.stepLabel.textContent = 'JSON Viewer for OmniStudio';
    ui.stepMeta.textContent = describeProblem(p);
    ui.source.classList.add('hidden');
    ui.scriptPick.classList.add('hidden');
    ui.stepPick.classList.add('hidden');
    if (state.parseError) ui.emptyHint.textContent = `Could not parse payload: ${state.parseError}`;
  }

  // The pickers row only earns its space when there is something to pick.
  ui.pickers.classList.toggle(
    'hidden',
    !onData || !ok || !!snap || ui.stepPick.classList.contains('hidden')
  );
  ui.saves.classList.toggle('hidden', !onSaves);
  ui.diff.classList.toggle('hidden', !onDiff);
  ui.diffBar.classList.toggle('hidden', !onDiff);
  ui.tools.classList.toggle('hidden', !onData);
  ui.empty.classList.toggle('hidden', !onData || hasData);
  ui.tree.classList.toggle('hidden', !onData || !hasData || state.view !== 'tree');
  ui.raw.classList.toggle('hidden', !onData || !hasData || state.view !== 'raw');

  if (onDiff) {
    const options = [{ value: 'live', label: 'Live payload' }].concat(
      state.saves.map((m) => ({ value: m.id, label: `${m.name} · ${relativeTime(m.ts)}` }))
    );
    fillSelect(ui.diffA, options, state.diff.a);
    fillSelect(ui.diffB, options, state.diff.b);
    ui.diffA.title = `Baseline: ${sideLabel(state.diff.a)}`;
    ui.diffB.title = `Compared with: ${sideLabel(state.diff.b)}`;
    const scroll = ui.body.scrollTop;
    renderDiff();
    ui.body.scrollTop = scroll;
  } else if (onSaves) {
    const scroll = ui.body.scrollTop;
    renderSaves();
    ui.body.scrollTop = scroll;
  } else if (hasData) {
    const target = state.view === 'tree' ? ui.tree : ui.raw;
    // Never redraw out from under someone who is highlighting text to copy.
    if (!(opts.keepSelection && hasTextSelectionIn(target))) {
      const scroll = ui.body.scrollTop;
      if (state.view === 'tree') renderTree();
      else renderRaw();
      ui.body.scrollTop = scroll;
    }
  } else {
    ui.tree.replaceChildren();
    ui.raw.textContent = '';
  }

  ui.save.disabled = !hasData || !!snap || !ok;
  ui.save.title = snap
    ? 'Return to live to save a new snapshot'
    : 'Save a snapshot of this payload';

  ui.search.placeholder = onSaves
    ? 'Filter saved payloads…'
    : onDiff
      ? 'Filter changes…'
      : 'Search keys and values…';
  const n = matchCount();
  ui.count.textContent = onData && state.query.trim() ? (n ? `${state.matchPos + 1}/${n}` : '0') : '';
  ui.prev.disabled = !onData || !n;
  ui.next.disabled = !onData || !n;
  ui.prev.classList.toggle('hidden', !onData);
  ui.next.classList.toggle('hidden', !onData);
  ui.filter.classList.toggle('hidden', !onData);
  ui.filter.classList.toggle('is-on', state.filter);
  ui.pause.classList.toggle('is-on', state.paused);
  ui.viewTree.classList.toggle('is-on', state.view === 'tree');
  ui.viewRaw.classList.toggle('is-on', state.view === 'raw');
  ui.viewTree.setAttribute('aria-selected', String(state.view === 'tree'));
  ui.viewRaw.setAttribute('aria-selected', String(state.view === 'raw'));

  const marked = onData && !snap && state.changed.size > 0;
  ui.changePill.classList.toggle('hidden', !marked);
  if (marked) {
    const n = state.changed.size;
    ui.changePillText.textContent = `${n} changed`;
    ui.changeJump.title = `Jump to a change you can't see (${n} marked since you last cleared)`;
  }

  renderFooter();
}

async function updateEmptyActions() {
  let origin = null;
  try {
    const url = new URL(state.tabUrl);
    if (url.protocol === 'http:' || url.protocol === 'https:') origin = `${url.origin}/*`;
  } catch (e) {
    /* about:blank, chrome://, … */
  }
  if (!origin) {
    ui.grant.classList.add('hidden');
    ui.inject.classList.add('hidden');
    return;
  }
  let has = false;
  try {
    has = await chrome.permissions.contains({ origins: [origin] });
  } catch (e) {
    has = false;
  }
  ui.grant.dataset.origin = origin;
  ui.grant.classList.toggle('hidden', has);
  ui.inject.classList.toggle('hidden', !has);
}

/* ---------------------------------------------------------------- expansion */

function collapseSubtree(pk) {
  const prefix = pk + SEP;
  for (const key of Array.from(state.expanded)) {
    if (key !== pk && (pk === '' || key.startsWith(prefix))) state.expanded.delete(key);
  }
}

function expandSubtree(path) {
  let budget = MAX_EXPAND_ALL;
  const walk = (value, p) => {
    if (budget-- <= 0) return;
    const type = typeOf(value);
    if (!isContainer(type)) return;
    state.expanded.add(pkOf(p));
    for (const k of childKeys(value, type)) walk(value[k], p.concat([k]));
  };
  walk(valueAt(path), path);
}

/* ------------------------------------------------------------------ events */

ui.body.addEventListener('click', (event) => {
  const row = event.target.closest('.row');
  if (!row) return;
  // The second click of a double-click is for copying — don't act on it, or a
  // container would toggle underneath the word the browser is selecting.
  if (event.detail > 1) return;

  const pk = row.dataset.pk;
  const path = state.paths.get(pk);
  if (!path) return;

  const previous = ui.tree.querySelector('.row.is-sel');
  if (previous) previous.classList.remove('is-sel');
  row.classList.add('is-sel');
  state.selected = { pk, path };

  if (!row.classList.contains('is-container')) {
    // Selecting a leaf changes nothing structural, so update in place. A full
    // render here would rebuild the DOM and throw away any text highlight.
    renderFooter();
    return;
  }

  if (state.expanded.has(pk)) {
    state.expanded.delete(pk);
    if (event.altKey) collapseSubtree(pk);
  } else {
    state.expanded.add(pk);
    if (event.altKey) expandSubtree(path);
  }
  render();
});

// Double-click anything in the tree to put it on the clipboard.
ui.tree.addEventListener('dblclick', (event) => {
  const row = event.target.closest('.row');
  if (!row) return;
  const path = state.paths.get(row.dataset.pk);
  if (!path) return;

  if (event.target.closest('.k')) {
    copyText(path.length ? String(path[path.length - 1]) : '$', 'Key');
    return;
  }

  const value = valueAt(path);
  if (event.target.closest('.v')) {
    // The bare value, not its JSON spelling — no wrapping quotes to strip off.
    copyText(typeof value === 'string' ? value : String(value), 'Value');
    return;
  }
  copyText(JSON.stringify(value, null, 2), row.classList.contains('is-container') ? 'Node' : 'Value');
});

ui.expand.addEventListener('click', () => {
  expandSubtree([]);
  render();
});

ui.collapse.addEventListener('click', () => {
  state.expanded = new Set(['']);
  render();
});

ui.search.addEventListener('input', () => {
  state.query = ui.search.value;
  runSearch();
  render();
  if (state.screen !== 'saves' && matchCount()) scrollToCurrent();
});

ui.search.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') {
    event.preventDefault();
    gotoMatch(event.shiftKey ? -1 : 1);
  } else if (event.key === 'Escape') {
    ui.search.value = '';
    state.query = '';
    runSearch();
    render();
  }
});

ui.next.addEventListener('click', () => gotoMatch(1));
ui.prev.addEventListener('click', () => gotoMatch(-1));

ui.filter.addEventListener('click', () => {
  state.filter = !state.filter;
  render();
});

ui.pause.addEventListener('click', () => {
  state.paused = !state.paused;
  render();
  toast(state.paused ? 'Live updates paused' : 'Live updates resumed');
  if (!state.paused) send({ type: 'REFRESH', tabId: state.tabId });
});

ui.refresh.addEventListener('click', () => {
  send({ type: 'REFRESH', tabId: state.tabId });
  toast('Refreshing');
});

ui.viewTree.addEventListener('click', () => {
  if (state.view === 'tree') return;
  state.view = 'tree';
  runSearch();
  render();
});

ui.viewRaw.addEventListener('click', () => {
  if (state.view === 'raw') return;
  state.view = 'raw';
  runSearch();
  render();
});

ui.source.addEventListener('change', () => {
  state.sourceId = ui.source.value;
  state.identity = '';
  applyPayload(state.payload);
});

ui.unpin.addEventListener('click', () => {
  state.pick.scriptKey = null;
  state.pick.stepKey = null;
  sendPick();
  toast('Following the page again');
});

ui.scriptPick.addEventListener('change', () => {
  // Switching OmniScript invalidates any step chosen inside the previous one.
  state.pick.scriptKey = ui.scriptPick.value || null;
  state.pick.stepKey = null;
  sendPick();
});

ui.stepPick.addEventListener('change', () => {
  state.pick.stepKey = ui.stepPick.value || null;
  sendPick();
});

function sendPick() {
  send({
    type: 'PICK',
    tabId: state.tabId,
    scriptKey: state.pick.scriptKey,
    stepKey: state.pick.stepKey
  });
}

ui.copy.addEventListener('click', () => copyText(prettyText(), 'Payload'));

ui.changeJump.addEventListener('click', () => revealNewestChange());
ui.changeDismiss.addEventListener('click', () => dismissChanges());

/* ---------------------------------------------------------------- snapshots */

ui.save.addEventListener('click', () => saveSnapshot());

ui.savesBtn.addEventListener('click', () => {
  state.screen = state.screen === 'saves' ? 'data' : 'saves';
  state.armed = null;
  state.renaming = null;
  setQuery(''); // the box means different things on each screen
  ui.body.scrollTop = 0;
  render();
});

ui.backLive.addEventListener('click', () => backToLive());

ui.bannerDiff.addEventListener('click', () => {
  if (state.viewing) openDiff(state.viewing.id, 'live');
});

ui.diffA.addEventListener('change', () => openDiff(ui.diffA.value, state.diff.b));
ui.diffB.addEventListener('change', () => openDiff(state.diff.a, ui.diffB.value));
ui.diffSwap.addEventListener('click', () => openDiff(state.diff.b, state.diff.a));

ui.diffClose.addEventListener('click', () => {
  state.screen = state.viewing ? 'data' : 'saves';
  setQuery('');
  render();
});

// Double-click a difference to copy the path that changed.
ui.diff.addEventListener('dblclick', (event) => {
  const row = event.target.closest('.drow');
  if (row) copyText(row.dataset.path, 'Path');
});

let armTimer = null;
function arm(id) {
  state.armed = id;
  clearTimeout(armTimer);
  armTimer = setTimeout(() => {
    state.armed = null;
    if (state.screen === 'saves') render();
  }, 3000);
  render();
}

ui.saves.addEventListener('click', (event) => {
  const target = event.target.closest('[data-act]');
  if (!target) return;
  const row = target.closest('.save');
  const id = row ? row.dataset.id : null;
  const act = target.dataset.act;

  if (act === 'clear') {
    if (state.armed === 'all') {
      state.armed = null;
      clearSnapshots();
    } else {
      arm('all');
    }
    return;
  }
  if (!id) return;

  if (act === 'open') {
    openSnapshot(id);
  } else if (act === 'compare') {
    openDiff(id, 'live');
  } else if (act === 'rename') {
    state.renaming = id;
    state.armed = null;
    render();
  } else if (act === 'download') {
    downloadSnapshot(id);
  } else if (act === 'delete') {
    if (state.armed === id) {
      state.armed = null;
      deleteSnapshot(id);
    } else {
      arm(id);
    }
  } else if (act === 'url') {
    const meta = state.saves.find((s) => s.id === id);
    if (meta && meta.url) chrome.tabs.create({ url: meta.url });
  }
});

function commitRename(input, keep) {
  if (state.renaming !== input.dataset.id) return;
  const id = input.dataset.id;
  state.renaming = null;
  if (keep) renameSnapshot(id, input.value);
  else render();
}

ui.saves.addEventListener('keydown', (event) => {
  const input = event.target.closest('.save-rename');
  if (!input) return;
  if (event.key === 'Enter') {
    event.preventDefault();
    commitRename(input, true);
  } else if (event.key === 'Escape') {
    event.preventDefault();
    commitRename(input, false);
  }
});

ui.saves.addEventListener(
  'blur',
  (event) => {
    const input = event.target.closest('.save-rename');
    if (input) commitRename(input, true);
  },
  true
);

ui.copyPath.addEventListener('click', () => {
  copyText(state.selected ? pathLabel(state.selected.path) : '$', 'Path');
});

ui.copyValue.addEventListener('click', () => {
  const value = state.selected ? valueAt(state.selected.path) : state.data;
  copyText(typeof value === 'string' ? value : JSON.stringify(value, null, 2), 'Value');
});

ui.inject.addEventListener('click', () => {
  ui.emptyHint.textContent = 'Injecting scanner…';
  send({ type: 'INJECT', tabId: state.tabId });
});

ui.manageSites.addEventListener('click', () => chrome.runtime.openOptionsPage());

ui.grant.addEventListener('click', async () => {
  const origin = ui.grant.dataset.origin;
  if (!origin) return;
  try {
    const granted = await chrome.permissions.request({ origins: [origin] });
    if (granted) {
      ui.emptyHint.textContent = '';
      await updateEmptyActions();
      send({ type: 'INJECT', tabId: state.tabId });
      return;
    }
    ui.emptyHint.textContent = 'Not enabled. You can add it from Manage sites instead.';
  } catch (e) {
    // Chrome won't always anchor its permission prompt to a side panel; the
    // options page is a normal tab, where the request always works.
    ui.emptyHint.textContent = 'Chrome would not show the prompt here — opening Manage sites…';
    chrome.runtime.openOptionsPage();
  }
});

document.addEventListener('keydown', (event) => {
  const meta = event.metaKey || event.ctrlKey;
  if (meta && event.key.toLowerCase() === 'f') {
    event.preventDefault();
    ui.search.focus();
    ui.search.select();
  } else if (meta && event.key.toLowerCase() === 's') {
    event.preventDefault();
    if (!ui.save.disabled) saveSnapshot();
  }
});

/* -------------------------------------------------------------------- boot */

connect();
render();
resolveTab();
refreshSaves().then(render);

// Another panel window (or a second Chrome window) may have changed the list.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !changes[INDEX_KEY]) return;
  state.saves = Array.isArray(changes[INDEX_KEY].newValue) ? changes[INDEX_KEY].newValue : [];
  render();
});
