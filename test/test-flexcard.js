/* content-main.js against FlexCards: offered by name on a page of their own,
 * and alongside an OmniScript when the two share a page. The tag names are the
 * ones a real Experience Cloud page renders. */

const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const EXT = path.join(__dirname, '..');

const CARD = 'forcegenerated-flex-card_-a-c-m-e_-account-actions___salesforce___1___false_gen';
const OTHER_CARD = 'forcegenerated-flex-card_-a-c-m-e_-contact-list___salesforce___2___false_gen';

const html = `<!doctype html><html><body>
<div class="page">
  <${CARD} id="card">
    <runtime_omnistudio_flexcards-flex-card-state class="cf-vlocity-state-0" id="state0">
      <button>Add Location</button>
    </runtime_omnistudio_flexcards-flex-card-state>
  </${CARD}>
  <div class="slds-hide">
    <${OTHER_CARD} id="hiddenCard"></${OTHER_CARD}>
  </div>
  <${CARD} id="card2"></${CARD}>
  <${OTHER_CARD} id="emptyCard"></${OTHER_CARD}>
  <c-noise id="noise"></c-noise>
</div>
</body></html>`;

const dom = new JSDOM(html, {
  runScripts: 'outside-only',
  url: 'https://example.my.site.com/portal/s/account',
  pretendToBeVisual: true
});
const { window } = dom;
const doc = window.document;

window.Element.prototype.checkVisibility = function () {
  let el = this;
  while (el) {
    if (el.classList && el.classList.contains('slds-hide')) return false;
    el = el.parentElement;
  }
  return true;
};

const records = [
  {
    Id: 'REC0',
    EffectiveDate: '11/20/2025',
    ACME_Record_Type_Name__c: 'Partner Group',
    ACME_Is_Active__c: true,
    _flex: { uniqueKey: 'REC0', state0element0block_element0: true }
  }
];
doc.getElementById('card').records = records;
doc.getElementById('state0').record = records[0];
doc.getElementById('hiddenCard').records = [{ Id: 'C1', Name: 'Hidden contact' }];
doc.getElementById('card2').records = [{ Id: 'REC9' }];
// A card whose data source returned nothing is still a card worth showing.
doc.getElementById('emptyCard').records = [];
doc.getElementById('noise').data = { unrelated: true };

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

  check('reports data with no OmniScript', p.ok === true, p.reason || '');
  check('uses the fallback mode', p.mode === 'other', p.mode);
  check('counts the cards', p.flexcards === 4, `${p.flexcards}`);

  const labels = p.sources.map((s) => s.label);
  const cards = p.sources.filter((s) => s.id.startsWith('flexcard:'));

  check('a FlexCard is offered first', p.sources[0].id.startsWith('flexcard:'), labels.join(', '));
  check('named from the generated tag',
    p.sources[0].label === 'FlexCard · ACME_AccountActions · records', p.sources[0].label);
  check('serialized its records',
    JSON.parse(p.sources[0].json)[0].ACME_Record_Type_Name__c === 'Partner Group');
  check('kept the _flex state', JSON.parse(p.sources[0].json)[0]._flex.uniqueKey === 'REC0');
  check('a second card of the same name is numbered',
    labels.includes('FlexCard · ACME_AccountActions (2) · records'), labels.join(', '));
  check('an empty card is still offered',
    cards.some((s) => s.id === 'flexcard:ACME_ContactList#2' && s.json === '[]'),
    cards.map((s) => s.id).join(', '));
  check('hidden cards come after visible ones',
    cards[cards.length - 1].id === 'flexcard:ACME_ContactList#1', cards.map((s) => s.id).join(', '));
  check('the generic sweep does not list the card again',
    !labels.some((l) => l.startsWith('forcegenerated-flex-card_')), labels.join(', '));
  check('nor each state\'s copy of a record',
    !labels.some((l) => l.includes('flex-card-state')), labels.join(', '));
  check('other page JSON is still offered after the cards',
    labels.some((l) => l.includes('c-noise')), labels.join(', '));

  // --- live update
  const before = received.length;
  records[0].ACME_Is_Active__c = false;
  setTimeout(() => {
    const after = lastReal();
    check('picked up a change to the card data', received.length > before);
    check('and carries the new value', JSON.parse(after.sources[0].json)[0].ACME_Is_Active__c === false);
    phaseTwo();
  }, 1200);
}, 400);

/* With an OmniScript on the page, the step leads and the cards follow. */
function phaseTwo() {
  const step = doc.createElement('runtime_omnistudio_omniscript-omniscript-step');
  step.setAttribute('data-omni-key', 'Partner_Info');
  step.innerHTML = '<div><div class="custom-step-label">Partner Info</div><input></div>';
  step.jsonData = { PartnerId: 'P-1' };
  doc.querySelector('.page').appendChild(step);

  setTimeout(() => {
    const p = lastReal();
    check('the OmniScript takes over', p.mode === 'omniscript', p.mode);
    check('its step is the first source', p.sources[0].id === 'step', p.sources[0].id);
    const card = p.sources.find((s) => s.id === 'flexcard:ACME_AccountActions#1');
    check('the FlexCard is offered beside it', !!card, p.sources.map((s) => s.id).join(', '));
    check('with its data', card && JSON.parse(card.json)[0].Id === 'REC0');
    finish();
  }, 1200);
}

function finish() {
  console.log(failures ? `\n${failures} FAILURE(S)` : '\nall checks passed');
  process.exit(failures ? 1 : 0);
}
