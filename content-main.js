/*
 * JSON Viewer for OmniStudio — page-world script.
 *
 * Runs in the MAIN world so it can read LWC element properties (`el.jsonData`),
 * which an isolated content script cannot see. This is the scripted equivalent of
 * "Store as global variable" -> JSON.stringify(temp1.jsonData) in DevTools.
 *
 * Talks to content-bridge.js via window.postMessage.
 */
(function () {
  'use strict';

  if (window.__OJV_MAIN_INSTALLED__) return;
  window.__OJV_MAIN_INSTALLED__ = true;

  var TAG_FROM_PAGE = 'ojv-page';
  var TAG_TO_PAGE = 'ojv-bridge';

  // Known OmniScript step tag names across namespaces (runtime, managed pkg, custom).
  var STEP_SELECTOR = [
    'runtime_omnistudio_omniscript-omniscript-step',
    'omnistudio-omniscript-step',
    'vlocity_cmt-omniscript-step',
    'vlocity_ins-omniscript-step',
    'c-omniscript-step'
  ].join(',');

  var ACTIVE_POLL_MS = 750;
  var IDLE_POLL_MS = 5000;
  var MAX_PAYLOAD_BYTES = 12 * 1024 * 1024;
  var MAX_DEEP_SCAN_NODES = 80000;

  // Fallback scan: when no OmniScript step can be read, look for JSON parked
  // anywhere else on the page. Bounded on every axis — this runs on pages the
  // extension knows nothing about.
  var OTHER_SCAN_MS = 2000; // don't re-walk the page on every poll
  var MAX_OTHER_CANDIDATES = 40; // stop walking once this many are found
  var MAX_OTHER_SOURCES = 12; // …and offer at most this many, biggest first
  var MAX_OTHER_TEXT = 4 * 1024 * 1024; // skip an oversized script tag / attribute outright
  var MAX_OWN_KEYS = 40; // per element, when sniffing its own properties
  var MAX_SCAN_BYTES = 24 * 1024 * 1024; // stop serializing a page that never ends

  // Properties that components conventionally park their data on. Checked in
  // this order, so the most OmniScript-like names sort first among equals.
  var OTHER_PROPS = [
    'jsonData',
    'jsonDef',
    'omniScriptDef',
    'scriptHeaderDef',
    'data',
    'value',
    'record',
    'recordData',
    'records',
    'items',
    'rows',
    'options',
    'config',
    'payload',
    'result',
    'response',
    'formData',
    'schema',
    'definition'
  ];

  var active = false; // true while the side panel is watching this tab
  var timer = null;
  var mutationTimer = null;
  var observer = null;
  var lastFingerprint = '';

  // User overrides. Held as *keys*, not indices, so that a selection which no
  // longer exists on the page silently falls back to auto-detection instead of
  // pointing at whatever happens to sit at that position now.
  var pinnedScriptKey = null;
  var pinnedStepKey = null;

  /* ------------------------------------------------------------------ utils */

  function safeGet(obj, prop) {
    try {
      return obj[prop];
    } catch (e) {
      return undefined;
    }
  }

  // Stringify that survives circular refs, DOM nodes and functions.
  // Uses an ancestor stack (not a "seen" set) so repeated-but-not-circular
  // references are still serialized in full.
  function stringify(value) {
    var ancestors = [];
    return JSON.stringify(value, function (key, val) {
      if (typeof val === 'function') return '[Function]';
      if (typeof val === 'bigint') return val.toString();
      if (typeof val === 'symbol') return val.toString();
      if (val === null || typeof val !== 'object') return val;
      if (val === window) return '[Window]';
      if (typeof val.nodeType === 'number' && typeof val.nodeName === 'string') {
        return '[DOM ' + val.nodeName.toLowerCase() + ']';
      }
      while (ancestors.length > 0 && ancestors[ancestors.length - 1] !== this) ancestors.pop();
      if (ancestors.indexOf(val) !== -1) return '[Circular]';
      ancestors.push(val);
      return val;
    });
  }

  function fingerprintOf(str) {
    var h = 2166136261;
    for (var i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
    }
    return h.toString(36) + '.' + str.length;
  }

  // parentElement, but hops out of shadow roots too.
  function parentOf(el) {
    if (el.parentElement) return el.parentElement;
    var root = el.getRootNode ? el.getRootNode() : null;
    return (root && root.host) || null;
  }

  // Every element in the document, descending into open shadow roots. `visit`
  // may return true to stop the walk early.
  function deepWalk(visit) {
    var roots = [document];
    var visited = 0;
    while (roots.length && visited < MAX_DEEP_SCAN_NODES) {
      var root = roots.shift();
      var els;
      try {
        els = root.querySelectorAll('*');
      } catch (e) {
        continue;
      }
      for (var i = 0; i < els.length; i++) {
        visited++;
        var el = els[i];
        if (visit(el) === true) return;
        if (el.shadowRoot) roots.push(el.shadowRoot);
      }
    }
  }

  function deepQueryAll(matchFn) {
    var out = [];
    deepWalk(function (el) {
      if (matchFn(el)) out.push(el);
    });
    return out;
  }

  /* -------------------------------------------------------- element scanning */

  function findSteps() {
    var direct = document.querySelectorAll(STEP_SELECTOR);
    if (direct.length) return Array.prototype.slice.call(direct);
    // Unknown namespace and/or native shadow DOM: fall back to a deep walk.
    return deepQueryAll(function (el) {
      return el.tagName.indexOf('-') > 0 && /-OMNISCRIPT-STEP$/.test(el.tagName);
    });
  }

  function isVisible(el) {
    if (!el.isConnected) return false;
    if (el.classList && el.classList.contains('slds-hide')) return false;
    // checkVisibility handles display:none / visibility / content-visibility on
    // the element *and* its ancestors. A bounding rect is not reliable here:
    // these custom elements are display:inline unless a flex/grid parent
    // blockifies them, and an inline box wrapping block children can measure 0.
    if (typeof el.checkVisibility === 'function') {
      try {
        return el.checkVisibility({ checkVisibilityCSS: true });
      } catch (e) {
        /* fall through to the rect check */
      }
    }
    var r = el.getBoundingClientRect();
    return r.width > 0 || r.height > 0;
  }

  // LWC here uses synthetic shadow (light DOM), but native shadow roots show up
  // in some orgs — look in both.
  function contentRoot(el) {
    return el.shadowRoot || el;
  }

  function weightOf(el) {
    var n = el.getElementsByTagName('*').length;
    if (n === 0 && el.shadowRoot) n = el.shadowRoot.querySelectorAll('*').length;
    return n;
  }

  function labelOf(el) {
    var node = contentRoot(el).querySelector(
      '.custom-step-label, .os-step-label, .slds-page-header__title, h1, h2'
    );
    var text = node && node.textContent ? node.textContent.trim().replace(/\s+/g, ' ') : '';
    if (text) return text.slice(0, 200);
    return el.getAttribute('data-omni-key') || el.tagName.toLowerCase();
  }

  function domIndexOf(el) {
    var parent = el.parentElement;
    if (!parent) return -1;
    return Array.prototype.indexOf.call(parent.children, el);
  }

  function describeStep(el, index) {
    // A step that is hidden by a class on an inner wrapper still reports itself
    // as visible, but collapses to zero height — so measure as well as ask.
    var rect = el.getBoundingClientRect();
    return {
      index: index,
      key: el.getAttribute('data-omni-key') || '',
      label: labelOf(el),
      visible: isVisible(el),
      laidOut: rect.height > 0,
      domIndex: domIndexOf(el),
      weight: weightOf(el)
    };
  }

  /* -------------------------------------------------- grouping by OmniScript */

  // The element that bounds one OmniScript instance. Nested OmniScripts group
  // under their own (nearer) container, which is what we want.
  function containerOf(el) {
    var node = parentOf(el);
    var withData = null;
    while (node) {
      var tag = node.tagName || '';
      if (/-OMNISCRIPT-CONTAINER$/.test(tag)) return node;
      if (!withData && safeGet(node, 'jsonData') !== undefined) withData = node;
      node = parentOf(node);
    }
    return withData;
  }

  // "-a-c-m-e" -> "ACME", "-membership-application" -> "MembershipApplication"
  function deKebab(str) {
    return str
      .replace(/^-+/, '')
      .replace(/-+([a-z0-9])/g, function (m, c) {
        return c.toUpperCase();
      })
      .replace(/^[a-z]/, function (c) {
        return c.toUpperCase();
      });
  }

  // forcegenerated-omni-script_-a-c-m-e___-membership-application___-english___...
  //   -> "ACME / MembershipApplication · English"
  function parseGeneratedTag(tag) {
    var parts = tag.replace(/^forcegenerated-/, '').split('___');
    if (parts.length < 2) return '';
    var type = deKebab(parts[0].replace(/^omni-?script_?/, ''));
    var subType = deKebab(parts[1]);
    var lang = parts.length > 2 ? deKebab(parts[2]) : '';
    if (!type && !subType) return '';
    var name = [type, subType].filter(Boolean).join(' / ');
    return lang ? name + ' · ' + lang : name;
  }

  function scriptLabel(container) {
    if (!container) return '';

    // Best case: the component tells us what it is.
    var defs = ['scriptHeaderDef', 'jsonDef', 'omniScriptDef'];
    for (var i = 0; i < defs.length; i++) {
      var def = safeGet(container, defs[i]);
      if (def && typeof def === 'object') {
        var type = def.bpType || def.type;
        var sub = def.bpSubType || def.subType;
        var lang = def.bpLang || def.language;
        if (type || sub) {
          var name = [type, sub].filter(Boolean).join(' / ');
          return lang ? name + ' · ' + lang : name;
        }
      }
    }

    // Otherwise decode the generated LWC tag name.
    var node = container;
    while (node) {
      var tag = (node.tagName || '').toLowerCase();
      if (tag.indexOf('forcegenerated-') === 0) {
        var parsed = parseGeneratedTag(tag);
        if (parsed) return parsed;
      }
      node = parentOf(node);
    }
    return '';
  }

  function groupSteps(stepEls) {
    var groups = [];
    var containers = [];

    for (var i = 0; i < stepEls.length; i++) {
      var el = stepEls[i];
      var container = containerOf(el);
      // indexOf compares by identity, so steps under the same container land in
      // the same group — and steps with no container (null) share one bucket.
      var at = containers.indexOf(container);
      if (at === -1) {
        containers.push(container);
        groups.push({ container: container, els: [] });
        at = groups.length - 1;
      }
      groups[at].els.push(el);
    }

    for (var g = 0; g < groups.length; g++) {
      var group = groups[g];
      group.label = scriptLabel(group.container);
      group.descs = group.els.map(describeStep);
      var active = pickActiveStep(group.descs, group.container);
      group.activeIndex = active.index;
      group.signal = active.signal;
      group.weight = group.activeIndex === -1 ? 0 : group.descs[group.activeIndex].weight;
      // Identity that survives re-renders but changes when the page really does.
      group.key = [group.label || 'omniscript', group.descs[0].key || g, group.els.length].join('|');
    }
    return groups;
  }

  // The OmniScript's own step chart is the authoritative answer to "which step
  // am I on" — it marks the current item with .slds-is-active. Its data-index is
  // the step element's position among its siblings, which pins it exactly.
  function chartActive(container) {
    if (!container) return null;
    var root = contentRoot(container);
    var chart = root.querySelector(
      'runtime_omnistudio_omniscript-omniscript-step-chart,' +
        'omnistudio-omniscript-step-chart,' +
        '[data-omni-key="omniscriptStepChart"]'
    );
    var scope = chart ? contentRoot(chart) : root;
    var item = scope.querySelector(
      '.slds-progress__item.slds-is-active, .slds-progress__item[aria-current]'
    );
    if (!item) return null;

    var raw = item.getAttribute('data-index');
    var index = raw === null ? NaN : parseInt(raw, 10);
    var content = item.querySelector('.slds-progress__item_content, .omni-stepchart-content');
    var label = ((content && content.textContent) || '').replace(/\s+/g, ' ').trim();
    return { domIndex: isNaN(index) ? -1 : index, label: label };
  }

  function bestByWeight(descs, requireLayout) {
    var best = -1;
    for (var i = 0; i < descs.length; i++) {
      var d = descs[i];
      if (!d.visible || d.weight === 0) continue;
      if (requireLayout && !d.laidOut) continue;
      if (best === -1 || d.weight > descs[best].weight) best = i;
    }
    return best;
  }

  // Ordered strongest signal first. Weight alone is a poor last resort: once a
  // step has been visited its markup can linger, so "biggest" stops meaning
  // "current" and the view sticks on whichever step happens to be fattest.
  function pickActiveStep(descs, container) {
    var chart = chartActive(container);

    if (chart) {
      var i;
      if (chart.domIndex >= 0) {
        for (i = 0; i < descs.length; i++) {
          if (descs[i].domIndex === chart.domIndex) return { index: i, signal: 'chart' };
        }
      }
      if (chart.label) {
        var wanted = chart.label.toLowerCase();
        var matches = [];
        for (i = 0; i < descs.length; i++) {
          if ((descs[i].label || '').toLowerCase() === wanted) matches.push(i);
        }
        if (matches.length === 1) return { index: matches[0], signal: 'chart-label' };
        for (i = 0; i < matches.length; i++) {
          if (descs[matches[i]].laidOut && descs[matches[i]].weight) {
            return { index: matches[i], signal: 'chart-label' };
          }
        }
      }
    }

    var laidOut = bestByWeight(descs, true);
    if (laidOut !== -1) return { index: laidOut, signal: 'layout' };

    var any = bestByWeight(descs, false);
    if (any !== -1) return { index: any, signal: 'content' };

    return { index: -1, signal: 'none' };
  }

  function pickActiveScript(groups) {
    var best = -1;
    for (var i = 0; i < groups.length; i++) {
      if (groups[i].activeIndex === -1) continue;
      if (best === -1 || groups[i].weight > groups[best].weight) best = i;
    }
    return best;
  }

  function findByKey(list, key, prop) {
    if (!key) return -1;
    for (var i = 0; i < list.length; i++) {
      if (list[i][prop] === key) return i;
    }
    return -1;
  }

  /* ------------------------------------------------------------- collecting */

  function makeSource(id, label, el, prop) {
    if (!el) return null;
    var raw = safeGet(el, prop);
    if (raw === undefined || raw === null) return null;
    var json;
    try {
      json = stringify(raw);
    } catch (e) {
      return { id: id, label: label, error: String((e && e.message) || e) };
    }
    if (json === undefined) return null;
    return {
      id: id,
      label: label,
      json: json,
      bytes: json.length,
      origin: el.tagName.toLowerCase() + '.' + prop
    };
  }

  /* --------------------------------------------------------------- FlexCards
   *
   * Offered alongside whatever else the panel is showing — an OmniScript step,
   * or the other-JSON fallback. Each card's `records` is its data-source
   * result, with the card's per-record UI state under `_flex`.
   */

  var FLEXCARD_TAG = /^FORCEGENERATED-FLEX-CARD_/;
  var FLEXCARD_PREFIX = /^forcegenerated-flex-card_/;
  // What the generic sweep finds on a card: the card itself, and each state's
  // `record` — one of the records the card already lists.
  var FLEXCARD_ORIGIN = /^forcegenerated-flex-card_|flexcards?-flex-card-state\./;

  // forcegenerated-flex-card_-a-c-m-e_-account-actions___salesforce___1___false_gen
  //   -> "ACME_AccountActions"
  function flexCardName(tag) {
    var parts = tag.toLowerCase().replace(FLEXCARD_PREFIX, '').split('___');
    return deKebab(parts[0]);
  }

  var lastCardScan = { at: 0, els: [] };

  // Finding the cards means a deep walk, so the element list is reused for a
  // moment like the other-JSON scan. Their data is still read on every poll.
  function findFlexCards(force) {
    var now = Date.now();
    var fresh = lastCardScan.els.every(function (el) {
      return el.isConnected;
    });
    if (force || !fresh || now - lastCardScan.at >= OTHER_SCAN_MS) {
      lastCardScan = {
        at: now,
        els: deepQueryAll(function (el) {
          return FLEXCARD_TAG.test(el.tagName);
        })
      };
    }
    return lastCardScan.els;
  }

  function flexCardSources(force) {
    var els = findFlexCards(force);
    var visible = [];
    var hidden = [];
    var ordinals = Object.create(null);
    for (var i = 0; i < els.length; i++) {
      var el = els[i];
      var name = flexCardName(el.tagName) || el.tagName.toLowerCase();
      ordinals[name] = (ordinals[name] || 0) + 1;
      var n = ordinals[name];
      var source = makeSource(
        'flexcard:' + name + '#' + n,
        'FlexCard · ' + name + (n > 1 ? ' (' + n + ')' : '') + ' · records',
        el,
        'records'
      );
      if (source) (isVisible(el) ? visible : hidden).push(source);
    }
    // A card on a collapsed tab is still worth offering, just not first.
    return visible.concat(hidden);
  }

  /* ------------------------------------------------- other JSON on the page
   *
   * The fallback for pages with no readable OmniScript: anything else that is
   * holding a JSON object or array — a component property, a
   * <script type="application/json">, or JSON stuffed into a data-* attribute.
   */

  // A value worth offering: a plain object or array with something in it.
  // Dates, Maps, DOM nodes, class instances and the like are not what anyone
  // means by "the JSON on this page", so they're filtered out here rather than
  // serialized into noise.
  function candidateJson(value) {
    if (value === null || typeof value !== 'object') return null;
    if (typeof value.nodeType === 'number') return null;
    var kind = Object.prototype.toString.call(value);
    if (kind !== '[object Object]' && kind !== '[object Array]') return null;
    var json;
    try {
      json = stringify(value);
    } catch (e) {
      return null;
    }
    // '{}', '[]', or a value that serialized away entirely.
    if (!json || json.length <= 2) return null;
    return json;
  }

  // Enough to recognise the element in a dropdown: <c-my-form#billing>.
  function describeEl(el) {
    var tag = el.tagName.toLowerCase();
    var key = el.getAttribute('data-omni-key');
    if (key) return tag + '[' + key + ']';
    if (el.id) return tag + '#' + el.id;
    if (el.classList && el.classList.length) return tag + '.' + el.classList[0];
    return tag;
  }

  function scanOtherJson() {
    var found = [];
    var seenValues = []; // same object reached from two elements — offer it once
    var seenPrints = Object.create(null); // …and the same content, however reached
    var ordinals = Object.create(null);
    var serialized = 0; // total bytes produced by this scan

    function done() {
      return found.length >= MAX_OTHER_CANDIDATES || serialized >= MAX_SCAN_BYTES;
    }

    function add(el, prop, value) {
      if (done()) return;
      if (value === undefined || value === null) return;
      if (seenValues.indexOf(value) !== -1) return;
      var json = candidateJson(value);
      if (!json) return;
      serialized += json.length;
      var print = fingerprintOf(json);
      if (seenPrints[print]) return;

      seenValues.push(value);
      seenPrints[print] = true;

      // Position among identical tag+property pairs, in DOM order, so the id
      // survives a re-render and the panel keeps showing what you selected.
      var base = el.tagName.toLowerCase() + '.' + prop;
      ordinals[base] = (ordinals[base] || 0) + 1;

      found.push({
        id: 'other:' + base + '#' + ordinals[base],
        label: describeEl(el) + ' · ' + prop,
        json: json,
        bytes: json.length,
        origin: base
      });
    }

    function addText(el, prop, text) {
      if (!text || text.length > MAX_OTHER_TEXT) return;
      var parsed;
      try {
        parsed = JSON.parse(text);
      } catch (e) {
        return;
      }
      add(el, prop, parsed);
    }

    deepWalk(function (el) {
      if (done()) return true;

      if (el.tagName === 'SCRIPT') {
        var type = (el.getAttribute('type') || '').toLowerCase();
        // application/json, application/ld+json, text/json, …
        if (type.indexOf('json') !== -1) addText(el, type, el.textContent || '');
        return;
      }

      // Only custom elements get their properties read: a framework's data
      // lives there, and it keeps us from poking at every <div> on the page.
      if (el.tagName.indexOf('-') > 0) {
        var i;
        for (i = 0; i < OTHER_PROPS.length; i++) {
          add(el, OTHER_PROPS[i], safeGet(el, OTHER_PROPS[i]));
        }
        // Own data properties too — components park state under names we can't
        // guess. Inherited accessors are left alone; reading every getter on
        // an element's prototype chain is neither cheap nor side-effect free.
        var keys;
        try {
          keys = Object.keys(el);
        } catch (e) {
          keys = [];
        }
        for (i = 0; i < keys.length && i < MAX_OWN_KEYS; i++) {
          var key = keys[i];
          if (key.charAt(0) === '_' || key.charAt(0) === '$') continue; // framework internals
          if (OTHER_PROPS.indexOf(key) !== -1) continue;
          add(el, key, safeGet(el, key));
        }
      }

      var attrs = el.attributes;
      for (var a = 0; a < attrs.length; a++) {
        var attr = attrs[a];
        if (attr.name.indexOf('data-') !== 0) continue;
        var raw = (attr.value || '').trim();
        if (raw.charAt(0) !== '{' && raw.charAt(0) !== '[') continue;
        addText(el, attr.name, raw);
      }
    });

    // Biggest first: the panel opens the first source, and the substantial
    // payload is nearly always the one worth looking at.
    found.sort(function (a, b) {
      return b.bytes - a.bytes;
    });
    return {
      sources: found.slice(0, MAX_OTHER_SOURCES),
      total: found.length,
      capped: done() // the walk stopped before the end of the page
    };
  }

  var lastOtherScan = { at: 0, result: null };

  // Walking the whole page and serializing what it finds is far too much work to
  // repeat on every poll, so a scan is reused for a moment. A refresh (or a
  // manual pick) always rescans.
  function otherSources(force) {
    var now = Date.now();
    if (!force && lastOtherScan.result && now - lastOtherScan.at < OTHER_SCAN_MS) {
      return lastOtherScan.result;
    }
    var result;
    try {
      result = scanOtherJson();
    } catch (e) {
      result = { sources: [], total: 0, capped: false };
    }
    lastOtherScan = { at: now, result: result };
    return result;
  }

  /**
   * Turn a failed OmniScript read into whatever else the page is holding.
   * Returns the original failure untouched when there is nothing to offer,
   * with `scanned` set so the panel can say so.
   */
  function fallback(failure, force) {
    var cards = flexCardSources(force);
    var scan = otherSources(force);
    // The generic sweep reaches the cards too; they're already offered, by name.
    var others = scan.sources.filter(function (s) {
      return !FLEXCARD_ORIGIN.test(s.origin);
    });
    if (!cards.length && !others.length) {
      failure.scanned = true;
      return failure;
    }
    var trimmed = trim(cards.concat(others));
    return {
      ok: true,
      mode: 'other',
      reason: failure.reason, // why the OmniScript path didn't produce anything
      href: location.href,
      isTop: window.top === window,
      detected: failure.detected || 0,
      scripts: failure.scripts || [],
      found: cards.length + scan.total - (scan.sources.length - others.length),
      flexcards: cards.length,
      capped: scan.capped,
      sources: trimmed.sources,
      truncated: trimmed.truncated,
      ts: Date.now()
    };
  }

  /* ------------------------------------------------------------- collecting */

  // Keep the message inside what the extension channel can carry. An
  // individual source that is too big is reported rather than shipped.
  function trim(sources) {
    var kept = [];
    var total = 0;
    var truncated = false;
    for (var i = 0; i < sources.length; i++) {
      var s = sources[i];
      var size = s.bytes || 0;
      if (size > MAX_PAYLOAD_BYTES) {
        kept.push({
          id: s.id,
          label: s.label,
          error: 'Payload is too large to display (' + size + ' bytes)'
        });
        truncated = true;
      } else if (total + size > MAX_PAYLOAD_BYTES) {
        truncated = true;
      } else {
        total += size;
        kept.push(s);
      }
    }
    return { sources: kept, truncated: truncated };
  }

  function collect(force) {
    var stepEls = findSteps();
    if (!stepEls.length) {
      return fallback({ ok: false, reason: 'no-omniscript', href: location.href }, force);
    }

    var groups = groupSteps(stepEls);
    var scripts = groups.map(function (group, i) {
      return {
        index: i,
        key: group.key,
        label: group.label || 'OmniScript ' + (i + 1),
        steps: group.els.length,
        rendered: group.activeIndex !== -1
      };
    });

    // --- which OmniScript
    var scriptIndex = findByKey(groups, pinnedScriptKey, 'key');
    var scriptPinned = scriptIndex !== -1;
    if (!scriptPinned) scriptIndex = pickActiveScript(groups);
    if (scriptIndex === -1) {
      return fallback(
        {
          ok: false,
          reason: 'no-active-step',
          href: location.href,
          detected: stepEls.length,
          scripts: scripts
        },
        force
      );
    }
    var group = groups[scriptIndex];

    // --- which step inside it
    var stepIndex = findByKey(group.descs, pinnedStepKey, 'key');
    var stepPinned = stepIndex !== -1;
    if (!stepPinned) stepIndex = group.activeIndex === -1 ? 0 : group.activeIndex;

    var stepEl = group.els[stepIndex];
    var sources = [];

    var stepSource = makeSource('step', 'Active step · jsonData', stepEl, 'jsonData');
    if (stepSource) sources.push(stepSource);

    var rootSource = makeSource(
      'script',
      'Whole OmniScript · jsonData',
      group.container,
      'jsonData'
    );
    // Usually the same object reference — only offer it when it adds something.
    if (rootSource && (!stepSource || rootSource.json !== stepSource.json)) {
      sources.push(rootSource);
    }

    if (!sources.length) {
      return fallback(
        {
          ok: false,
          reason: 'no-jsondata',
          href: location.href,
          detected: stepEls.length,
          scripts: scripts,
          script: scripts[scriptIndex],
          steps: group.descs,
          step: group.descs[stepIndex]
        },
        force
      );
    }

    // FlexCards sharing the page with the OmniScript are offered after it.
    sources = sources.concat(flexCardSources(force));
    var trimmed = trim(sources);

    return {
      ok: true,
      mode: 'omniscript',
      href: location.href,
      isTop: window.top === window,
      detected: stepEls.length,
      scripts: scripts,
      script: scripts[scriptIndex],
      scriptPinned: scriptPinned,
      step: group.descs[stepIndex],
      steps: group.descs,
      stepPinned: stepPinned,
      stepRendered: stepIndex === group.activeIndex,
      signal: group.signal,
      sources: trimmed.sources,
      truncated: trimmed.truncated,
      ts: Date.now()
    };
  }

  /* ------------------------------------------------------------- scheduling */

  function send(payload) {
    // Report our own watch state so the background can re-assert it after a
    // navigation replaces this script with a fresh, idle copy.
    payload.active = active;
    try {
      window.postMessage({ __ojv: TAG_FROM_PAGE, payload: payload }, '*');
    } catch (e) {
      /* ignore */
    }
  }

  function tick(force) {
    // Nobody is watching: send a bare heartbeat so the background can correct
    // our state after a navigation, but don't serialize anything.
    if (!active) {
      send({ ok: false, reason: 'ping', href: location.href });
      return;
    }

    var payload;
    try {
      payload = collect(force);
    } catch (e) {
      payload = {
        ok: false,
        reason: 'error',
        message: String((e && e.message) || e),
        href: location.href
      };
    }

    var fp;
    if (!payload.ok) {
      fp = 'ng:' + payload.reason + ':' + (payload.detected || 0);
    } else {
      var prints = payload.sources
        .map(function (s) {
          return s.id + fingerprintOf(s.json || s.error || '');
        })
        .join('|');
      fp =
        payload.mode === 'other'
          ? ['other', payload.reason, payload.found, prints].join('~')
          : [
              payload.script.key,
              payload.step.key,
              payload.step.index,
              payload.steps.length,
              payload.scripts.length,
              payload.scriptPinned,
              payload.stepPinned,
              payload.stepRendered,
              payload.signal,
              prints
            ].join('~');
    }

    if (!force && fp === lastFingerprint) return;
    lastFingerprint = fp;
    send(payload);
  }

  function schedule() {
    if (timer) clearInterval(timer);
    timer = setInterval(function () {
      tick(false);
    }, active ? ACTIVE_POLL_MS : IDLE_POLL_MS);
  }

  function onMutation() {
    if (!active) return;
    if (mutationTimer) clearTimeout(mutationTimer);
    mutationTimer = setTimeout(function () {
      tick(false);
    }, 250);
  }

  function startObserver() {
    if (observer || !document.body) return;
    observer = new MutationObserver(onMutation);
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['class', 'style', 'data-omni-key']
    });
  }

  function setActive(next) {
    if (active === next) return;
    active = next;
    lastFingerprint = '';
    schedule();
    if (active) {
      startObserver();
      tick(true);
    }
  }

  /* --------------------------------------------------------------- commands */

  window.addEventListener('message', function (event) {
    if (event.source !== window) return;
    var data = event.data;
    if (!data || data.__ojv !== TAG_TO_PAGE) return;

    if (data.cmd === 'active') {
      setActive(!!data.value);
    } else if (data.cmd === 'refresh') {
      lastFingerprint = '';
      tick(true);
    } else if (data.cmd === 'pick') {
      pinnedScriptKey = data.scriptKey || null;
      pinnedStepKey = data.stepKey || null;
      lastFingerprint = '';
      tick(true);
    } else if (data.cmd === 'ping') {
      send({ ok: false, reason: 'ping', href: location.href });
    }
  });

  // A SPA route change invalidates any manual selection.
  var lastHref = location.href;
  setInterval(function () {
    if (location.href === lastHref) return;
    lastHref = location.href;
    pinnedScriptKey = null;
    pinnedStepKey = null;
    lastFingerprint = '';
    if (active) tick(true);
  }, 500);

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', startObserver, { once: true });
  } else {
    startObserver();
  }

  schedule();
  tick(true);
})();
