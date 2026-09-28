# Contributing

Pull requests are welcome. This is a small, dependency-free extension, so
getting started is quick.

## Setting up

```sh
git clone <your fork>
cd json-viewer-for-omnistudio
npm install      # jsdom, for the tests only — the extension itself has no dependencies
npm test
```

Then load it in Chrome: `chrome://extensions` → **Developer mode** → **Load
unpacked** → pick the repo folder. After editing any file, press the reload
arrow on the extension card, then reload the Salesforce tab.

## Before you open a PR

- **`npm test` passes.** CI runs it on every push and pull request.
- **New behaviour comes with a test.** The three suites are the spec; if a
  change isn't pinned down by one, it will quietly regress later.
- **No new runtime dependencies.** The extension ships as plain JS with no build
  step, and that's worth keeping. `jsdom` is the only dev dependency.
- **No telemetry, no network calls.** Everything stays in the browser. A PR that
  adds an outbound request will not be merged.
- **Never commit real org data.** See below.

## Never commit real org data

The tests use deliberately fictional fixtures — `ACME / MembershipApplication`,
`example--dev.sandbox.my.site.com`, `example.com`/`.org` hosts. Please keep it
that way.

When you're debugging against a real org it's tempting to paste an actual
payload, step name, sandbox URL or record ID into a test. Don't: those identify
a real customer's internal systems, and a public git history is forever. Rename
anything real to a fictional equivalent before committing. Use
[RFC 2606](https://www.rfc-editor.org/rfc/rfc2606) reserved domains
(`example.com`, `example.org`, `example.net`) for hosts.

## Where things live

| File | Role |
|---|---|
| `content-main.js` | Page-world scanner. Reads `element.jsonData`, picks the rendered step, and — when there is none — sweeps the page for JSON on other elements. |
| `content-bridge.js` | Relays between the page world and the extension. |
| `background.js` | Caches payloads per tab, fans them out, registers scripts for added sites. |
| `sidepanel.*` | The viewer. |
| `options.*` | The Sites manager. |
| `theme.css` | Colour tokens shared by both pages. |
| `test/*.js` | jsdom suites — see the Development section of the README. |

`README.md` explains how step detection works and why it's ordered the way it
is. Worth reading before changing `content-main.js`.

## Testing notes

jsdom has no layout engine, so `test-scan.js` and `test-other.js` stub
`checkVisibility()` to emulate Chrome. Anything depending on real layout can't be covered there — test
it by hand in the browser and say so in the PR.

If you change how a payload is shaped, `test-panel.js`'s `makePayload()` is the
single place the fixture is defined. The fallback payload (`mode: 'other'`) has
its own fixture in the same file, next to the degraded-payload checks.

## Reporting bugs

Include your Chrome version, whether the site is a built-in domain or one you
added, and — if step detection is picking the wrong step — what the step
dropdown's tooltip says (it names the signal detection used: `chart`,
`chart-label`, `layout` or `content`).

Please don't paste real payloads into issues. Redact or reconstruct a minimal
fictional example.
