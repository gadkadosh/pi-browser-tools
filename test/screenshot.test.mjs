import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";

process.env.PI_OFFLINE = "1";
const sdkUrl = process.env.PI_PACKAGE_DIR
	? pathToFileURL(path.join(process.env.PI_PACKAGE_DIR, "dist/index.js")).href
	: import.meta.resolve("@earendil-works/pi-coding-agent");
const { createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager } = await import(sdkUrl);
const { PhotonImage } = createRequire(sdkUrl)("@silvia-odwyer/photon-node");

function decode(bytes) {
	const image = PhotonImage.new_from_byteslice(bytes);
	try {
		return {
			width: image.get_width(), height: image.get_height(),
			firstPixel: [...image.get_raw_pixels().slice(0, 3)],
		};
	} finally {
		image.free();
	}
}

test("real Pi screenshot tools save originals and return decodable, bounded images", { timeout: 60_000 }, async (t) => {
	const cwd = await mkdtemp(path.join(tmpdir(), "browser-screenshot-test-"));
	t.after(() => rm(cwd, { recursive: true, force: true }));
	const server = createServer((_request, response) => {
		response.setHeader("Content-Type", "text/html");
		response.end(`<!doctype html><title>Screenshot fixture</title>
			<style>
				body { margin: 0; height: 4800px; background: #e9f1ff; }
				header { height: 180px; background: #142d4e; color: white; display: grid; place-items: center; }
				#tile { margin: 40px; width: 320px; height: 160px; background: #e63946; color: white; display: grid; place-items: center; }
			</style>
			<header><h1>Screenshot fixture</h1></header><div id="tile">Element capture</div>
			<script>window.initialViewport = { width: innerWidth, height: innerHeight };</script>`);
	});
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	t.after(() => new Promise((resolve) => server.close(resolve)));

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

	await assert.rejects(call("browser_screenshot", { path: "no-page.png" }), /browser_open first/);
	const url = `http://127.0.0.1:${server.address().port}`;
	await call("browser_open", { url, width: 1200, height: 800 });

	async function capture(args, originalSize, previewSize, firstPixel) {
		const result = await call("browser_screenshot", args);
		const image = result.content.find((block) => block.type === "image");
		const text = result.content.find((block) => block.type === "text").text;
		assert.ok(image?.data, "image must be in Pi's image content block, not text");
		assert.ok(Buffer.byteLength(image.data) < 4.5 * 1024 * 1024);
		const original = await readFile(path.resolve(cwd, args.path));
		const preview = Buffer.from(image.data, "base64");
		const originalDecoded = decode(original);
		const previewDecoded = decode(preview);
		assert.deepEqual([originalDecoded.width, originalDecoded.height], originalSize);
		assert.deepEqual([previewDecoded.width, previewDecoded.height], previewSize);
		const tolerance = args.path.endsWith(".jpg") ? 2 : 0;
		assert.ok(previewDecoded.firstPixel.every((value, index) => Math.abs(value - firstPixel[index]) <= tolerance));
		assert.ok(Math.abs(previewDecoded.width * originalDecoded.height / originalDecoded.width - previewDecoded.height) <= 1,
			"aspect ratio must be preserved within pixel rounding");
		assert.equal(result.details.path, path.resolve(cwd, args.path));
		assert.ok(text.includes(result.details.path));
		if (originalSize.join() === previewSize.join()) {
			assert.deepEqual(preview, original, "small screenshots should be returned unchanged");
			assert.equal(result.details.preview.wasResized, false);
		} else {
			assert.equal(result.details.preview.wasResized, true);
			assert.match(text, /preview resized.*saved file is unchanged/);
			assert.notDeepEqual(preview, original);
		}
		assert.equal(image.mimeType, args.path.endsWith(".jpg") ? "image/jpeg" : "image/png");
	}

	await capture({ path: "nested/viewport.png", fullPage: false }, [1200, 800], [1200, 800], [20, 45, 78]);
	await capture({ path: path.join(cwd, "full.png"), fullPage: true }, [1200, 4800], [500, 2000], [20, 45, 78]);
	await capture({ path: "default-full.png" }, [1200, 4800], [500, 2000], [20, 45, 78]);
	await capture({ path: "element.png", selector: "#tile", fullPage: true }, [320, 160], [320, 160], [230, 57, 70]);
	// JPEG paths already worked through Playwright's type inference; retain their MIME type too.
	await call("browser_eval", { script: "window.scrollTo(0, 0)" });
	await capture({ path: "viewport.jpg", fullPage: false }, [1200, 800], [1200, 800], [20, 45, 78]);
	await call("browser_eval", { script: "document.querySelector('#tile').style.width = '4200px'" });
	await capture({ path: "wide-element.png", selector: "#tile" }, [4200, 160], [2000, 76], [230, 57, 70]);

	await t.test("browser_open resizes the reused page before navigation", async () => {
		await call("browser_eval", { script: "sessionStorage.setItem('viewport-test', 'preserved')" });
		for (const [options, width, height, screenshot] of [
			[{ width: 390, height: 844 }, 390, 844, "mobile.png"],
			[{ width: 1440, height: 900 }, 1440, 900, "desktop.png"],
			[{ width: 390, height: 844 }, 390, 844],
			[{ width: 390, height: 844 }, 390, 844],
			[{ width: 820 }, 820, 900],
			[{ height: 700 }, 1440, 700],
			[{}, 1440, 900],
		]) {
			await call("browser_open", { url, ...options });
			const result = await call("browser_eval", {
				script: "({ initial: window.initialViewport, current: { width: innerWidth, height: innerHeight }, stored: sessionStorage.getItem('viewport-test') })",
			});
			assert.deepEqual(result.details.result, {
				initial: { width, height }, current: { width, height }, stored: "preserved",
			});
			if (screenshot) {
				await capture({ path: screenshot, fullPage: false }, [width, height], [width, height], [20, 45, 78]);
			}
		}
	});
	await call("browser_close");
	await call("browser_close");
	await assert.rejects(call("browser_screenshot", { path: "closed.png" }), /browser_open first/);
});
