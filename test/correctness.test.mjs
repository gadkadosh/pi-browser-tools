import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { findPackageJSON } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";

process.env.PI_OFFLINE = "1";
const sdkUrl = process.env.PI_PACKAGE_DIR
	? pathToFileURL(path.join(process.env.PI_PACKAGE_DIR, "dist/index.js")).href
	: import.meta.resolve("@earendil-works/pi-coding-agent");
const { createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager } = await import(sdkUrl);
const { createAssistantMessageEventStream, Type } = await import(
	pathToFileURL(path.join(path.dirname(findPackageJSON("@earendil-works/pi-ai", sdkUrl)), "dist/index.js")).href
);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function fixture(t, extensionFactories = []) {
	const cwd = await mkdtemp(path.join(tmpdir(), "browser-correctness-test-"));
	t.after(() => rm(cwd, { recursive: true, force: true }));
	const server = createServer((request, response) => {
		response.setHeader("Content-Type", "text/html");
		response.end(`<!doctype html><title>${request.url}</title>
			<style>body { background: #142d4e; color: white; }</style>
			<section id="first"><button class="action" onclick="window.clicked.push('first')">Save</button>
			<input class="field" value="first"></section>
			<section id="second"><button class="action" onclick="window.clicked.push('second')">Save</button>
			<input class="field" value="second"></section>
			<button class="optional" hidden>Continue</button>
			<button class="optional" onclick="window.clicked.push('visible')">Continue</button>
			<script>window.clicked = [];</script>`);
	});
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	t.after(() => new Promise((resolve) => server.close(resolve)));

	const settingsManager = SettingsManager.inMemory();
	const loader = new DefaultResourceLoader({
		cwd, agentDir: path.join(cwd, "agent"), settingsManager,
		noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
		additionalExtensionPaths: [fileURLToPath(new URL("../index.ts", import.meta.url))],
		extensionFactories,
	});
	await loader.reload();
	assert.deepEqual(loader.getExtensions().errors, []);
	// Only model responses are scripted. Pi's scheduler, tool wrappers, and browser operations are real.
	const { session } = await createAgentSession({
		cwd, agentDir: path.join(cwd, "agent"), settingsManager, resourceLoader: loader,
		sessionManager: SessionManager.inMemory(cwd), noTools: "builtin",
		model: {
			id: "browser-test", name: "Browser test", api: "openai-responses", provider: "browser-test",
			baseUrl: "http://127.0.0.1", reasoning: false, input: ["text", "image"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 4096,
		},
	});
	const errors = [];
	await session.bindExtensions({ onError: (error) => errors.push(error) });
	const call = (name, args = {}) => session.agent.state.tools.find((tool) => tool.name === name).execute(`test-${name}`, args);
	const evaluate = async (script) => (await call("browser_eval", { script })).details.result;
	t.after(async () => {
		await call("browser_close");
		session.dispose();
		assert.deepEqual(errors, []);
	});

	let batchId = 0;
	async function batch(calls) {
		const id = `batch-${batchId++}`;
		const content = calls.map(([name, args = {}], i) => ({ type: "toolCall", id: `${id}-${i}`, name, arguments: args }));
		let responses = 0;
		session.agent.streamFunction = (model) => {
			assert.ok(responses < 2, "one tool batch and one final response are expected");
			const isBatch = responses++ === 0;
			const message = {
				role: "assistant", content: isBatch ? content : [{ type: "text", text: "Done" }],
				api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(),
				stopReason: isBatch ? "toolUse" : "stop",
				usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
			};
			const stream = createAssistantMessageEventStream();
			stream.push({ type: "done", reason: message.stopReason, message });
			stream.end();
			return stream;
		};
		await session.agent.prompt("Execute the local fixture tool batch.");
		assert.equal(responses, 2);
		const results = session.messages.filter((message) => message.role === "toolResult" && message.toolCallId.startsWith(`${id}-`));
		assert.equal(results.length, calls.length);
		return results;
	}
	return { cwd, session, call, evaluate, batch, url: `http://127.0.0.1:${server.address().port}` };
}

test("Pi schedules shared-page tools in order without disabling unrelated parallel batches", { timeout: 60_000 }, async (t) => {
	let active = 0;
	let maxActive = 0;
	const { cwd, session, call, evaluate, batch, url } = await fixture(t, [(pi) => {
		pi.registerTool({
			name: "fixture_parallel", label: "Fixture parallel", description: "Local scheduler probe", parameters: Type.Object({}),
			async execute() {
				maxActive = Math.max(maxActive, ++active);
				await sleep(50);
				active--;
				return { content: [{ type: "text", text: "completed" }], details: { completed: true } };
			},
		});
	}]);
	await call("browser_open", { url: `${url}/before` });
	const events = [];
	const unsubscribe = session.subscribe((event) => {
		if (event.type === "tool_execution_start" || event.type === "tool_execution_end") {
			events.push(`${event.type}:${event.toolCallId}`);
		}
	});
	t.after(unsubscribe);
	const calls = [
		["browser_eval", { script: "async () => { await new Promise(r => setTimeout(r, 150)); return document.title; }" }],
		["browser_open", { url: `${url}/after`, width: 800, height: 600 }],
		["browser_eval", { script: "document.title" }],
		["browser_click", { selector: "#second button" }],
		["browser_type", { selector: "#second input", text: "updated" }],
		["browser_eval", { script: "({clicked: window.clicked, values: [...document.querySelectorAll('input')].map(x => x.value)})" }],
		["browser_screenshot", { path: "ordered.png", fullPage: false }],
		["browser_close"],
	];
	const results = await batch(calls);
	assert.deepEqual(results.map((result) => result.isError), calls.map(() => false));
	assert.equal(results[0].details.result, "/before", "evaluation must finish before navigation destroys its page context");
	assert.equal(results[1].details.url, `${url}/after`);
	assert.equal(results[2].details.result, "/after");
	assert.deepEqual(results[5].details.result, { clicked: ["second"], values: ["first", "updated"] });
	assert.deepEqual(events, results.flatMap((result) => [
		`tool_execution_start:${result.toolCallId}`, `tool_execution_end:${result.toolCallId}`,
	]));
	const original = await readFile(path.join(cwd, "ordered.png"));
	assert.deepEqual([...original.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
	assert.deepEqual([original.readUInt32BE(16), original.readUInt32BE(20)], [800, 600]);
	const image = results[6].content.find((block) => block.type === "image");
	assert.equal(image.mimeType, "image/png");
	assert.deepEqual(Buffer.from(image.data, "base64"), original);
	await assert.rejects(evaluate("document.title"), /browser_open first/);
	// Cover each declaration too: a mixed batch would be serialized even if only one tool opted in.
	for (const tool of session.agent.state.tools.filter((tool) => tool.name.startsWith("browser_"))) {
		assert.equal(tool.executionMode, "sequential", tool.name);
	}
	const parallel = await batch([["fixture_parallel"], ["fixture_parallel"]]);
	assert.deepEqual(parallel.map((result) => result.details), [{ completed: true }, { completed: true }]);
	assert.equal(maxActive, 2, "non-browser-only batches must still execute concurrently");
});

test("launch mode is fixed until close/reset/shutdown, and rejected changes preserve page state", { timeout: 60_000 }, async (t) => {
	const { session, call, evaluate, url } = await fixture(t);
	const state = "({url: location.href, width: innerWidth, height: innerHeight, marker: window.marker, stored: sessionStorage.getItem('mode'), headless: navigator.userAgent.includes('HeadlessChrome')})";
	for (const headless of [true, false]) {
		await t.test(headless ? "headless browser" : "headed browser", async () => {
			await call("browser_open", { url: `${url}/mode`, headless, width: 1200, height: 800 });
			await evaluate("() => { window.marker = 'unchanged'; sessionStorage.setItem('mode', 'preserved'); }");
			const before = await evaluate(state);
			assert.equal(before.headless, headless, "verify actual Chromium mode, not merely the selected option");
			await assert.rejects(call("browser_open", {
				url: `${url}/must-not-navigate`, headless: !headless, width: 390, height: 844,
			}), /browser_close.*browser-reset/);
			assert.deepEqual(await evaluate(state), before, "rejected requests must not navigate, resize, or discard state");
			for (const options of [{ headless }, {}]) {
				const result = await call("browser_open", { url: `${url}/compatible`, ...options });
				assert.equal(result.details.url, `${url}/compatible`);
				const current = await evaluate(state);
				assert.equal(current.headless, headless);
				assert.equal(current.stored, "preserved");
			}
			await call("browser_close");
			await call("browser_close");
		});
	}
	for (const cleanup of [
		() => session.prompt("/browser-reset"),
		() => session.extensionRunner.emit({ type: "session_shutdown" }),
	]) {
		await call("browser_open", { url, headless: false });
		await cleanup();
		await cleanup();
		await assert.rejects(evaluate("document.title"), /browser_open first/);
		await call("browser_open", { url });
		assert.equal(await evaluate("navigator.userAgent.includes('HeadlessChrome')"), true);
		await call("browser_close");
	}
});

test("click and fill reject ambiguous selectors without side effects and retain explicit narrowing", { timeout: 60_000 }, async (t) => {
	const { call, evaluate, url } = await fixture(t);
	await assert.rejects(call("browser_click", { selector: ".action" }), /browser_open first/);
	await assert.rejects(call("browser_type", { selector: ".field", text: "wrong" }), /browser_open first/);
	await call("browser_open", { url });
	const state = "({clicked: window.clicked, values: [...document.querySelectorAll('input')].map(x => x.value)})";
	const before = { clicked: [], values: ["first", "second"] };
	assert.deepEqual(await evaluate(state), before);
	await assert.rejects(call("browser_click", { selector: ".action" }), /strict mode violation/);
	assert.deepEqual(await evaluate(state), before);
	await assert.rejects(call("browser_type", { selector: ".field", text: "wrong" }), /strict mode violation/);
	assert.deepEqual(await evaluate(state), before);
	await call("browser_click", { selector: "#second .action" });
	await call("browser_type", { selector: "#second .field", text: "updated" });
	assert.deepEqual(await evaluate(state), { clicked: ["second"], values: ["first", "updated"] });
	await call("browser_click", { selector: ".action >> nth=0" });
	await call("browser_type", { selector: ".field >> nth=0", text: "chosen" });
	await call("browser_click", { selector: ".optional:visible" });
	assert.deepEqual(await evaluate(state), { clicked: ["second", "first", "visible"], values: ["chosen", "updated"] });
});
