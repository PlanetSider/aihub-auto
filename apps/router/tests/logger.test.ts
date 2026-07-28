import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Logger, RollingFileLog } from "../src/logger.ts";

let dir: string | undefined;
afterEach(async () => {
	if (dir) await rm(dir, { recursive: true, force: true });
	dir = undefined;
});

describe("rolling application log", () => {
	test("rotates at the size limit and redacts credentials", async () => {
		dir = await mkdtemp(join(tmpdir(), "aihub-auto-log-"));
		const path = join(dir, "app.log");
		const file = new RollingFileLog(path, 120, 2);
		const logger = new Logger("info", (line) => file.write(line));

		for (let index = 0; index < 8; index++) {
			logger.info(`request ${index} Bearer secret-token-1234567890`);
		}

		const files = (await readdir(dir)).sort();
		expect(files).toContain("app.log");
		expect(files).toContain("app.log.1");
		expect(files).not.toContain("app.log.3");
		const text = (
			await Promise.all(files.map((name) => readFile(join(dir!, name), "utf8")))
		).join("\n");
		expect(text).toContain("Bearer ***");
		expect(text).not.toContain("secret-token-1234567890");
	});
});
