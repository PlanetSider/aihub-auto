/**
 * 产出 dist/index.cjs + index.mjs + index.d.ts。
 * @aihub-auto/core 打入 bundle(noExternal),用户无需 workspace。
 */
import { rm } from "node:fs/promises";
import { join } from "node:path";

const root = import.meta.dir;
const dist = join(root, "dist");
await rm(dist, { recursive: true, force: true });

for (const [format, outfile] of [
  ["cjs", "index.cjs"],
  ["esm", "index.mjs"],
] as const) {
  const result = await Bun.build({
    entrypoints: [join(root, "src/index.ts")],
    outdir: dist,
    naming: outfile,
    format,
    target: "node",
    external: ["koishi"],
    minify: false,
  });
  if (!result.success) {
    console.error(result.logs);
    process.exit(1);
  }
}

// d.ts:手写稳定声明(插件对外 API 就三个导出,避免把 workspace 类型树卷进发包)
await Bun.write(
  join(dist, "index.d.ts"),
  `import type { Context, Schema } from "koishi";

export declare const name = "aihub-auto";

export interface Config {
  rules: string[];
  baseUrl: string;
  mode: "economy" | "balanced" | "speed";
  maxRate: number;
  samples: number;
  scoreWindow: number;
  strategyText: string;
  downloadUrl: string;
  template: string;
  cacheTtlMs: number;
  cooldownMs: number;
  respondPrivate: boolean;
  errorText: string;
}

export declare const Config: Schema<Config>;

export declare function apply(ctx: Context, config: Config): void;
`,
);
console.log("build ok → dist/");
