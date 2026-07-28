import { describe, expect, test } from "bun:test";
import { matchRule } from "../src/matcher.ts";

describe("matchRule", () => {
	test("精确群号命中,其他群不命中", () => {
		const rules = ["onebot:1059338666"];
		expect(matchRule("onebot", "1059338666", rules)).toBe(true);
		expect(matchRule("onebot", "999", rules)).toBe(false);
	});

	test("前缀通配 onebot:105933*", () => {
		const rules = ["onebot:105933*"];
		expect(matchRule("onebot", "1059338666", rules)).toBe(true);
		expect(matchRule("onebot", "1059330000", rules)).toBe(true);
		expect(matchRule("onebot", "2059338666", rules)).toBe(false);
	});

	test("onebot:* 匹配平台全部群;其他平台不命中", () => {
		const rules = ["onebot:*"];
		expect(matchRule("onebot", "任意", rules)).toBe(true);
		expect(matchRule("discord", "任意", rules)).toBe(false);
	});

	test("*:* 全命中", () => {
		expect(matchRule("discord", "abc", ["*:*"])).toBe(true);
		expect(matchRule("onebot", "123", ["*:*"])).toBe(true);
	});

	test("无冒号规则视为仅群号(任意平台)", () => {
		expect(matchRule("onebot", "123", ["123"])).toBe(true);
		expect(matchRule("discord", "123", ["123"])).toBe(true);
		expect(matchRule("onebot", "456", ["123"])).toBe(false);
	});

	test("特殊字符群号不引发正则注入", () => {
		expect(matchRule("onebot", "a.b+c", ["onebot:a.b+c"])).toBe(true);
		expect(matchRule("onebot", "aXb+c", ["onebot:a.b+c"])).toBe(false);
		expect(matchRule("onebot", "((evil))", ["onebot:((evil))"])).toBe(true);
	});

	test("多规则任一命中即可;空规则列表不命中", () => {
		expect(matchRule("onebot", "2", ["onebot:1", "onebot:2"])).toBe(true);
		expect(matchRule("onebot", "1", [])).toBe(false);
	});

	test("guildId undefined(私聊):仅 guild 段为 * 时命中", () => {
		expect(matchRule("onebot", undefined, ["onebot:*"])).toBe(true);
		expect(matchRule("onebot", undefined, ["onebot:123"])).toBe(false);
	});
});
