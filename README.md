# Browser tools

Pi extension using Playwright Chromium with one temporary browser context and active page.
Call `browser_open` before using the page tools. `browser_close`, `/browser-reset`, and session shutdown close the browser; `/browser-status` reports its state.

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

With Pi's SDK available to Node, run `npm test`. Otherwise point the test at the installed `@earendil-works/pi-coding-agent` package directory:

```sh
PI_PACKAGE_DIR=/path/to/pi-coding-agent npm test
```

The tests load this extension through Pi's real SDK and execute its tools in Chromium. Correctness tests feed scripted assistant responses through Pi's actual scheduler (no model calls), verify ordered page operations and screenshot output, and check that unrelated-only batches still overlap. They exercise both headed/headless mode handling, preservation of page state after rejected changes, close/reset/shutdown recovery, and strict click/fill targets with real side-effect assertions. These tests briefly open visible Chromium windows and require a graphical session. Evaluation tests cover expressions, functions, promises, errors, and one-time side effects. The screenshot test uses a local HTTP fixture and checks viewport changes before navigation, desktop/mobile screenshot dimensions, default dimensions, repeated opens, and preserved session storage. It decodes returned images, checks visible pixel colors, verifies saved originals, and covers viewport, full-page (explicit/default), element, wide-element, JPEG, relative/absolute paths, and closed-page behavior. Chromium must be installed for the extension's Playwright version (`npx playwright install chromium` if needed). No model credentials are needed for this test.
