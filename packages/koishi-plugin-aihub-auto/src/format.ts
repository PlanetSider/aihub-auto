import type { PlatformRecommendation } from "./service.ts";

export interface FormatOptions {
	template: string;
	strategyText: string;
	downloadUrl: string;
}

const PLATFORM_LABEL: Record<string, string> = {
	openai: "OpenAI",
};

function formatRate(rate: number): string {
	// 保留原始小数(0.03 → "0.03",0.1 → "0.1")
	return String(rate);
}

export function formatItems(recs: PlatformRecommendation[]): string {
	const blocks: string[] = [];
	const multi = recs.length > 1;
	for (const rec of recs) {
		const lines = rec.items.map(
			(c, i) =>
				`${i + 1}. ${c.stat.code}(#${c.stat.groupId})|${formatRate(c.stat.rateMultiplier)}x|${Math.round(c.blendedTtftMs)} ms`,
		);
		blocks.push(
			multi
				? `${PLATFORM_LABEL[rec.platform] ?? rec.platform}:\n${lines.join("\n")}`
				: lines.join("\n"),
		);
	}
	return blocks.join("\n");
}

/** 模板变量:{strategy} {items} {download} */
export function render(
	recs: PlatformRecommendation[],
	opts: FormatOptions,
): string {
	return opts.template
		.replaceAll("{strategy}", opts.strategyText)
		.replaceAll("{items}", formatItems(recs))
		.replaceAll("{download}", opts.downloadUrl)
		.trim();
}

export const DEFAULT_TEMPLATE = `AIHub 当前推荐
策略:{strategy}
{items}
下载:{download}`;
