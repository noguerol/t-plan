
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type Tier = "t0" | "t1" | "t2" | "t3";

export function tierToToolValue(tier: Tier): string {
  return tier === "t0" ? "active" : tier;
}

export function toolValueToTier(value: string): Tier | undefined {
  const v = value.trim().toLowerCase();
  if (v === "active" || v === "t0") return "t0";
  if (v === "t1" || v === "t2" || v === "t3") return v;
  return undefined;
}

export const TIER_ROLES: Record<Tier, string> = {
  t0: "active worker (default, same model as this session)",
  t1: "complex — deep thinking, architecture, planning",
  t2: "medium — implementation, debugging, review",
  t3: "simple — mechanical work (parse, format, translate, rename)",
};

export interface TgTierInfo {
  enabled?: boolean;
  model?: string;
}

export interface TrimegistoFileConfig {
  enabled?: boolean;
  spawnOnlyOnActive?: boolean;
  active?: TgTierInfo;
  t1?: TgTierInfo;
  t2?: TgTierInfo;
  t3?: TgTierInfo;
}

export function trimegistoConfigPath(): string {
  return join(homedir(), ".pi", "agent", "trimegisto", "config.json");
}

export function readTrimegistoConfig(): TrimegistoFileConfig | null {
  try {
    const raw = readFileSync(trimegistoConfigPath(), "utf-8");
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object") return parsed as TrimegistoFileConfig;
  } catch {
  }
  return null;
}

export function isTierAvailable(tier: Tier, tg: TrimegistoFileConfig | null): boolean {
  if (!tg || tg.enabled === false) return tier === "t0";
  if (tier === "t0") return tg.active?.enabled !== false;
  if (tg.spawnOnlyOnActive === true) return false;
  const info = (tg as unknown as Record<string, TgTierInfo | undefined>)[tier];
  return info?.enabled !== false && typeof info?.model === "string" && info.model.length > 0;
}

export function resolveEffectiveTier(assigned: Tier | undefined, tg: TrimegistoFileConfig | null): Tier {
  const desired: Tier = assigned ?? "t0";
  return isTierAvailable(desired, tg) ? desired : "t0";
}

interface TierSignal {
  tier: Tier;
  weight: number;
  re: RegExp;
}

const SIGNALS: TierSignal[] = [
  { tier: "t1", weight: 3, re: /\b(?:root\s+cause|causa\s+ra[íi]z|trade[-\s]?offs?|threat\s+model|proof\s+of\s+concept|prueba\s+de\s+concepto)\b|(?:根因|权衡|威胁模型|概念验证|原型验证)/gi },
  { tier: "t1", weight: 2, re: /\b(?:architect\w*|arquitectur\w*|redesign\w*|redise[ñn]\w*|refactor\w*|refactoriz\w*|migrat\w*|migraci\w*|migrar|secur\w*|segur\w*|scal(?:e|ing|ability)\b|escalabil\w*|investigat\w*|investig\w*|strateg\w*|estrategi\w*|algorithm\w*|algoritm\w*|distribute\w*|distribuid\w*|concurren\w*|concurrencia|bottleneck|cuello\s+de\s+botella|optimi[sz]\w*|optimiz\w*|planific\w*)\b|(?:架构|重新设计|重构|迁移|安全|可扩展|调查|研究|策略|算法|分布式|并发|瓶颈|优化|规划)/gi },
  { tier: "t1", weight: 1, re: /\b(?:design|dise[ñn]o|dise[ñn]a)\b|(?:设计)/gi },

  { tier: "t3", weight: 2, re: /\b(?:renam\w*|renombr\w*|translat\w*|traduc\w*|traducir|find\s+and\s+replace|buscar\s+y\s+(?:reemplazar|sustituir)|convert\w*\s+(?:to|a|into)\s+(?:json|csv|yaml|xml|markdown)|documentation|documentaci[oó]n|documenta\w*|readme|changelog)\b|(?:重命名|翻译|查找替换|查找并替换|转换为|转成|文档|说明文档|自述|更新日志)/gi },
  { tier: "t3", weight: 1, re: /\b(?:format\w*|formate\w*|formato|pars\w*|parsea\w*|extract\w*|extrae\w*|extraer|count\w*|cuent\w*|sort\w*|ordena\w*|filter\w*|filtra\w*|cop\w*\s+files?|copia\w*|mueve\w*|lint\w*|typo\w*|erratas?|spell\w*|ortogra\w*|comment\w*|comenta\w*|regex\w*|expresi[oó]n\s+regular|lista\w*\s+(?:los\s+)?archivos?)\b|(?:格式化|解析|提取|抽取|统计|计数|排序|筛选|过滤|复制|移动|检查|拼写|错别字|注释|正则|列出文件|列出)/gi },

  { tier: "t2", weight: 2, re: /\b(?:implement\w*|implementa\w*|debug\w*|depura\w*|code\s+review|revisi[oó]n\s+de\s+c[oó]digo|integrat\w*|integraci[oó]n)\b|(?:实现|实施|调试|代码审查|审查代码|集成)/gi },
  { tier: "t2", weight: 1, re: /\b(?:fix\w*|arregl\w*|corrige?\w*|bug|bugs|test\w*|prueba\w*|review|revisa\w*|endpoint\w*|api\b|apis\b|feature|features|component\w*|module|modules|config\w*|configura\w*|update|updates|actualiza\w*|add|adds|a[ñn]ad\w*|create|crea\w*|write|escribe\w*|build|deploy|despleg\w*|install\w*|instala\w*|analyz\w*|analiza\w*|script|ui\b|css)\b|(?:修复|错误|缺陷|测试|验证|审查|端点|接口|功能|组件|模块|配置|更新|添加|新增|创建|编写|构建|部署|安装|分析|脚本|界面|样式)/gi },
];

export function classifyTask(text: string): Tier {
  const clean = text
    .replace(/\((?:→|->)\s*t[0-3]\)/gi, " ")
    .replace(/⏱\s*[\d:]+/g, " ")
    .replace(/\[t[0-3]\]/gi, " ");

  const scores: Record<Tier, number> = { t0: 0, t1: 0, t2: 0, t3: 0 };
  for (const signal of SIGNALS) {
    const matches = clean.match(new RegExp(signal.re.source, signal.re.flags.includes("g") ? signal.re.flags : signal.re.flags + "g"));
    if (matches) scores[signal.tier] += matches.length * signal.weight;
  }

  const best = Math.max(scores.t1, scores.t2, scores.t3);
  if (best === 0) return "t2";

  if (scores.t1 === best) return "t1";
  if (scores.t3 === best) return "t3";
  return "t2";
}

export function formatElapsed(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

export function runningTimerText(startedAt: number | undefined, now: number = Date.now()): string {
  if (!startedAt) return "";
  return `⏱ ${formatElapsed(now - startedAt)}`;
}

export function completedTimerText(startedAt: number | undefined, completedAt: number | undefined): string {
  if (!startedAt || !completedAt) return "";
  return `took ${formatElapsed(completedAt - startedAt)}`;
}

export function tierBadge(tier: Tier): string {
  return `[${tier}]`;
}

export function tierColor(tier: Tier): string {
  switch (tier) {
    case "t0": return "success";
    case "t1": return "warning";
    case "t2": return "accent";
    case "t3": return "dim";
  }
}
