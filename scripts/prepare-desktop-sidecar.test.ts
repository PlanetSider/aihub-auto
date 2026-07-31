import { describe, expect, test } from "bun:test";
import { sidecarTarget } from "./prepare-desktop-sidecar.ts";

describe("desktop sidecar target mapping", () => {
	test("maps every supported Rust triple to the matching Bun target", () => {
		expect(sidecarTarget("x86_64-pc-windows-msvc")).toEqual({
			bun: "bun-windows-x64",
			extension: ".exe",
		});
		expect(sidecarTarget("x86_64-unknown-linux-gnu").bun).toBe(
			"bun-linux-x64-baseline",
		);
		expect(sidecarTarget("aarch64-unknown-linux-gnu").bun).toBe(
			"bun-linux-arm64",
		);
		expect(sidecarTarget("x86_64-apple-darwin").bun).toBe("bun-darwin-x64");
		expect(sidecarTarget("aarch64-apple-darwin").bun).toBe("bun-darwin-arm64");
	});

	test("rejects unsupported targets instead of packaging the wrong binary", () => {
		expect(() => sidecarTarget("aarch64-pc-windows-msvc")).toThrow(
			"不支持的 Tauri sidecar target",
		);
	});
});
