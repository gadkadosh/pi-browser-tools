import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";

process.env.PI_OFFLINE = "1";
const sdkUrl = process.env.PI_PACKAGE_DIR
	? pathToFileURL(path.join(process.env.PI_PACKAGE_DIR, "dist/index.js")).href
	: import.meta.resolve("@earendil-works/pi-coding-agent");
const { createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager } = await import(sdkUrl);

test("real Pi browser_eval handles expressions and invokes functions once", { timeout: 60_000 }, async (t) => {
	const cwd = await mkdtemp(path.join(tmpdir(), "browser-eval-test-"));
	t.after(() => rm(cwd, { recursive: true, force: true }));
	const settingsManager = SettingsManager.inMemory();
	const loader = new DefaultResourceLoader({
		cwd, agentDir: path.join(cwd, "agent"), settingsManager,
		noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
		additionalExtensionPaths: [fileURLToPath(new URL("../index.ts", import.meta.url))],
	});
	await loader.reload();
	assert.deepEqual(loader.getExtensions().errors, []);
	const { session } = await createAgentSession({
		cwd, agentDir: path.join(cwd, "agent"), settingsManager, resourceLoader: loader,
		sessionManager: SessionManager.inMemory(cwd), noTools: "builtin",
	});
	const call = (name, args = {}) => {
		const tool = session.agent.state.tools.find((tool) => tool.name === name);
		assert.ok(tool, `${name} must be available through Pi`);
		return tool.execute(`test-${name}`, args);
	};
	t.after(async () => {
		await call("browser_close");
		session.dispose();
	});

	await assert.rejects(call("browser_eval", { script: "1 + 2" }), /browser_open first/);
	await call("browser_open", { url: "data:text/html,<title>Eval fixture</title><main>Browser content</main>" });

	const expected = { title: "Eval fixture", text: "Browser content" };
	const object = "({title: document.title, text: document.querySelector('main').textContent})";
	for (const [name, script, value] of [
		["plain expression", "document.title", "Eval fixture"],
		["parenthesized object", object, expected],
		["parenthesized arithmetic", "(1 + 2)", 3],
		["array expression", "[document.title, 42]", ["Eval fixture", 42]],
		["arrow function", `() => ${object}`, expected],
		["parenthesized arrow function", `(() => ${object})`, expected],
		["single-parameter arrow function", "unused => document.title", "Eval fixture"],
		["regular function", `function () { return ${object}; }`, expected],
		["async arrow function", `async () => { await Promise.resolve(); return ${object}; }`, expected],
		["async regular function", `async function () { return ${object}; }`, expected],
		["already-invoked function", `(() => ${object})()`, expected],
		["already-invoked async function", `(async () => ${object})()`, expected],
		["promise expression", `Promise.resolve(${object})`, expected],
		["null", "null", null],
		["undefined", "undefined", undefined],
		["trailing comment", `${object} // comment`, expected],
	]) {
		await t.test(name, async () => {
			const result = await call("browser_eval", { script });
			assert.deepEqual(result.details.result, value);
			assert.equal(result.content[0].text, JSON.stringify(value, null, 2) ?? "undefined");
		});
	}

	await t.test("side effects are not repeated, even when evaluation throws", async () => {
		const result = await call("browser_eval", {
			script: "(() => { window.evalCount = (window.evalCount ?? 0) + 1; return {count: window.evalCount}; })()",
		});
		assert.deepEqual(result.details.result, { count: 1 });
		await assert.rejects(call("browser_eval", {
			script: "() => { window.evalCount++; throw new Error('intentional failure'); }",
		}), /intentional failure/);
		assert.equal((await call("browser_eval", { script: "window.evalCount" })).details.result, 2);
		await assert.rejects(call("browser_eval", { script: "({broken:" }), /SyntaxError/);
	});

	await call("browser_close");
	await assert.rejects(call("browser_eval", { script: "1 + 2" }), /browser_open first/);
});
