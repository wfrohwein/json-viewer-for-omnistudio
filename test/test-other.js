/* content-main.js against a page with no readable OmniScript: it should fall
 * back to whatever else on the page is holding JSON. */

const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const EXT = path.join(__dirname, '..');

const html = `<!doctype html><html><body>
<div class="page">
  <script type="application/ld+json">{"@type":"Organization","name":"ACME","url":"https://acme.example"}</script>
  <script type="application/json" id="state">{"appName":"portal","flags":{"beta":true}}</script>
  <script>window.notJson = 1;</script>

  <c-record-form id="form"></c-record-form>
  <c-summary-card id="card"></c-summary-card>
  <c-empty-thing id="empty"></c-empty-thing>
  <c-scalar-thing id="scalar"></c-scalar-thing>
  <c-date-thing id="dated"></c-date-thing>
  <c-mirror id="mirrorA"></c-mirror>
  <c-mirror id="mirrorB"></c-mirror>

  <div id="widget" data-config='{"rows":25,"sort":"name"}'>plain element</div>
  <div id="noise" data-label="not json"></div>
</div>
</body></html>`;

const dom = new JSDOM(html, {
  runScripts: 'outside-only',
  url: 'https://example.my.salesforce.com/lightning/r/Account/001/view',
  pretendToBeVisual: true
});
const { window } = dom;
const doc = window.document;

// jsdom has no layout, so nothing measures as visible; Chrome would report an
// attached, un-hidden element as visible.
window.Element.prototype.checkVisibility = () => true;

// A big-ish record so this source sorts first, plus a circular ref to prove the
// fallback path shares the main serializer.
const record = {
  Id: '001xx000003DGb2AAG',
  Name: 'Northwind Traders',
  Contacts: Array.from({ length: 20 }, (_, i) => ({ id: i, name: `Contact ${i}`, tier: 'gold' }))
};
record.self = record;
doc.getElementById('form').record = record;

// An own property under a name no fixed list would guess.
doc.getElementById('card').summaryTotals = { open: 3, closed: 12 };

// None of these should be offered.
doc.getElementById('empty').value = {};
doc.getElementById('scalar').value = 'just a string';
doc.getElementById('dated').value = new window.Date();
doc.getElementById('form')._internalState = { hidden: 'framework noise' };
doc.getElementById('form').$private = { hidden: 'also noise' };

// The same object reached from two elements is one source, not two.
const shared = { shared: true, note: 'reached twice' };
doc.getElementById('mirrorA').data = shared;
doc.getElementById('mirrorB').data = shared;

function cmd(fields) {
  window.dispatchEvent(
    new window.MessageEvent('message', {
      data: Object.assign({ __ojv: 'ojv-bridge' }, fields),
      source: window,
      origin: window.location.origin
    })
  );
}

const received = [];
window.addEventListener('message', (e) => {
  if (e.data && e.data.__ojv === 'ojv-page') received.push(e.data.payload);
});

let failures = 0;
const check = (name, cond, detail) => {
  console.log(`${cond ? '  ok  ' : ' FAIL '} ${name}${detail !== undefined ? ` — ${detail}` : ''}`);
  if (!cond) failures++;
};
const lastReal = () => [...received].reverse().find((p) => p.reason !== 'ping');

window.eval(fs.readFileSync(`${EXT}/content-main.js`, 'utf8'));
cmd({ cmd: 'active', value: true });

setTimeout(() => {
  const p = lastReal();
  check('emitted a payload', !!p, `${received.length} message(s)`);
  if (!p) return finish();

  check('reports data despite no OmniScript', p.ok === true, p.reason || '');
  check('flagged as the other-elements fallback', p.mode === 'other', p.mode);
  check('kept why it fell back', p.reason === 'no-omniscript', p.reason);
  check('found no steps', p.detected === 0, `${p.detected}`);

  const ids = (p.sources || []).map((s) => s.id);
  const labels = (p.sources || []).map((s) => s.label);
  const byLabel = (needle) => p.sources.find((s) => s.label.includes(needle));

  check('offered several sources', p.sources.length >= 5, labels.join(', '));
  check('ids are stable, not positional', ids.every((id) => id.startsWith('other:')), ids.join(', '));

  const form = byLabel('c-record-form');
  check('read a component property', !!form, labels.join(', '));
  check('labelled it with the element and property',
    form && form.label === 'c-record-form#form · record', form && form.label);
  check('biggest payload sorts first', p.sources[0] === form, p.sources[0].label);
  check('serialized it', form && JSON.parse(form.json).Name === 'Northwind Traders');
  check('tamed the circular ref', form && JSON.parse(form.json).self === '[Circular]');

  check('read an own property with an unguessable name',
    !!byLabel('summaryTotals'), labels.join(', '));
  check('read a JSON script tag',
    !!byLabel('application/ld+json') &&
      JSON.parse(byLabel('application/ld+json').json).name === 'ACME');
  check('read a second script tag', !!byLabel('application/json'));
  check('read JSON out of a data- attribute',
    !!byLabel('data-config') && JSON.parse(byLabel('data-config').json).rows === 25);

  check('skipped an empty object', !labels.some((l) => l.includes('c-empty-thing')));
  check('skipped a scalar property', !labels.some((l) => l.includes('c-scalar-thing')));
  check('skipped a Date', !labels.some((l) => l.includes('c-date-thing')));
  check('skipped framework internals', !labels.some((l) => l.includes('_internalState')));
  check('skipped $-prefixed internals', !labels.some((l) => l.includes('$private')));
  check('skipped a non-JSON data- attribute', !labels.some((l) => l.includes('data-label')));
  check('skipped a plain <script>', !labels.some((l) => l.includes('text/javascript')));

  const mirrors = labels.filter((l) => l.includes('c-mirror'));
  check('offered a shared object once', mirrors.length === 1, mirrors.join(', '));

  // --- live update
  const before = received.length;
  record.Name = 'Northwind Holdings';
  setTimeout(() => {
    const after = lastReal();
    check('picked up a change to the data', received.length > before);
    check('and carries the new value',
      JSON.parse(after.sources[0].json).Name === 'Northwind Holdings');
    phaseTwo();
  }, 2600);
}, 400);

/* An OmniScript appearing on the page takes over from the fallback. */
function phaseTwo() {
  const step = doc.createElement('runtime_omnistudio_omniscript-omniscript-step');
  step.setAttribute('data-omni-key', 'Late_Step');
  step.innerHTML = '<div><div class="custom-step-label">Late Step</div><input></div>';
  step.jsonData = { LateStep: true };
  doc.querySelector('.page').appendChild(step);

  setTimeout(() => {
    const p = lastReal();
    check('a real OmniScript takes over', p.mode === 'omniscript', p.mode);
    check('and shows its step', p.step && p.step.key === 'Late_Step', p.step && p.step.key);

    // …and when it goes away again, the fallback comes back.
    step.remove();
    setTimeout(() => {
      const back = lastReal();
      check('removing it falls back again', back.mode === 'other', back.mode);
      finish();
    }, 2600);
  }, 1200);
}

function finish() {
  console.log(failures ? `\n${failures} FAILURE(S)` : '\nall checks passed');
  process.exit(failures ? 1 : 0);
}
