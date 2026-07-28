/**
 * 6 目标交叉编译:bun build --compile。
 * 产物 artifacts/aihub-auto-{os}-{arch}.zip(内含二进制 + README)。
 */
import { mkdir, rm, cp } from "node:fs/promises";
import { join } from "node:path";
import { $ } from "bun";

const TARGETS: { target: string; os: string; arch: string; bin: string }[] = [
	{
		target: "bun-windows-x64",
		os: "windows",
		arch: "x64",
		bin: "aihub-auto.exe",
	},
	{ target: "bun-linux-x64", os: "linux", arch: "x64", bin: "aihub-auto" },
	{ target: "bun-linux-arm64", os: "linux", arch: "arm64", bin: "aihub-auto" },
	{ target: "bun-darwin-x64", os: "macos", arch: "x64", bin: "aihub-auto" },
	{ target: "bun-darwin-arm64", os: "macos", arch: "arm64", bin: "aihub-auto" },
	// bun 尚未支持 windows-arm64 编译目标时自动跳过(Windows on ARM 可运行 x64 版)
	{
		target: "bun-windows-arm64",
		os: "windows",
		arch: "arm64",
		bin: "aihub-auto.exe",
	},
];

const root = join(import.meta.dir, "..");
const artifacts = join(root, "artifacts");
await rm(artifacts, { recursive: true, force: true });
await mkdir(artifacts, { recursive: true });

const only = process.argv[2]; // 可选:只构建单个目标,如 `bun scripts/build.ts linux-x64`
let failed = 0;

for (const t of TARGETS) {
	const name = `${t.os}-${t.arch}`;
	if (only && name !== only) continue;
	const dir = join(artifacts, name);
	await mkdir(dir, { recursive: true });
	const out = join(dir, t.bin);
	console.log(`▶ ${name}(${t.target})`);
	const proc =
		await $`bun build --compile --minify --target=${t.target} ${join(root, "apps/router/src/main.ts")} --outfile ${out}`
			.quiet()
			.nothrow();
	if (proc.exitCode !== 0) {
		const text = proc.stderr.toString();
		if (
			t.target === "bun-windows-arm64" &&
			/unsupported|invalid target|Unsupported/i.test(text)
		) {
			console.warn(
				`⚠ 跳过 ${name}:当前 bun 版本不支持该目标(Windows ARM 用户可运行 x64 版)`,
			);
			await rm(dir, { recursive: true, force: true });
			continue;
		}
		console.error(text);
		failed++;
		continue;
	}
	await cp(join(root, "apps/router/README.md"), join(dir, "README.md")).catch(
		() => {},
	);
	const zipName = `aihub-auto-${name}.zip`;
	const zipPath = join(artifacts, zipName);
	// 压缩:优先 zip(CI/linux/mac);Windows 开发机回退 PowerShell Compress-Archive
	let zipped =
		(await $`zip -j -r ${zipPath} ${dir}`.quiet().nothrow()).exitCode === 0;
	if (!zipped && process.platform === "win32") {
		const psSrc = `${dir.replaceAll("/", "\\")}\\*`;
		const psDst = zipPath.replaceAll("/", "\\");
		zipped =
			(
				await $`powershell -NoProfile -Command ${`Compress-Archive -Path '${psSrc}' -DestinationPath '${psDst}' -Force`}`
					.quiet()
					.nothrow()
			).exitCode === 0;
	}
	if (!zipped) {
		console.error(`✗ 打包失败:${zipName}`);
		failed++;
		continue;
	}
	console.log(`✓ ${zipName}`);
}

if (failed > 0) {
	console.error(`${failed} 个目标失败`);
	process.exit(1);
}
console.log("构建完成 → artifacts/");
