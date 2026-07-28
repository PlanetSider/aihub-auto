import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVELS: Record<LogLevel, number> = {
	debug: 0,
	info: 1,
	warn: 2,
	error: 3,
};

/** token / sk-key 脱敏 */
export function redact(text: string): string {
	return text
		.replace(/sk-[A-Za-z0-9_-]{8,}/g, (m) => `${m.slice(0, 6)}***`)
		.replace(/Bearer\s+[A-Za-z0-9._~+/-]{8,}=*/gi, "Bearer ***")
		.replace(/eyJ[A-Za-z0-9._-]{20,}/g, "eyJ***");
}

export class Logger {
	constructor(
		private level: LogLevel = "info",
		private readonly sink: (line: string) => void = (l) => console.log(l),
	) {}

	setLevel(level: LogLevel): void {
		this.level = level;
	}

	private emit(
		level: LogLevel,
		msg: string,
		extra?: Record<string, unknown>,
	): void {
		if (LEVELS[level] < LEVELS[this.level]) return;
		const time = new Date().toISOString();
		const suffix = extra ? ` ${redact(JSON.stringify(extra))}` : "";
		this.sink(`${time} [${level.toUpperCase()}] ${redact(msg)}${suffix}`);
	}

	debug(msg: string, extra?: Record<string, unknown>): void {
		this.emit("debug", msg, extra);
	}
	info(msg: string, extra?: Record<string, unknown>): void {
		this.emit("info", msg, extra);
	}
	warn(msg: string, extra?: Record<string, unknown>): void {
		this.emit("warn", msg, extra);
	}
	error(msg: string, extra?: Record<string, unknown>): void {
		this.emit("error", msg, extra);
	}
}

/** JSONL 审计:每轮决策的完整候选得分 */
export class AuditLog {
	constructor(private readonly path: string | undefined) {}

	async append(record: Record<string, unknown>): Promise<void> {
		if (!this.path) return;
		const line = `${JSON.stringify({ at: new Date().toISOString(), ...record })}\n`;
		const { appendFile } = await import("node:fs/promises");
		await appendFile(this.path, line, "utf8");
	}
}

function errorDetail(value: unknown): string {
	if (value instanceof Error) return value.stack ?? value.message;
	try {
		return typeof value === "string" ? value : JSON.stringify(value);
	} catch {
		return String(value);
	}
}

/** 致命/生命周期日志使用同步追加,确保进程退出前证据落盘。 */
export class CrashLog {
	constructor(private readonly path: string) {}

	record(event: string, detail?: unknown): void {
		try {
			mkdirSync(dirname(this.path), { recursive: true });
			appendFileSync(
				this.path,
				`${JSON.stringify({
					at: new Date().toISOString(),
					event,
					pid: process.pid,
					...(detail === undefined
						? {}
						: { detail: redact(errorDetail(detail)) }),
				})}\n`,
				"utf8",
			);
		} catch {
			// 崩溃日志本身不得影响代理可用性。
		}
	}
}
