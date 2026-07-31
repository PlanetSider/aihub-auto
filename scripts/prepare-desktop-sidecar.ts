import { chmod, mkdir } from "node:fs/promises";
import { join } from "node:path";

const TARGETS = {
	"x86_64-pc-windows-msvc": {
		bun: "bun-windows-x64",
		extension: ".exe",
	},
	"x86_64-unknown-linux-gnu": {
		bun: "bun-linux-x64-baseline",
		extension: "",
	},
	"aarch64-unknown-linux-gnu": {
		bun: "bun-linux-arm64",
		extension: "",
	},
	"x86_64-apple-darwin": { bun: "bun-darwin-x64", extension: "" },
	"aarch64-apple-darwin": { bun: "bun-darwin-arm64", extension: "" },
} as const;

export type DesktopTarget = keyof typeof TARGETS;

export function sidecarTarget(triple: string): {
	bun: string;
	extension: string;
} {
	const target = TARGETS[triple as DesktopTarget];
	if (!target) throw new Error(`不支持的 Tauri sidecar target:${triple}`);
	return target;
}

async function hostTriple(): Promise<string> {
	const cargoHome =
		process.env["CARGO_HOME"] ??
		join(process.env["USERPROFILE"] ?? process.env["HOME"] ?? "", ".cargo");
	const rustc =
		process.platform === "win32"
			? join(cargoHome, "bin", "rustc.exe")
			: join(cargoHome, "bin", "rustc");
	const proc = Bun.spawn([rustc, "--print", "host-tuple"], {
		stdout: "pipe",
		stderr: "inherit",
	});
	const output = (await new Response(proc.stdout).text()).trim();
	if ((await proc.exited) !== 0 || !output) {
		throw new Error("无法读取 Rust host triple");
	}
	return output;
}

async function main(): Promise<void> {
	const root = join(import.meta.dir, "..");
	const triple =
		process.argv[2] ??
		process.env["TAURI_ENV_TARGET_TRIPLE"] ??
		process.env["AIHUB_AUTO_DESKTOP_TARGET"] ??
		(await hostTriple());
	const target = sidecarTarget(triple);
	const binaries = join(root, "apps", "desktop", "src-tauri", "binaries");
	await mkdir(binaries, { recursive: true });
	const output = join(
		binaries,
		`aihub-auto-router-${triple}${target.extension}`,
	);
	const proc = Bun.spawn(
		[
			process.execPath,
			"build",
			"--compile",
			"--minify",
			`--target=${target.bun}`,
			join(root, "apps", "router", "src", "main.ts"),
			"--outfile",
			output,
		],
		{ cwd: root, stdout: "inherit", stderr: "inherit" },
	);
	const code = await proc.exited;
	if (code !== 0) throw new Error(`sidecar 构建失败(exit ${code})`);
	if (process.platform !== "win32") await chmod(output, 0o755);
	console.log(`Tauri sidecar ready:${output}`);
}

if (import.meta.main) await main();
