# Configurable Port and Security Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add non-persistent port overrides, close browser-to-local-service request attacks, harden the embedded UI, and publish a Linux x64 baseline build with auditable verification.

**Architecture:** Keep file configuration as the persisted source, then apply a small pure startup-options parser before server creation. Put browser provenance enforcement and security response construction in focused server helpers so every route crosses the same boundary. Preserve the single-file UI and artifact names while injecting a per-response CSP nonce and selecting Bun's baseline Linux x64 compile target.

**Tech Stack:** TypeScript 5.7, Bun runtime/test runner/compiler, Zod 4, native Fetch API, GitHub Actions, Docker compatibility probes.

## Global Constraints

- Effective port precedence is `--port` > `AIHUB_AUTO_PORT` > `config.json` > `8787`.
- Startup port overrides accept only base-10 integers from 1 through 65535 and never rewrite `config.json`.
- Requests without browser provenance headers remain compatible with SDKs, CLI clients, health checks, and reverse proxies.
- Non-loopback listeners still require both `proxyToken` and `uiPassword`.
- UI secrets remain in page memory only and are never stored in Web Storage.
- Linux x64 keeps the artifact name `aihub-auto-linux-x64.zip` and uses Bun's baseline CPU target.
- Docker checks establish old userland compatibility only, not an old kernel guarantee.
- Do not force an incompatible transitive `file-type` major upgrade into the Koishi development dependency chain.

---

## File Map

- Create `apps/router/src/startup.ts`: pure CLI/environment parsing, help text, and effective port application.
- Create `apps/router/tests/startup.test.ts`: startup parser and precedence tests.
- Modify `apps/router/src/main.ts`: handle help/errors before credentials and apply the effective port.
- Modify `apps/router/src/server.ts`: browser request boundary and security response headers.
- Modify `apps/router/src/ui.ts`: nonce placeholders and in-memory-only console password.
- Modify `apps/router/tests/integration.test.ts`: browser boundary and UI header regressions.
- Modify `scripts/build.ts`: baseline Linux x64 target.
- Modify `README.md` and `apps/router/README.md`: port override and compatibility documentation.
- Create `security_best_practices_report.md`: evidence-based vulnerability report and residual dependency risk.

### Task 1: Startup Port Overrides

**Files:**
- Create: `apps/router/src/startup.ts`
- Create: `apps/router/tests/startup.test.ts`
- Modify: `apps/router/src/main.ts`

**Interfaces:**
- Produces: `parseStartupOptions(args: string[], env: Record<string, string | undefined>): StartupOptions`.
- Produces: `applyStartupOptions(config: AppConfig, options: StartupOptions): AppConfig`.
- Produces: `STARTUP_HELP: string`.
- `StartupOptions` is `{ port?: number; help: boolean }`.

- [ ] **Step 1: Write failing parser and precedence tests**

Create `apps/router/tests/startup.test.ts` with table-driven coverage:

```ts
import { describe, expect, test } from "bun:test";
import { ConfigSchema } from "../src/config.ts";
import {
	applyStartupOptions,
	parseStartupOptions,
	STARTUP_HELP,
} from "../src/startup.ts";

describe("startup options", () => {
	test.each([
		[["--port", "9000"], {}, 9000],
		[["--port=9001"], {}, 9001],
		[[], { AIHUB_AUTO_PORT: "9002" }, 9002],
		[["--port", "9003"], { AIHUB_AUTO_PORT: "9004" }, 9003],
	] as const)("args=%j env=%j selects %i", (args, env, port) => {
		expect(parseStartupOptions([...args], env).port).toBe(port);
	});

	test.each(["0", "65536", "1.5", " 9000", "9000 ", "+9000", "09x"])(
		"rejects invalid environment port %s",
		(value) => {
			expect(() => parseStartupOptions([], { AIHUB_AUTO_PORT: value })).toThrow(
				/AIHUB_AUTO_PORT.*1.*65535/,
			);
		},
	);

	test.each([
		["missing value", ["--port"]],
		["duplicate", ["--port=9000", "--port", "9001"]],
		["unknown", ["--listen", "9000"]],
	] as const)("rejects %s", (_name, args) => {
		expect(() => parseStartupOptions([...args], {})).toThrow();
	});

	test("help does not require a port and describes precedence", () => {
		expect(parseStartupOptions(["--help"], {}).help).toBe(true);
		expect(STARTUP_HELP).toContain("--port");
		expect(STARTUP_HELP).toContain("AIHUB_AUTO_PORT");
	});

	test("override changes memory but leaves the loaded object unchanged", () => {
		const loaded = ConfigSchema.parse({ listen: { port: 8123 } });
		const effective = applyStartupOptions(loaded, { help: false, port: 9123 });
		expect(effective.listen.port).toBe(9123);
		expect(loaded.listen.port).toBe(8123);
	});
});
```

- [ ] **Step 2: Run the focused test and verify it fails**

Run: `bun test apps/router/tests/startup.test.ts`

Expected: FAIL because `../src/startup.ts` does not exist.

- [ ] **Step 3: Implement the pure startup parser**

Create `apps/router/src/startup.ts` with exact decimal validation, duplicate and unknown argument rejection, CLI-over-environment precedence, an exported help string, and a structural copy of `config.listen` in `applyStartupOptions`. Use this validation shape:

```ts
const PORT_PATTERN = /^(?:[1-9]\d{0,3}|[1-5]\d{4}|6[0-4]\d{3}|65[0-4]\d{2}|655[0-2]\d|6553[0-5])$/;

function parsePort(value: string, source: string): number {
	if (!PORT_PATTERN.test(value)) {
		throw new Error(`${source} 必须是 1 到 65535 的十进制整数`);
	}
	return Number(value);
}
```

Parse only `--help`, `-h`, `--port VALUE`, and `--port=VALUE`. Reject a second port occurrence and every other argument. Parse `AIHUB_AUTO_PORT` only when CLI did not provide a port.

- [ ] **Step 4: Wire startup handling before credential loading**

In `apps/router/src/main.ts`, call `parseStartupOptions(process.argv.slice(2), process.env)` before `configDir()`. Print `STARTUP_HELP` and return when `help` is true. Load file configuration, derive `config` with `applyStartupOptions`, then proceed unchanged. Let parser errors reach the existing top-level startup error handler without printing secrets.

- [ ] **Step 5: Run focused and full static tests**

Run: `bun test apps/router/tests/startup.test.ts && bunx tsc --noEmit -p tsconfig.json`

Expected: all startup tests PASS and TypeScript exits 0.

- [ ] **Step 6: Commit startup overrides**

```bash
git add apps/router/src/startup.ts apps/router/src/main.ts apps/router/tests/startup.test.ts
git commit -m "feat: add startup port overrides"
```

### Task 2: Browser Request Boundary

**Files:**
- Modify: `apps/router/src/server.ts`
- Modify: `apps/router/tests/integration.test.ts`

**Interfaces:**
- Produces: `browserRequestProblem(req: Request, config: AppConfig): { status: 403 | 421; error: string } | undefined`.
- Consumes: existing `AppConfig.listen.host` and the request URL generated by Bun.

- [ ] **Step 1: Add failing integration tests for Host and browser provenance**

Append a `describe("浏览器请求边界", ...)` block to `apps/router/tests/integration.test.ts`. Start a harness server and assert:

```ts
const base = h.serverUrl!;
expect((await fetch(`${base}/healthz`)).status).toBe(200);
expect(
	(await fetch(`${base}/healthz`, { headers: { Origin: base } })).status,
).toBe(200);
expect(
	(await fetch(`${base}/ctl/status`, {
		headers: { Origin: "https://attacker.example" },
	})).status,
).toBe(403);
expect(
	(await fetch(`${base}/ctl/status`, { headers: { Origin: "null" } })).status,
).toBe(403);
expect(
	(await fetch(`${base}/v1/models`, {
		headers: { "Sec-Fetch-Site": "cross-site" },
	})).status,
).toBe(403);
```

Test Host validation without making external DNS requests by exporting and calling `browserRequestProblem` with `new Request("http://attacker.example/ctl/status")` while the configured listener host is `127.0.0.1`; expect status 421. Also assert `localhost`, `127.0.0.1`, and `[::1]` are accepted for loopback configs.

- [ ] **Step 2: Run the focused integration suite and verify failure**

Run: `bun test apps/router/tests/integration.test.ts --test-name-pattern "浏览器请求边界"`

Expected: FAIL because cross-origin and rebound-host requests are currently accepted and the helper is absent.

- [ ] **Step 3: Implement the request guard**

In `apps/router/src/server.ts`, add exact normalized hostname checks and origin comparison:

```ts
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "localhost"]);

export function browserRequestProblem(
	req: Request,
	config: AppConfig,
): { status: 403 | 421; error: string } | undefined {
	const url = new URL(req.url);
	if (LOOPBACK_HOSTS.has(config.listen.host.toLowerCase()) &&
		!LOOPBACK_HOSTS.has(url.hostname.toLowerCase())) {
		return { status: 421, error: "请求主机与本机监听地址不匹配" };
	}
	const origin = req.headers.get("origin");
	if (origin !== null && origin !== url.origin) {
		return { status: 403, error: "拒绝跨站浏览器请求" };
	}
	if (req.headers.get("sec-fetch-site")?.toLowerCase() === "cross-site") {
		return { status: 403, error: "拒绝跨站浏览器请求" };
	}
	return undefined;
}
```

Invoke it at the start of `createServer().fetch`, after URL parsing but before route dispatch. Return the JSON error immediately.

- [ ] **Step 4: Run integration and proxy regressions**

Run: `bun test apps/router/tests/integration.test.ts apps/router/tests/proxy.test.ts`

Expected: all tests PASS; existing SDK-like requests without `Origin` remain accepted.

- [ ] **Step 5: Commit the request boundary**

```bash
git add apps/router/src/server.ts apps/router/tests/integration.test.ts
git commit -m "fix: block cross-site access to local router"
```

### Task 3: Embedded Console Security Headers and Secret Lifetime

**Files:**
- Modify: `apps/router/src/ui.ts`
- Modify: `apps/router/src/server.ts`
- Modify: `apps/router/tests/integration.test.ts`

**Interfaces:**
- Changes: `renderUi(nonce: string): string` replaces exported static `UI_HTML` consumption.
- Produces: a per-response CSP whose nonce appears on both embedded style and script tags.

- [ ] **Step 1: Add failing UI security assertions**

Extend the existing UI integration test:

```ts
const ui = await fetch(`${base}/ui`);
const html = await ui.text();
const csp = ui.headers.get("content-security-policy") ?? "";
const nonce = /script-src 'nonce-([^']+)'/.exec(csp)?.[1];
expect(nonce).toBeTruthy();
expect(csp).toContain("frame-ancestors 'none'");
expect(csp).not.toContain("'unsafe-inline'");
expect(html).toContain(`<style nonce="${nonce}">`);
expect(html).toContain(`<script nonce="${nonce}">`);
expect(ui.headers.get("cache-control")).toBe("no-store");
expect(ui.headers.get("x-content-type-options")).toBe("nosniff");
expect(ui.headers.get("referrer-policy")).toBe("no-referrer");
expect(html).not.toContain("localStorage");
expect(html).not.toContain("sessionStorage");
```

Assert a `/ctl/status` response also has `Cache-Control: no-store`.

- [ ] **Step 2: Run the focused UI test and verify failure**

Run: `bun test apps/router/tests/integration.test.ts --test-name-pattern "uiPassword"`

Expected: FAIL because the UI has no CSP/security headers and contains `localStorage`.

- [ ] **Step 3: Render the UI with a nonce and remove persistent password storage**

Change `apps/router/src/ui.ts` to export `renderUi(nonce: string)`. Validate the nonce before interpolation with `/^[A-Za-z0-9_-]+$/`; throw on invalid input. Add `nonce="${nonce}"` to the existing top-level style and script tags. Initialize `uiPass` to an empty string, retain it only in the closure, and remove both `localStorage.getItem` and `localStorage.setItem`.

- [ ] **Step 4: Add security headers centrally**

In `apps/router/src/server.ts`, generate `crypto.randomUUID().replaceAll("-", "")` for every UI response. Build the CSP from the same nonce and set `Content-Type`, `Content-Security-Policy`, `Cache-Control`, `X-Content-Type-Options`, and `Referrer-Policy`. Update the JSON helper to default to `Cache-Control: no-store` so credentials, status, and error responses are not cached.

- [ ] **Step 5: Run UI integration and type checks**

Run: `bun test apps/router/tests/integration.test.ts && bunx tsc --noEmit -p tsconfig.json`

Expected: all integration tests PASS and TypeScript exits 0.

- [ ] **Step 6: Commit UI hardening**

```bash
git add apps/router/src/ui.ts apps/router/src/server.ts apps/router/tests/integration.test.ts
git commit -m "fix: harden embedded operations console"
```

### Task 4: Linux Baseline Build and Operator Documentation

**Files:**
- Modify: `scripts/build.ts`
- Modify: `README.md`
- Modify: `apps/router/README.md`

**Interfaces:**
- Changes only the compile target for the existing Linux x64 artifact.
- Documents all effective port inputs and precedence without changing file schema.

- [ ] **Step 1: Change the x64 compile target**

In `scripts/build.ts`, replace only:

```ts
{ target: "bun-linux-x64", os: "linux", arch: "x64", bin: "aihub-auto" },
```

with:

```ts
{
	target: "bun-linux-x64-baseline",
	os: "linux",
	arch: "x64",
	bin: "aihub-auto",
},
```

- [ ] **Step 2: Document port overrides and compatibility accurately**

Add runnable examples to both READMEs:

```bash
AIHUB_AUTO_PORT=9000 ./aihub-auto
./aihub-auto --port 9000
```

State the exact precedence and that CLI/environment overrides are not persisted. State that Linux x64 uses Bun's baseline CPU target. Describe Docker test results as old userland validation, not old kernel validation.

- [ ] **Step 3: Build the Linux x64 artifact**

Run: `bun scripts/build.ts linux-x64`

Expected: `artifacts/aihub-auto-linux-x64.zip` exists and contains `aihub-auto` plus `README.md`.

- [ ] **Step 4: Smoke-test help and a non-default port locally**

Extract the binary, run `./aihub-auto --help`, then launch it with a temporary `AIHUB_AUTO_CONFIG_DIR` and `--port 19090`. Poll `http://127.0.0.1:19090/healthz`, expect HTTP 200, and terminate the process cleanly.

- [ ] **Step 5: Commit build and documentation**

```bash
git add scripts/build.ts README.md apps/router/README.md
git commit -m "build: support baseline Linux and port overrides"
```

### Task 5: Security Report and Full Verification

**Files:**
- Create: `security_best_practices_report.md`
- Modify if verification reveals defects: only files already listed in Tasks 1-4 and their tests.

**Interfaces:**
- Produces an evidence-based report with IDs, severities, exact final line numbers, fixes, and residual risks.

- [ ] **Step 1: Write the security report from final code locations**

Create `security_best_practices_report.md` with these findings and final line references:

- `AAH-SEC-001` High: browser-to-loopback control access through DNS rebinding/cross-origin requests; fixed by the unified request boundary.
- `AAH-SEC-002` Medium: console password persisted in Web Storage; fixed by memory-only lifetime.
- `AAH-SEC-003` Medium: embedded credential console lacked CSP, framing restriction, cache prevention, MIME sniff prevention, and referrer policy; fixed by nonce-based response headers.
- `AAH-DEP-001` Low residual: `file-type@16.5.4` moderate ASF parser DoS in Koishi development/test dependencies, not imported into the standalone router; upstream major-version remediation required.

For every issue include Rule ID, Severity, Location, Evidence, Impact, Fix, Mitigation, and False-positive/residual-risk notes. Do not include credentials or scanner request bodies.

- [ ] **Step 2: Run the complete local acceptance suite**

Run: `bun install --frozen-lockfile && bun test && bunx tsc --noEmit -p tsconfig.json && bun scripts/build.ts linux-x64`

Expected: install, all tests, type checking, and build exit 0.

- [ ] **Step 3: Re-run exact lockfile vulnerability lookup**

Parse every exact npm package/version from `bun.lock`, submit batch queries to `https://api.osv.dev/v1/querybatch`, and record the query date, package count, and advisory IDs in the report.

Expected: only `GHSA-5v7r-6r5c-r473` is reported, or the report is updated to include any newly returned advisory.

- [ ] **Step 4: Verify on the supplied Docker host**

Copy only the built Linux x64 binary to a new temporary directory on `192.168.3.16`. For each available target image, bind-mount the binary read-only and run `--help`; then run a short-lived container with a writable temporary config directory, `--port 19090`, and a health request from inside the container. Record image digest, libc/userland version, and outcome. Remove the remote temporary directory and stopped test containers after collecting results.

Expected: Debian 10 and CentOS 7 results are explicitly recorded; Alpine is explicitly recorded as supported or unsupported. Image retrieval failure is recorded, not treated as a code pass.

- [ ] **Step 5: Inspect the complete diff and run hygiene checks**

Run:

```bash
git diff origin/main...HEAD --check
git status --short
git log --oneline --decorate origin/main..HEAD
```

Expected: no whitespace errors, no generated artifacts or secrets tracked, and only intended source/docs/test changes remain.

- [ ] **Step 6: Commit the report and any verification corrections**

```bash
git add security_best_practices_report.md
git commit -m "docs: add security audit report"
```

### Task 6: Publish the Pull Request

**Files:**
- No repository file changes expected.

**Interfaces:**
- Produces a pushed topic branch and a PR targeting `WSXYT/aihub-auto:main`.

- [ ] **Step 1: Rebase-check against the current upstream head**

Run: `git fetch origin main && git merge-base --is-ancestor origin/main HEAD`

Expected: exit 0. If upstream advanced, rebase the topic branch non-interactively, resolve only task-related conflicts, and re-run Task 5 acceptance checks.

- [ ] **Step 2: Push the topic branch**

Run: `git push -u origin codex/configurable-port-security-hardening`

Expected: push succeeds. If direct branch push is forbidden, create a fork under the authenticated GitHub account, add it as `fork`, and push the same branch there.

- [ ] **Step 3: Create the PR through GitHub's API or CLI**

Use title `feat: add configurable port and harden local router security`. The body must summarize port precedence, security fixes, Linux baseline build, all local/remote verification results, and the residual development-only `file-type` advisory. Target `main` and use the pushed topic branch as head.

- [ ] **Step 4: Verify the PR exists and report its URL**

Query the created PR and confirm it is open, targets `WSXYT/aihub-auto:main`, and contains the final commit. Record the PR URL for handoff.
