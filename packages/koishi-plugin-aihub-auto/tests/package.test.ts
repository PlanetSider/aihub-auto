import { expect, test } from "bun:test";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

test("package manifest 可由 Koishi registry 解析", () => {
	expect(require.resolve("koishi-plugin-aihub-auto/package.json")).toEndWith(
		"package.json",
	);
});
