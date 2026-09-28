/* End-to-end test of content-main.js against a fixture that mirrors the real
 * OmniScript DOM: many empty step elements, exactly one rendered step. */

const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const EXT = path.join(__dirname, '..');

const steps = [
  'Welcome_Instructions',
  'Applicant_Details',
  'Current_Members',
  'Projected_Members',
  'Capacity'
];

// A second OmniScript on the same page, with its own rendered step but less
// content than the first, so auto-detection has a clear winner.
const secondarySteps = ['Case_Details', 'Case_Terms'];

const html = `<!doctype html><html><body>
<div class="siteforceContentArea">
 <runtime_omnistudio-omniscript-experience-cloud>
  <forcegenerated-omni-script_-a-c-m-e___-membership-application___-english___lightning id="gen">
   <runtime_omnistudio_omniscript-omniscript-container id="container">
    <article class="omniscript-article">
     <div class="omniscript-side-content">
       <runtime_omnistudio_omniscript-omniscript-step-chart data-omni-key="omniscriptStepChart">
         <ol class="slds-progress__list">
           <li><div class="slds-progress__item slds-is-active" data-index="1">
             <button class="slds-button slds-progress__marker" data-index="1"><span class="slds-assistive-text">Welcome and Instructions You're currently viewing this step.</span></button>
             <div class="slds-progress__item_content slds-text-title_bold">Welcome and Instructions</div>
           </div></li>
           <li><div class="slds-progress__item" data-index="2">
             <div class="slds-progress__item_content">Applicant Details</div>
           </div></li>
         </ol>
       </runtime_omnistudio_omniscript-omniscript-step-chart>
     </div>
     <div class="omniscript-body slds-grid slds-grid_vertical">
      <runtime_omnistudio_omniscript-omniscript-dr-extract-action data-omni-key="GetNarrativeFileID"></runtime_omnistudio_omniscript-omniscript-dr-extract-action>
      <runtime_omnistudio_omniscript-omniscript-step data-omni-key="${steps[0]}" id="live">
        <div></div>
        <div>
          <div class="custom-step-label slds-page-header__title slds-text-heading_medium os-step-label" role="heading" aria-level="2">Welcome and Instructions</div>
          <div class="vlc-separator slds-border_top"></div>
        </div>
        <div class="omniscript-step__body">
          <runtime_omnistudio_omniscript-omniscript-navigate-action data-omni-key="DownloadInstructions"><button>Download</button></runtime_omnistudio_omniscript-omniscript-navigate-action>
          <runtime_omnistudio_omniscript-omniscript-checkbox data-omni-key="TermsAccepted"><input type="checkbox"></runtime_omnistudio_omniscript-omniscript-checkbox>
        </div>
      </runtime_omnistudio_omniscript-omniscript-step>
      ${steps
        .slice(1)
        .map(
          (k, i) =>
            `<runtime_omnistudio_omniscript-omniscript-step data-omni-key="${k}"${
              i === 3 ? ' class="slds-hide"' : ''
            }></runtime_omnistudio_omniscript-omniscript-step>`
        )
        .join('\n      ')}
     </div>
    </article>
   </runtime_omnistudio_omniscript-omniscript-container>
  </forcegenerated-omni-script_-a-c-m-e___-membership-application___-english___lightning>
 </runtime_omnistudio-omniscript-experience-cloud>
</div>

<div class="secondary-region">
 <runtime_omnistudio-omniscript-experience-cloud>
  <forcegenerated-omni-script_-a-c-m-e___-support-case___-english___lightning>
   <runtime_omnistudio_omniscript-omniscript-container id="container2">
    <div class="omniscript-body slds-grid">
     <runtime_omnistudio_omniscript-omniscript-step data-omni-key="${secondarySteps[0]}" id="live2">
       <div><div class="custom-step-label">Case Details</div></div>
     </runtime_omnistudio_omniscript-omniscript-step>
     <runtime_omnistudio_omniscript-omniscript-step data-omni-key="${secondarySteps[1]}"></runtime_omnistudio_omniscript-omniscript-step>
    </div>
   </runtime_omnistudio_omniscript-omniscript-container>
  </forcegenerated-omni-script_-a-c-m-e___-support-case___-english___lightning>
 </runtime_omnistudio-omniscript-experience-cloud>
</div>
</body></html>`;

const dom = new JSDOM(html, {
  runScripts: 'outside-only',
  url: 'https://example--dev.sandbox.my.site.com/portal/s/application',
  pretendToBeVisual: true
});
const { window } = dom;

// jsdom has no layout; emulate Chrome's checkVisibility (display:none via slds-hide).
window.Element.prototype.checkVisibility = function () {
  let el = this;
  while (el) {
    if (el.classList && el.classList.contains('slds-hide')) return false;
    el = el.parentElement;
  }
  return true;
};

// The data the real LWC exposes, including a circular ref and a DOM node to
// prove the serializer survives them.
const payloadData = {
  ContextId: 'a0X5f000001abcDEAQ',
  ApplicationYear: '2025-2026',
  TermsAccepted: true,
  Members: [
    { tier: 'T1', count: 120, site: 'Alpha' },
    { tier: 'T2', count: 240, site: 'Beta' }
  ],
  nested: { deep: { deeper: { value: 'find-me' } } }
};
payloadData.selfRef = payloadData; // circular
payloadData.node = window.document.body; // DOM node

const live = window.document.getElementById('live');
live.jsonData = payloadData;
window.document.getElementById('container').jsonData = {
  ...payloadData,
  selfRef: undefined,
  node: undefined,
  wholeScriptExtra: 'only-on-container'
};

// The other OmniScript carries entirely different data.
const secondaryData = { PartnerName: 'Northwind Traders', ContractYear: 2026 };
window.document.getElementById('live2').jsonData = secondaryData;
window.document.querySelectorAll('[data-omni-key="Case_Terms"]')[0].jsonData = {
  ...secondaryData,
  Terms: 'net-30'
};
window.document.getElementById('container2').jsonData = secondaryData;

// Give the non-rendered steps of the first script their own data, so choosing
// one proves we really read that element and not the rendered one.
window.document.querySelectorAll('[data-omni-key="Current_Members"]')[0].jsonData = {
  ...payloadData,
  selfRef: undefined,
  node: undefined,
  whichStep: 'Current_Members'
};

/* jsdom sets event.source to null for same-window postMessage; Chrome sets it to
 * the window (which is what the isolated->main world bridge depends on). Dispatch
 * the event ourselves so the source guard sees what it would see in Chrome. */
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

// While idle the scanner only heartbeats; the side panel opening is what makes
// it start reading payloads.
check('idle scanner only heartbeats', received.every((p) => p.reason === 'ping'),
  JSON.stringify(received.map((p) => p.reason)));
cmd({ cmd: 'active', value: true });

// ---------------------------------------------------------------- assertions

setTimeout(() => {
  const p = lastReal();
  check('scanner emitted a payload once watched', !!p, `${received.length} message(s)`);
  if (!p) return finish();

  check('payload.ok', p.ok === true, p.reason || '');
  check('found every step on the page',
    p.detected === steps.length + secondarySteps.length, `detected=${p.detected}`);

  // --- multiple OmniScripts
  check('grouped into two OmniScripts', p.scripts.length === 2, `${p.scripts.length}`);
  check('decoded the first script name',
    p.scripts[0].label === 'ACME / MembershipApplication · English', p.scripts[0].label);
  check('decoded the second script name',
    p.scripts[1].label === 'ACME / SupportCase · English', p.scripts[1].label);
  check('counted steps per script',
    p.scripts[0].steps === steps.length && p.scripts[1].steps === secondarySteps.length,
    `${p.scripts[0].steps} / ${p.scripts[1].steps}`);
  check('both scripts report a rendered step',
    p.scripts.every((s) => s.rendered === true));
  check('auto-detected the busier script', p.script.label.includes('MembershipApplication'),
    p.script.label);
  check('steps listed are only the selected script\'s', p.steps.length === steps.length,
    `${p.steps.length}`);
  check('nothing pinned yet', p.scriptPinned === false && p.stepPinned === false);
  check(
    'picked the rendered step',
    p.step && p.step.key === 'Welcome_Instructions',
    `got "${p.step && p.step.key}"`
  );
  check(
    'read the step label',
    p.step && p.step.label === 'Welcome and Instructions',
    `got "${p.step && p.step.label}"`
  );
  check(
    'listed every step for the picker',
    Array.isArray(p.steps) && p.steps.length === steps.length,
    `${p.steps && p.steps.length}`
  );
  check(
    'marked hidden step as not visible',
    p.steps.some((s) => s.key === 'Capacity' && s.visible === false)
  );

  const step = p.sources.find((s) => s.id === 'step');
  check('exposed the step jsonData source', !!step);

  let parsed = null;
  try {
    parsed = JSON.parse(step.json);
  } catch (e) {
    /* handled below */
  }
  check('step json parses', !!parsed);
  check('kept scalar data', parsed && parsed.ApplicationYear === '2025-2026');
  check('kept nested arrays', parsed && parsed.Members[1].count === 240);
  check('tamed the circular ref', parsed && parsed.selfRef === '[Circular]', String(parsed && parsed.selfRef));
  check('tamed the DOM node', parsed && parsed.node === '[DOM body]', String(parsed && parsed.node));

  const script = p.sources.find((s) => s.id === 'script');
  check('offered the whole-script source separately', !!script);
  check(
    'whole-script source really differs',
    script && JSON.parse(script.json).wholeScriptExtra === 'only-on-container'
  );

  // --- choosing the other OmniScript
  cmd({ cmd: 'active', value: true });
  cmd({ cmd: 'pick', scriptKey: p.scripts[1].key, stepKey: null });
  setTimeout(() => {
    const other = lastReal();
    check('choosing an OmniScript switches to it',
      other.script.label.includes('SupportCase'), other.script.label);
    check('reports the script as pinned', other.scriptPinned === true);
    check('its own steps are listed', other.steps.length === secondarySteps.length &&
      other.steps[0].key === 'Case_Details');
    check('auto-picks the rendered step within it', other.step.key === 'Case_Details',
      other.step.key);
    check('reads that script\'s data',
      JSON.parse(other.sources[0].json).PartnerName === 'Northwind Traders');

    // --- choosing a step inside it, including one that isn't rendered
    cmd({ cmd: 'pick', scriptKey: p.scripts[1].key, stepKey: 'Case_Terms' });
    setTimeout(() => {
      const step2 = lastReal();
      check('choosing a step switches to it', step2.step.key === 'Case_Terms', step2.step.key);
      check('reports the step as pinned', step2.stepPinned === true);
      check('flags that it is not the rendered step', step2.stepRendered === false);
      check('reads that step\'s own data',
        JSON.parse(step2.sources[0].json).Terms === 'net-30');

      // --- a selection that no longer resolves falls back to auto
      cmd({ cmd: 'pick', scriptKey: 'no-such-script|nope|9', stepKey: 'no-such-step' });
      setTimeout(() => {
        const reset = lastReal();
        check('a stale OmniScript choice falls back to auto', reset.scriptPinned === false);
        check('a stale step choice falls back to auto', reset.stepPinned === false);
        check('and lands back on the rendered step',
          reset.step.key === 'Welcome_Instructions', reset.step.key);
        phaseTwo();
      }, 200);
    }, 200);
  }, 200);
}, 300);

function phaseTwo() {
  // --- live update: mutate jsonData the way a user typing into the form does
  cmd({ cmd: 'pick', scriptKey: null, stepKey: null });
  setTimeout(() => {
    const before = received.length;
    payloadData.Members[0].count = 999;
    setTimeout(() => {
      const after = lastReal();
      check('picked up an in-place jsonData change', received.length > before);
      check(
        'new payload carries the new value',
        JSON.parse(after.sources[0].json).Members[0].count === 999
      );
      phaseNav();
    }, 1200);
  }, 200);
}

/* The reported bug: clicking Next in the OmniScript left the panel showing the
 * step it started on. Reproduce it — move the chart's active marker to step 2
 * while step 1's (larger) markup lingers, which is what defeats a
 * "biggest visible step wins" heuristic. */
function phaseNav() {
  const doc = window.document;
  const chartItems = doc.querySelectorAll('.slds-progress__item');
  chartItems[0].classList.remove('slds-is-active');
  chartItems[1].classList.add('slds-is-active');

  const step2 = doc.querySelector('[data-omni-key="Applicant_Details"]');
  step2.innerHTML = '<div><div class="custom-step-label">Applicant Details</div></div>';
  step2.jsonData = { Applicant: 'applicant-details' };

  const step1 = doc.getElementById('live');
  check('step 1 markup really does linger, and is still the larger one',
    step1.getElementsByTagName('*').length > step2.getElementsByTagName('*').length,
    `${step1.getElementsByTagName('*').length} vs ${step2.getElementsByTagName('*').length}`);

  setTimeout(() => {
    const p = lastReal();
    check('follows the page to the next step despite the lingering markup',
      p.step.key === 'Applicant_Details', p.step.key);
    check('used the step chart to decide', p.signal === 'chart', p.signal);
    check('reports it as the rendered step', p.stepRendered === true);
    check('and reads that step\'s data',
      JSON.parse(p.sources[0].json).Applicant === 'applicant-details');
    finish();
  }, 1200);
}

function finish() {
  console.log(failures ? `\n${failures} FAILURE(S)` : '\nall checks passed');
  process.exit(failures ? 1 : 0);
}
