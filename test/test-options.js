/* Drives options.js (the Sites manager) inside jsdom with stubbed chrome APIs. */

const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const EXT = path.join(__dirname, '..');
const manifest = JSON.parse(fs.readFileSync(`${EXT}/manifest.json`, 'utf8'));

const dom = new JSDOM(fs.readFileSync(`${EXT}/options.html`, 'utf8'), {
  runScripts: 'outside-only',
  url: 'chrome-extension://test/options.html'
});
const { window } = dom;
const doc = window.document;

let granted = [];
const requested = [];
const removed = [];
let requestResult = true;
let requestThrows = false;

window.chrome = {
  runtime: { getManifest: () => manifest },
  permissions: {
    onAdded: { addListener() {} },
    onRemoved: { addListener() {} },
    getAll: async () => ({ origins: manifest.host_permissions.concat(granted) }),
    request: async ({ origins }) => {
      if (requestThrows) throw new Error('user gesture required');
      requested.push(origins[0]);
      if (requestResult) granted = granted.concat(origins);
      return requestResult;
    },
    remove: async ({ origins }) => {
      removed.push(origins[0]);
      granted = granted.filter((o) => !origins.includes(o));
      return true;
    }
  },
  tabs: {
    query: async () => [
      { url: 'https://example--dev.sandbox.my.site.com/portal/s/page', title: 'Covered already' },
      { url: 'https://portal.example.org/s/enroll', title: 'Example Portal' },
      { url: 'https://portal.example.org/s/other', title: 'Example Portal 2' },
      { url: 'chrome://extensions', title: 'Extensions' }
    ]
  }
};

window.eval(fs.readFileSync(`${EXT}/options.js`, 'utf8'));
const api = window.__ojvOptions;

const settle = () => new Promise((r) => setTimeout(r, 10));
const click = (node) => node.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
const el = (id) => doc.getElementById(id);
const rowsIn = (id) => Array.from(el(id).querySelectorAll('.site'));

let failures = 0;
const check = (name, cond, detail) => {
  console.log(`${cond ? '  ok  ' : ' FAIL '} ${name}${detail !== undefined ? ` — ${detail}` : ''}`);
  if (!cond) failures++;
};

(async () => {
  // ---------------------------------------------------- pattern normalising
  const p = api.toPattern;
  check('a pasted deep link keeps only the origin',
    p('https://acme.my.site.com/portal/s/application?x=1') === 'https://acme.my.site.com/*',
    p('https://acme.my.site.com/portal/s/application?x=1'));
  check('a bare host is assumed https',
    p('acme.my.site.com') === 'https://acme.my.site.com/*', p('acme.my.site.com'));
  check('a wildcard host is kept',
    p('*.example.org') === 'https://*.example.org/*', p('*.example.org'));
  check('an existing match pattern passes through',
    p('https://foo.example.com/*') === 'https://foo.example.com/*');
  check('http is preserved', p('http://localhost:8080/s/x') === 'http://localhost:8080/*',
    p('http://localhost:8080/s/x'));
  check('whitespace is tolerated',
    p('  https://acme.my.site.com/x  ') === 'https://acme.my.site.com/*');
  check('nonsense is rejected', p('not a url') === null, String(p('not a url')));
  check('an empty box is rejected', p('') === null && p('   ') === null);

  // ------------------------------------------------------------- coverage
  const builtin = manifest.host_permissions;
  check('a sandbox host counts as covered by *.my.site.com',
    api.coveredBy(builtin, 'https://example--dev.sandbox.my.site.com/*'));
  check('an unrelated host is not covered',
    !api.coveredBy(builtin, 'https://portal.example.org/*'));
  check('a wildcard does not match its own bare suffix wrongly',
    api.coveredBy(['https://*.example.org/*'], 'https://a.b.example.org/*') &&
      !api.coveredBy(['https://*.example.org/*'], 'https://notexample.org/*'));

  await settle();

  // ------------------------------------------------------------- rendering
  check('built-in sites are listed', rowsIn('builtin').length === builtin.length,
    rowsIn('builtin').length);
  check('nothing added yet', el('granted').textContent.includes('Nothing added yet'));
  check('open tabs that are unreachable are offered',
    rowsIn('tabs').length === 1, rowsIn('tabs').length);
  check('and it is the uncovered one',
    rowsIn('tabs')[0].textContent.includes('portal.example.org'),
    rowsIn('tabs')[0].textContent);
  check('duplicate tabs on one host collapse to a single row',
    rowsIn('tabs').filter((r) => r.textContent.includes('example')).length === 1);
  check('a covered tab is not offered', !el('tabs').textContent.includes('my.site.com'));
  check('non-web tabs are ignored', !el('tabs').textContent.includes('chrome://'));

  // ---------------------------------------------------------- adding a site
  click(rowsIn('tabs')[0].querySelector('button'));
  await settle();
  check('adding requests exactly that origin',
    requested[0] === 'https://portal.example.org/*', requested[0]);
  check('it moves into the added list', rowsIn('granted').length === 1,
    rowsIn('granted').length);
  check('and disappears from the tab suggestions',
    !el('tabs').textContent.includes('example.org'));

  // typing one by hand
  el('addInput').value = 'https://another.example.com/s/page';
  el('addForm').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  await settle();
  check('typing a URL adds its origin',
    requested[1] === 'https://another.example.com/*', requested[1]);
  check('the box is cleared on success', el('addInput').value === '');

  // bad input
  el('addInput').value = 'nope';
  el('addForm').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  await settle();
  check('bad input is explained, not requested', requested.length === 2 &&
    el('addNote').textContent.includes("doesn't look like"), el('addNote').textContent);

  // declined by Chrome
  requestResult = false;
  el('addInput').value = 'declined.example.com';
  el('addForm').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  await settle();
  check('a declined request says so', el('addNote').textContent.includes('declined'),
    el('addNote').textContent);
  check('and nothing is added', rowsIn('granted').length === 2, rowsIn('granted').length);
  requestResult = true;

  // thrown request (what a side panel can hit)
  requestThrows = true;
  el('addInput').value = 'thrown.example.com';
  el('addForm').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  await settle();
  check('a failed request surfaces the reason',
    el('addNote').textContent.includes('user gesture'), el('addNote').textContent);
  requestThrows = false;

  // -------------------------------------------------------- removing a site
  const removeBtn = () => rowsIn('granted')[0].querySelector('.remove');
  click(removeBtn());
  await settle();
  check('removal asks first', removed.length === 0 && removeBtn().textContent === 'Remove?',
    removeBtn().textContent);
  click(removeBtn());
  await settle();
  check('confirming removes it', removed.length === 1, removed[0]);
  check('the list shrinks', rowsIn('granted').length === 1, rowsIn('granted').length);
  check('and it returns to the tab suggestions',
    el('tabs').textContent.includes('example.org'));

  console.log(failures ? `\n${failures} FAILURE(S)` : '\nall checks passed');
  process.exit(failures ? 1 : 0);
})();
