# Browser tools

Pi extension using Playwright Chromium with one temporary browser context and active page.
Call `browser_open` before using the page tools. `browser_close`, `/browser-reset`, and session shutdown close the browser; `/browser-status` reports its state.

## Installation

Requires [Pi](https://github.com/earendil-works/pi) and Playwright's Chromium. Tested with Pi **1.4.0**, Playwright **1.61.1**, and Node.js **26.12.1** on macOS. This is a personal extension; compatibility with other versions and platforms is not guaranteed.

```sh
pi install git:github.com/gadkadosh/pi-browser-tools
npx --yes --package=playwright@1.61.1 playwright install chromium
```

The second command installs the browser binary matching the locked Playwright version. Linux may also need system dependencies (`playwright install --with-deps chromium`). Restart Pi or run `/reload`, then ask it to open a page and inspect or interact with it. The tools are `browser_open`, `browser_screenshot`, `browser_eval`, `browser_click`, `browser_type`, and `browser_close`.

To update or remove:

```sh
pi update git:github.com/gadkadosh/pi-browser-tools
pi remove git:github.com/gadkadosh/pi-browser-tools
```

If you already load a local copy, remove or disable that copy before installing from GitHub to avoid duplicate tools.

## Security

This extension runs with Pi's operating-system permissions. It can visit sites (including local services), execute JavaScript in pages, click controls, fill forms, and write screenshots to the requested filesystem path. Page content and screenshots returned by tools may be sent to your model provider.

Each browser starts with a temporary context, not your normal browser profile. If you sign in during a session, the tools can act as that account until you close/reset the browser. Page content is untrusted; review sensitive actions and do not expose credentials or private pages unless you intend to share them with your model provider. Closing discards temporary browser storage, but does not delete saved screenshots or Pi's conversation history.

## Browser mode and execution

`headless` selects the mode when `browser_open` launches Chromium (default `true`). On an active browser, omit it to keep the current mode or explicitly request the same mode. An explicit different mode fails **before navigation or resizing** and preserves the current page and storage. Call `browser_close` or `/browser-reset` before changing modes; closing discards temporary browser state.

All six browser tools request sequential execution because they share one active page. Pi runs a batch containing a sequential tool in call order, including any non-browser calls in that batch. Batches containing only unrelated tools retain Pi's normal parallel execution. This orders tool operations, not background JavaScript or network activity in the page.

## Click and fill targets

`browser_click` and `browser_type` require the selector to resolve to exactly one intended element. Multiple matches produce a strict-mode error without clicking/filling the first match. Scope ambiguous selectors to the correct container/control; use `:visible` or deliberate `>> nth=...` narrowing only when appropriate. Normal Playwright auto-waiting and actionability checks still apply; the tools do not force actions or retry through JavaScript.

## Viewport

Every `browser_open` applies `width` and `height` before navigation, including when reusing the active page. Omitted dimensions default to **1440×900** (width×height), independently. Switching between desktop and mobile viewport sizes does not require closing the browser and preserves the browser context. This changes viewport size only, not mobile-device emulation.

## JavaScript evaluation

`browser_eval({ script })` evaluates a JavaScript expression or function in the active page. Functions are called once with no arguments; other values are returned directly. Promises are awaited. Parenthesized objects and already-invoked functions work without extra wrapping:

```js
({ title: document.title, text: document.body.innerText })
() => { const heading = document.querySelector("h1"); return heading?.textContent; }
(async () => { await Promise.resolve(); return document.title; })()
```

For multiple statements, use a function with an explicit `return`. Errors are reported without retrying the script, so side effects are not repeated.

## Screenshots

`browser_screenshot({ path, fullPage?, selector? })` saves the original capture and returns **both the saved-file path and an image attachment**. Inspect that image directly; a separate `read` call is unnecessary.

- Relative paths resolve against Pi's working directory.
- `fullPage` defaults to `true`; pass `false` for the viewport only.
- `selector` captures just that element, regardless of `fullPage`.
- The returned preview fits within **2000×2000 pixels**, preserving aspect ratio (subject to pixel rounding), with less than **4.5 MiB of base64 image payload**. Pi's image helper may re-encode or further shrink the preview to meet that byte budget.
- The saved file stays at the original captured resolution. Result text reports original and preview dimensions and identifies resized/re-encoded previews. Do not assume preview coordinates match original-image coordinates.
- If preview generation fails, the tool reports an error including the already-saved original's path; it does not return an unbounded image.

Reload Pi (`/reload`) after editing the extension.

## Verification

For local development, clone the repository and run `npm ci --legacy-peer-deps` to install Playwright without installing a second copy of Pi's host-provided packages. Install Chromium as above.

With Pi's SDK available to Node, run `npm test`. Otherwise point the test at the installed `@earendil-works/pi-coding-agent` package directory:

```sh
PI_PACKAGE_DIR=/path/to/pi-coding-agent npm test
```

The tests load this extension through Pi's real SDK and execute its tools in Chromium. Correctness tests feed scripted assistant responses through Pi's actual scheduler (no model calls), verify ordered page operations and screenshot output, and check that unrelated-only batches still overlap. They exercise both headed/headless mode handling, preservation of page state after rejected changes, close/reset/shutdown recovery, and strict click/fill targets with real side-effect assertions. These tests briefly open visible Chromium windows and require a graphical session. Evaluation tests cover expressions, functions, promises, errors, and one-time side effects. The screenshot test uses a local HTTP fixture and checks viewport changes before navigation, desktop/mobile screenshot dimensions, default dimensions, repeated opens, and preserved session storage. It decodes returned images, checks visible pixel colors, verifies saved originals, and covers viewport, full-page (explicit/default), element, wide-element, JPEG, relative/absolute paths, and closed-page behavior. Chromium must be installed for the extension's Playwright version (`npx playwright install chromium` if needed). No model credentials are needed for this test.

## License

[MIT](LICENSE).
