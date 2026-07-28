/**
 * 作用域规则:`platform:guildId`,每段支持 * 通配。
 * `onebot:1059338666` 指定群;`onebot:*` 平台全部群;`*:*` 全部;
 * 无 `:` 的规则视为仅群号(任意平台)。
 */
function globToRegExp(glob: string): RegExp {
	const escaped = glob.replace(/[.*+?^${}()|[\]\\]/g, (ch) =>
		ch === "*" ? "\u0000" : `\\${ch}`,
	);
	return new RegExp(`^${escaped.replaceAll("\u0000", ".*")}$`);
}

export function matchRule(
	platform: string,
	guildId: string | undefined,
	rules: string[],
): boolean {
	if (rules.length === 0) return false;
	for (const raw of rules) {
		const rule = raw.trim();
		if (!rule) continue;
		const idx = rule.indexOf(":");
		const platformPart = idx === -1 ? "*" : rule.slice(0, idx);
		const guildPart = idx === -1 ? rule : rule.slice(idx + 1);
		if (!globToRegExp(platformPart).test(platform)) continue;
		if (guildId === undefined) {
			// 私聊等无 guild 场景:仅 guildPart 为 * 时匹配
			if (guildPart === "*") return true;
			continue;
		}
		if (globToRegExp(guildPart).test(guildId)) return true;
	}
	return false;
}
