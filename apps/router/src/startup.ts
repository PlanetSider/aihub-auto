import type { AppConfig } from "./config.ts";

export interface StartupOptions {
	port?: number;
	help: boolean;
}

export const STARTUP_HELP = `aihub-auto

用法:
  aihub-auto [--port <1-65535>]
  aihub-auto [--port=<1-65535>]
  aihub-auto --help

端口优先级:
  --port > AIHUB_AUTO_PORT > config.json listen.port > 8787

命令行和环境变量只覆盖本次启动,不会改写 config.json。`;

const PORT_PATTERN =
	/^(?:[1-9]\d{0,3}|[1-5]\d{4}|6[0-4]\d{3}|65[0-4]\d{2}|655[0-2]\d|6553[0-5])$/;

function parsePort(value: string, source: string): number {
	if (!PORT_PATTERN.test(value)) {
		throw new Error(`${source} 必须是 1 到 65535 的十进制整数`);
	}
	return Number(value);
}

export function parseStartupOptions(
	args: string[],
	env: Record<string, string | undefined>,
): StartupOptions {
	let help = false;
	let cliPort: number | undefined;
	let sawPort = false;

	for (let index = 0; index < args.length; index++) {
		const arg = args[index]!;
		if (arg === "--help" || arg === "-h") {
			help = true;
			continue;
		}
		if (arg === "--port") {
			if (sawPort) throw new Error("--port 不能重复指定");
			const value = args[++index];
			if (value === undefined) throw new Error("--port 缺少端口值(1 到 65535)");
			cliPort = parsePort(value, "--port");
			sawPort = true;
			continue;
		}
		if (arg.startsWith("--port=")) {
			if (sawPort) throw new Error("--port 不能重复指定");
			cliPort = parsePort(arg.slice("--port=".length), "--port");
			sawPort = true;
			continue;
		}
		throw new Error(`未知启动参数:${arg}`);
	}

	if (help) return { help: true };
	const envPort = env["AIHUB_AUTO_PORT"];
	return {
		help: false,
		port:
			cliPort ??
			(envPort === undefined
				? undefined
				: parsePort(envPort, "AIHUB_AUTO_PORT")),
	};
}

export function applyStartupOptions(
	config: AppConfig,
	options: StartupOptions,
): AppConfig {
	if (options.port === undefined) return config;
	return {
		...config,
		listen: { ...config.listen, port: options.port },
	};
}
