/*
 * JSON Viewer for OmniStudio — service worker.
 *
 * Caches the latest payload per tab/frame, fans it out to any open side panel,
 * and turns the page-world scanner on only while a panel is actually watching.
 */

/** Host patterns declared in the manifest — already covered by static scripts. */
const STATIC_MATCHES = chrome.runtime.getManifest().host_permissions || [];

/** tabId -> Map(frameId -> payload) */
const cache = new Map();
/** open side-panel ports */
const ports = new Set();

chrome.sidePanel
  .setPanelBehavior({ openPanelOnActionClick: true })
  .catch(() => {});

/* ------------------------------------------------------------------ helpers */

function payloadScore(p) {
  if (!p) return -1;
  if (!p.ok) return 0;
  const bytes = (p.sources || []).reduce((n, s) => n + (s.bytes || 0), 0);
  // A real OmniScript always outranks a page-wide JSON scan, even one from the
  // top frame — the fallback is for when nothing better exists anywhere.
  const real = p.mode === 'other' ? 0 : 1e12;
  return 1 + real + (p.isTop ? 1e9 : 0) + bytes;
}

function bestFor(tabId) {
  const frames = cache.get(tabId);
  if (!frames || !frames.size) return null;
  let best = null;
  for (const p of frames.values()) {
    if (payloadScore(p) > payloadScore(best)) best = p;
  }
  return best;
}

function broadcast(tabId) {
  const payload = bestFor(tabId);
  for (const port of ports) {
    if (port.ojvTabId !== tabId) continue;
    try {
      port.postMessage({ type: 'PAYLOAD', tabId, payload });
    } catch (e) {
      /* port closed */
    }
  }
}

function tell(tabId, message) {
  if (typeof tabId !== 'number' || tabId < 0) return;
  try {
    chrome.tabs.sendMessage(tabId, message).catch(() => {});
  } catch (e) {
    /* no receiver */
  }
}

let watched = new Set();

function syncWatched() {
  const next = new Set();
  for (const port of ports) {
    if (typeof port.ojvTabId === 'number' && port.ojvTabId >= 0) next.add(port.ojvTabId);
  }
  for (const tabId of watched) {
    if (!next.has(tabId)) tell(tabId, { type: 'OJV_CMD', cmd: 'active', value: false });
  }
  for (const tabId of next) {
    if (!watched.has(tabId)) tell(tabId, { type: 'OJV_CMD', cmd: 'active', value: true });
  }
  watched = next;
}

/* ---------------------------------------------------------- content updates */

chrome.runtime.onMessage.addListener((msg, sender) => {
  if (!msg || msg.type !== 'OJV_UPDATE' || !sender.tab) return;
  const tabId = sender.tab.id;
  const frameId = typeof sender.frameId === 'number' ? sender.frameId : 0;
  const payload = msg.payload || null;

  // Self-heal: a navigation swaps in a fresh, idle page script while this tab is
  // still being watched. Whenever the two disagree, re-issue the command.
  const shouldWatch = watched.has(tabId);
  if (payload && !!payload.active !== shouldWatch) {
    tell(tabId, { type: 'OJV_CMD', cmd: 'active', value: shouldWatch });
  }

  if (payload && payload.reason === 'ping') return;

  let frames = cache.get(tabId);
  if (!frames) {
    frames = new Map();
    cache.set(tabId, frames);
  }
  frames.set(frameId, payload);
  broadcast(tabId);
});

chrome.tabs.onRemoved.addListener((tabId) => {
  cache.delete(tabId);
});

chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (info.status === 'loading') {
    // Stale payload for a page that is going away. The fresh page script
    // re-activates itself through the self-heal path in onMessage.
    cache.delete(tabId);
    broadcast(tabId);
  }
});

/* ----------------------------------------------------------- panel channel */

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'ojv-panel') return;
  port.ojvTabId = null;
  ports.add(port);

  port.onMessage.addListener(async (msg) => {
    if (!msg) return;

    if (msg.type === 'WATCH') {
      port.ojvTabId = msg.tabId;
      syncWatched();
      port.postMessage({ type: 'PAYLOAD', tabId: msg.tabId, payload: bestFor(msg.tabId) });
      tell(msg.tabId, { type: 'OJV_CMD', cmd: 'refresh' });
      return;
    }

    if (msg.type === 'REFRESH') {
      tell(msg.tabId, { type: 'OJV_CMD', cmd: 'refresh' });
      return;
    }

    if (msg.type === 'PICK') {
      tell(msg.tabId, {
        type: 'OJV_CMD',
        cmd: 'pick',
        scriptKey: msg.scriptKey,
        stepKey: msg.stepKey
      });
      return;
    }

    if (msg.type === 'INJECT') {
      const result = await injectInto(msg.tabId);
      port.postMessage({ type: 'INJECTED', tabId: msg.tabId, ...result });
      if (result.ok) {
        tell(msg.tabId, { type: 'OJV_CMD', cmd: 'active', value: true });
        tell(msg.tabId, { type: 'OJV_CMD', cmd: 'refresh' });
      }
      return;
    }
  });

  port.onDisconnect.addListener(() => {
    ports.delete(port);
    syncWatched();
  });
});

/* ------------------------------------------------- on-demand injection path */

async function injectInto(tabId) {
  if (typeof tabId !== 'number') return { ok: false, error: 'No tab' };
  try {
    await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      files: ['content-bridge.js'],
      world: 'ISOLATED'
    });
    await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      files: ['content-main.js'],
      world: 'MAIN'
    });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
}

/* ------------------------- persist scanning on user-granted custom domains */

async function syncDynamicScripts() {
  let granted;
  try {
    granted = await chrome.permissions.getAll();
  } catch (e) {
    return;
  }
  const extra = (granted.origins || []).filter((o) => !STATIC_MATCHES.includes(o));

  // Ask for everything and filter, rather than filtering by id — Chrome can
  // throw when an id in the filter isn't registered.
  let existing = [];
  try {
    const all = await chrome.scripting.getRegisteredContentScripts();
    existing = all.filter((s) => s.id === 'ojv-extra-main' || s.id === 'ojv-extra-bridge');
  } catch (e) {
    existing = [];
  }

  if (!extra.length) {
    if (existing.length) {
      await chrome.scripting
        .unregisterContentScripts({ ids: existing.map((s) => s.id) })
        .catch(() => {});
    }
    return;
  }

  const scripts = [
    {
      id: 'ojv-extra-main',
      matches: extra,
      js: ['content-main.js'],
      world: 'MAIN',
      runAt: 'document_idle',
      allFrames: true
    },
    {
      id: 'ojv-extra-bridge',
      matches: extra,
      js: ['content-bridge.js'],
      world: 'ISOLATED',
      runAt: 'document_idle',
      allFrames: true
    }
  ];

  try {
    if (existing.length) {
      await chrome.scripting.updateContentScripts(scripts);
    } else {
      await chrome.scripting.registerContentScripts(scripts);
    }
  } catch (e) {
    /* best effort */
  }
}

chrome.permissions.onAdded.addListener(syncDynamicScripts);
chrome.permissions.onRemoved.addListener(syncDynamicScripts);
chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
  syncDynamicScripts();
});
chrome.runtime.onStartup.addListener(syncDynamicScripts);
