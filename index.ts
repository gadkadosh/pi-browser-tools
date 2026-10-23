import path from "node:path";
import type { Browser, BrowserContext, Page } from "playwright";
import { chromium } from "playwright";
import { detectSupportedImageMimeTypeFromFile, resizeImage, type ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@mariozechner/pi-ai";

export default function browserToolsExtension(pi: ExtensionAPI) {
	let browser: Browser | undefined;
	let launchHeadless: boolean | undefined;
	let context: BrowserContext | undefined;
	let page: Page | undefined;
	let currentUrl: string | undefined;

	async function ensurePage(options?: {
		width?: number;
		height?: number;
		headless?: boolean;
	}) {
		const width = options?.width ?? 1440;
		const height = options?.height ?? 900;
		const headless = options?.headless ?? true;

		if (!browser?.isConnected()) {
			browser = await chromium.launch({ headless });
			launchHeadless = headless;
			context = undefined;
			page = undefined;
		} else if (options?.headless !== undefined && options.headless !== launchHeadless) {
			throw new Error(`Browser is already running ${launchHeadless ? "headless" : "headed"}. Call browser_close or /browser-reset before changing headless mode.`);
		}

		if (!context) {
			context = await browser.newContext();
		}

		if (!page || page.isClosed()) {
			page = await context.newPage();
		}

		await page.setViewportSize({ width, height });
		return page;
	}

	function requirePage() {
		if (!page || page.isClosed()) {
			throw new Error("No active browser page. Call browser_open first.");
		}
		return page;
	}

	function resolveOutputPath(cwd: string, outputPath: string) {
		return path.isAbsolute(outputPath) ? outputPath : path.resolve(cwd, outputPath);
	}

	pi.registerTool({
		name: "browser_open",
		executionMode: "sequential",
		label: "Browser Open",
		description: "Open a URL in a Playwright browser page and keep it available for later browser tools.",
		promptSnippet: "Open a page for visual inspection and future screenshots.",
		promptGuidelines: ["Use browser_open before browser_screenshot, browser_eval, browser_click, or browser_type when no page is active."],
		parameters: Type.Object({
			url: Type.String({ description: "URL to open" }),
			width: Type.Optional(Type.Number({ description: "Viewport width in pixels" })),
			height: Type.Optional(Type.Number({ description: "Viewport height in pixels" })),
			headless: Type.Optional(Type.Boolean({ description: "Startup mode (default true). Omit to keep an active browser's mode; close/reset before explicitly changing it." })),
			waitUntil: Type.Optional(
				Type.Union([
					Type.Literal("load"),
					Type.Literal("domcontentloaded"),
					Type.Literal("networkidle"),
				]),
			),
			waitForSelector: Type.Optional(Type.String({ description: "Optional selector to wait for after navigation" })),
		}),
		async execute(_toolCallId, params) {
			const p = await ensurePage(params);
			const response = await p.goto(params.url, { waitUntil: params.waitUntil ?? "load" });
			if (params.waitForSelector) {
				await p.waitForSelector(params.waitForSelector);
			}
			currentUrl = p.url();
			const status = response?.status() ?? null;
			const title = await p.title();
			return {
				content: [{
					type: "text",
					text: `${status === null ? "No HTTP response" : `HTTP ${status}`}\nURL: ${currentUrl}\nTitle: ${title}`,
				}],
				details: { url: currentUrl, title, status },
				isError: status !== null && status >= 400,
			};
		},
	});

	pi.registerTool({
		name: "browser_screenshot",
		executionMode: "sequential",
		label: "Browser Screenshot",
		description: "Save a screenshot of the current page or an element at full resolution and return its path plus an image preview (at most 2000×2000 pixels, aspect ratio preserved).",
		promptSnippet: "Save a screenshot and inspect its returned image directly.",
		promptGuidelines: ["Use browser_screenshot to capture before/after UI changes on the currently open page. Its result includes an image; no separate read call is needed."],
		parameters: Type.Object({
			path: Type.String({ description: "Output path for the PNG screenshot" }),
			fullPage: Type.Optional(Type.Boolean({ description: "Capture the full page" })),
			selector: Type.Optional(Type.String({ description: "Optional selector for element-only screenshot" })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const p = requirePage();
			const outputPath = resolveOutputPath(ctx.cwd, params.path);
			const screenshot = params.selector
				? await p.locator(params.selector).screenshot({ path: outputPath })
				: await p.screenshot({ path: outputPath, fullPage: params.fullPage ?? true });
			// Bound only the model-facing preview; Playwright has already saved the original.
			const preview = await resizeImage(
				screenshot,
				await detectSupportedImageMimeTypeFromFile(outputPath) ?? "image/png",
				{ maxWidth: 2000, maxHeight: 2000, maxBytes: 4.5 * 1024 * 1024 },
			);
			if (!preview) {
				throw new Error(`Saved screenshot to ${outputPath}, but could not create a bounded image preview.`);
			}
			const originalSize = `${preview.originalWidth}×${preview.originalHeight}`;
			const previewSize = `${preview.width}×${preview.height}`;
			return {
				content: [
					{ type: "text", text: `Saved screenshot to ${outputPath} (${originalSize}, full resolution).\n${preview.wasResized ? `Returned preview resized/re-encoded to ${previewSize}; saved file is unchanged.` : `Returned image: ${previewSize}.`}` },
					{ type: "image", data: preview.data, mimeType: preview.mimeType },
				],
				details: {
					path: outputPath, url: p.url(), selector: params.selector ?? null,
					original: { width: preview.originalWidth, height: preview.originalHeight },
					preview: { width: preview.width, height: preview.height, wasResized: preview.wasResized },
				},
			};
		},
	});

	pi.registerTool({
		name: "browser_eval",
		executionMode: "sequential",
		label: "Browser Eval",
		description: "Run JavaScript in the active browser page and return the result.",
		promptSnippet: "Inspect DOM state or computed styles in the active page.",
		promptGuidelines: ["Use browser_eval to inspect classes, text, computed styles, or browser-side state after opening a page."],
		parameters: Type.Object({
			script: Type.String({
				description:
					"JavaScript expression or function to evaluate in the page. Functions are called once with no arguments; other values are returned directly. Promises are awaited. For multiple statements, use () => { ...; return result; }.",
			}),
		}),
		async execute(_toolCallId, params) {
			const p = requirePage();
			const result = await p.evaluate(`(() => {
				const value = (${params.script}\n);
				return typeof value === "function" ? value() : value;
			})()`);
			return {
				content: [{ type: "text", text: JSON.stringify(result, null, 2) ?? "undefined" }],
				details: { result },
			};
		},
	});

	pi.registerTool({
		name: "browser_click",
		executionMode: "sequential",
		label: "Browser Click",
		description: "Click exactly one matching element in the active page. Ambiguous selectors fail; scope the selector to the intended control.",
		parameters: Type.Object({
			selector: Type.String({ description: "Selector resolving to exactly one intended element to click" }),
		}),
		async execute(_toolCallId, params) {
			const p = requirePage();
			await p.locator(params.selector).click();
			return {
				content: [{ type: "text", text: `Clicked ${params.selector}` }],
				details: { url: p.url(), selector: params.selector },
			};
		},
	});

	pi.registerTool({
		name: "browser_type",
		executionMode: "sequential",
		label: "Browser Type",
		description: "Fill text into exactly one matching input in the active page. Ambiguous selectors fail; scope the selector to the intended control.",
		parameters: Type.Object({
			selector: Type.String({ description: "Selector resolving to exactly one intended input to fill" }),
			text: Type.String({ description: "Text to enter" }),
		}),
		async execute(_toolCallId, params) {
			const p = requirePage();
			await p.locator(params.selector).fill(params.text);
			return {
				content: [{ type: "text", text: `Filled ${params.selector}` }],
				details: { url: p.url(), selector: params.selector, textLength: params.text.length },
			};
		},
	});

	pi.registerTool({
		name: "browser_close",
		executionMode: "sequential",
		label: "Browser Close",
		description: "Close the active Playwright browser and clear browser tool state.",
		parameters: Type.Object({}),
		async execute() {
			await page?.close().catch(() => undefined);
			await context?.close().catch(() => undefined);
			await browser?.close().catch(() => undefined);
			page = undefined;
			context = undefined;
			browser = undefined;
			launchHeadless = undefined;
			currentUrl = undefined;
			return {
				content: [{ type: "text", text: "Closed browser" }],
				details: {},
			};
		},
	});

	pi.registerCommand("browser-status", {
		description: "Show current browser tool state",
		handler: async (_args, ctx) => {
			ctx.ui.notify(
				browser?.isConnected()
					? `Browser ready${currentUrl ? `: ${currentUrl}` : ""}`
					: "Browser not running",
				"info",
			);
		},
	});

	pi.registerCommand("browser-reset", {
		description: "Close and reset the browser tool state",
		handler: async (_args, ctx) => {
			await page?.close().catch(() => undefined);
			await context?.close().catch(() => undefined);
			await browser?.close().catch(() => undefined);
			page = undefined;
			context = undefined;
			browser = undefined;
			launchHeadless = undefined;
			currentUrl = undefined;
			ctx.ui.notify("Browser reset", "info");
		},
	});

	pi.on("session_shutdown", async () => {
		await page?.close().catch(() => undefined);
		await context?.close().catch(() => undefined);
		await browser?.close().catch(() => undefined);
		page = undefined;
		context = undefined;
		browser = undefined;
		launchHeadless = undefined;
		currentUrl = undefined;
	});
}
