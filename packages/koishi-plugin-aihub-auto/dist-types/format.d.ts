import type { PlatformRecommendation } from "./service.ts";
export interface FormatOptions {
    template: string;
    strategyText: string;
    downloadUrl: string;
}
export declare function formatItems(recs: PlatformRecommendation[]): string;
/** 模板变量:{strategy} {items} {download} */
export declare function render(recs: PlatformRecommendation[], opts: FormatOptions): string;
export declare const DEFAULT_TEMPLATE = "AIHub \u5F53\u524D\u63A8\u8350\n\u7B56\u7565:{strategy}\n{items}\n\u4E0B\u8F7D:{download}";
