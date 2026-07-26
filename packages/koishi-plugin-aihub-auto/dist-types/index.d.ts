import { type Context, Schema } from "koishi";
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
