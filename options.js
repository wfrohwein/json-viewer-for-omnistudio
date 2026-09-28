/* JSON Viewer for OmniStudio — Sites manager.
 *
 * Runs in a normal extension tab, where chrome.permissions.request() always has
 * a window to anchor its prompt to. The side panel delegates here when its own
 * inline request can't complete.
 */

'use strict';

const $ = (sel) => document.querySelector(sel);

const ui = {
  addForm: $('#addForm'),
  addInput: $('#addInput'),
  addNote: $('#addNote'),
  tabs: $('#tabs'),
  granted: $('#granted'),
  builtin: $('#builtin'),
  toast: $('#toast')
};

/** Host patterns baked into the manifest — always on, never removable. */
const BUILT_IN = chrome.runtime.getManifest().host_permissions || [];

let armed = null;
let armTimer = null;

/* ----------------------------------------------------------------- helpers */

let toastTimer = null;
function toast(message) {
  ui.toast.textContent = message;
  ui.toast.classList.add('is-on');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => ui.toast.classList.remove('is-on'), 1600);
}

function note(message, kind) {
  ui.addNote.textContent = message;
  ui.addNote.className = `note${kind ? ` is-${kind}` : ''}`;
}

/**
 * Turn whatever the user pasted into a match pattern.
 * A full URL keeps only its origin; a bare or wildcard host gets https + /*.
 * Returns null when there's nothing usable.
 */
function toPattern(input) {
  const text = String(input || '').trim();
  if (!text) return null;

  // Already a match pattern.
  if (/^\*?:?\/\//.test(text) || /^https?:\/\/[^\s]+\/\*$/.test(text)) {
    if (/\/\*$/.test(text)) return text;
  }

  if (/^https?:\/\//i.test(text)) {
    try {
      const url = new URL(text);
      return `${url.protocol}//${url.host}/*`;
    } catch (e) {
      return null;
    }
  }

  // A bare host, possibly wildcarded: acme.my.site.com or *.example.com
  const host = text.replace(/^\/+/, '').split('/')[0];
  if (!/^(\*\.)?[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(host)) return null;
  return `https://${host}/*`;
}

function hostOf(pattern) {
  return String(pattern)
    .replace(/^\*:\/\//, '')
    .replace(/^https?:\/\//, '')
    .replace(/\/\*$/, '');
}

async function grantedOrigins() {
  let all;
  try {
    all = await chrome.permissions.getAll();
  } catch (e) {
    return [];
  }
  return (all.origins || []).filter((origin) => !BUILT_IN.includes(origin));
}

function coveredBy(patterns, origin) {
  // Cheap match-pattern test, good enough for "is this already allowed".
  return patterns.some((pattern) => {
    const host = hostOf(pattern);
    const target = hostOf(origin);
    if (host === target) return true;
    if (host.startsWith('*.')) {
      const base = host.slice(2);
      return target === base || target.endsWith(`.${base}`);
    }
    return false;
  });
}

/* ------------------------------------------------------------------ actions */

async function addPattern(pattern) {
  try {
    const granted = await chrome.permissions.request({ origins: [pattern] });
    if (granted) {
      toast(`${hostOf(pattern)} added`);
      note('', null);
      ui.addInput.value = '';
      await refresh();
      return true;
    }
    note('Chrome declined that request — nothing was added.', 'bad');
  } catch (e) {
    note(String((e && e.message) || e), 'bad');
  }
  return false;
}

async function removePattern(pattern) {
  try {
    await chrome.permissions.remove({ origins: [pattern] });
    toast(`${hostOf(pattern)} removed`);
  } catch (e) {
    toast('Could not remove that site');
  }
  await refresh();
}

function armRemoval(pattern) {
  armed = pattern;
  clearTimeout(armTimer);
  armTimer = setTimeout(() => {
    armed = null;
    refresh();
  }, 3000);
  refresh();
}

/* ---------------------------------------------------------------- rendering */

function siteRow(pattern, { sub, action } = {}) {
  const row = document.createElement('div');
  row.className = 'site';

  const name = document.createElement('div');
  name.className = 'site-name';
  name.textContent = hostOf(pattern);
  if (sub) {
    const small = document.createElement('span');
    small.className = 'site-sub';
    small.textContent = sub;
    name.appendChild(small);
  }
  row.appendChild(name);

  if (action) row.appendChild(action);
  return row;
}

function emptyNote(text) {
  const el = document.createElement('div');
  el.className = 'none';
  el.textContent = text;
  return el;
}

async function refresh() {
  const granted = await grantedOrigins();
  const allowed = BUILT_IN.concat(granted);

  // Built in
  ui.builtin.replaceChildren(...BUILT_IN.map((pattern) => siteRow(pattern)));

  // Added by you
  if (!granted.length) {
    ui.granted.replaceChildren(emptyNote('Nothing added yet.'));
  } else {
    ui.granted.replaceChildren(
      ...granted.map((pattern) => {
        const button = document.createElement('button');
        const isArmed = armed === pattern;
        button.className = isArmed ? 'remove armed' : 'remove';
        button.textContent = isArmed ? 'Remove?' : 'Remove';
        button.addEventListener('click', () =>
          isArmed ? removePattern(pattern) : armRemoval(pattern)
        );
        return siteRow(pattern, { action: button });
      })
    );
  }

  // Open tabs that aren't reachable yet
  let tabs = [];
  try {
    tabs = await chrome.tabs.query({});
  } catch (e) {
    tabs = [];
  }

  const seen = new Set();
  const candidates = [];
  for (const tab of tabs) {
    if (!tab.url || !/^https?:\/\//i.test(tab.url)) continue;
    let origin;
    let pattern;
    try {
      const url = new URL(tab.url);
      origin = url.host;
      pattern = `${url.protocol}//${url.host}/*`;
    } catch (e) {
      continue;
    }
    if (seen.has(pattern) || coveredBy(allowed, pattern)) continue;
    seen.add(pattern);
    candidates.push({ pattern, origin, title: tab.title || '' });
  }

  if (!candidates.length) {
    ui.tabs.replaceChildren(
      emptyNote('Every site you have open is already reachable (or is not a web page).')
    );
  } else {
    ui.tabs.replaceChildren(
      ...candidates.map(({ pattern, title }) => {
        const button = document.createElement('button');
        button.className = 'cta small';
        button.textContent = 'Add';
        button.addEventListener('click', () => addPattern(pattern));
        return siteRow(pattern, { sub: title, action: button });
      })
    );
  }
}

/* ------------------------------------------------------------------ events */

ui.addForm.addEventListener('submit', (event) => {
  event.preventDefault();
  const pattern = toPattern(ui.addInput.value);
  if (!pattern) {
    note("That doesn't look like a site address. Try pasting a full URL.", 'bad');
    return;
  }
  addPattern(pattern);
});

chrome.permissions.onAdded.addListener(refresh);
chrome.permissions.onRemoved.addListener(refresh);

refresh();

// Exposed for tests.
if (typeof window !== 'undefined') window.__ojvOptions = { toPattern, hostOf, coveredBy, refresh };
