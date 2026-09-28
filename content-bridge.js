/*
 * JSON Viewer for OmniStudio — isolated-world bridge.
 *
 * The page-world script (content-main.js) can read LWC properties but has no
 * access to chrome.* APIs. This relays between the two.
 */
(function () {
  'use strict';

  if (window.__OJV_BRIDGE_INSTALLED__) return;
  window.__OJV_BRIDGE_INSTALLED__ = true;

  var TAG_FROM_PAGE = 'ojv-page';
  var TAG_TO_PAGE = 'ojv-bridge';

  function alive() {
    try {
      return !!(chrome.runtime && chrome.runtime.id);
    } catch (e) {
      return false;
    }
  }

  // page -> background
  window.addEventListener('message', function (event) {
    if (event.source !== window) return;
    var data = event.data;
    if (!data || data.__ojv !== TAG_FROM_PAGE) return;
    if (!alive()) return;
    try {
      var p = chrome.runtime.sendMessage({ type: 'OJV_UPDATE', payload: data.payload });
      if (p && typeof p.catch === 'function') p.catch(function () {});
    } catch (e) {
      /* service worker restarting, or extension reloaded */
    }
  });

  // background -> page
  chrome.runtime.onMessage.addListener(function (msg) {
    if (!msg || msg.type !== 'OJV_CMD') return;
    try {
      window.postMessage(
        {
          __ojv: TAG_TO_PAGE,
          cmd: msg.cmd,
          value: msg.value,
          scriptKey: msg.scriptKey,
          stepKey: msg.stepKey
        },
        '*'
      );
    } catch (e) {
      /* ignore */
    }
  });
})();
