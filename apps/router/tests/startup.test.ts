import { describe, expect, test } from "bun:test";
import { applyManagedSecretOverrides, ConfigSchema } from "../src/config.ts";
import { matchesAccountPool } from "../src/daemon.ts";
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
			expect(() =>
				parseStartupOptions([], { AIHUB_AUTO_PORT: value }),
			).toThrow(/AIHUB_AUTO_PORT.*1.*65535/);
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

	test("account pool plans are explicit unions", () => {
		expect(matchesAccountPool("TEAM PLUS 混池", ["plus", "team"], "all")).toBe(true);
		expect(matchesAccountPool("A001-Team/K12", ["team"], "all")).toBe(true);
		expect(matchesAccountPool("A008-BugTeam", ["team"], "all")).toBe(false);
		expect(matchesAccountPool("Pro 专线", ["plus", "team"], "all")).toBe(false);
		expect(matchesAccountPool("任意分组", [], "all")).toBe(true);
		expect(ConfigSchema.parse({ accountPoolPlans: ["team", "plus"] }).accountPoolPlans).toEqual(["team", "plus"]);
	});

	test("managed secrets override persisted router secrets", () => {
		const persisted = ConfigSchema.parse({
			uiPassword: "persisted-console-password",
			proxyToken: "persisted-proxy-token",
		});
		const effective = applyManagedSecretOverrides(persisted, {
			AIHUB_AUTO_HOST: "0.0.0.0",
			AIHUB_AUTO_UI_PASSWORD: "managed-console-password",
			AIHUB_AUTO_PROXY_TOKEN: "managed-proxy-token",
		});
		expect(effective.listen.host).toBe("0.0.0.0");
		expect(effective.uiPassword).toBe("managed-console-password");
		expect(effective.proxyToken).toBe("managed-proxy-token");
		expect(persisted.uiPassword).toBe("persisted-console-password");
	});

	test("override changes memory but leaves the loaded object unchanged", () => {
		const loaded = ConfigSchema.parse({ listen: { port: 8123 } });
		const effective = applyStartupOptions(loaded, {
			help: false,
			port: 9123,
		});
		expect(effective.listen.port).toBe(9123);
		expect(loaded.listen.port).toBe(8123);
	});
});
