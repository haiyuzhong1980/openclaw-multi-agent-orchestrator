/**
 * Shared constants extracted from multiple files to eliminate duplication.
 * All consumers should import from this module.
 */

// ACTION_VERBS — merged from execution-policy.ts and observation-engine.ts
export const ACTION_VERBS: string[] = [
  // Chinese
  "审计", "评测", "审查", "分析", "调研", "测试", "部署", "检查",
  "开发", "实现", "优化", "修复", "重构", "迁移", "设计", "构建",
  "验收", "评估", "研究", "排查", "清理", "整理",
  "配置", "安装", "升级", "发布", "打包", "推送", "同步",
  "编写", "创建", "搭建", "改造", "改进",
  "扫描", "读取", "加载", "备份", "恢复",
  // English
  "audit", "review", "test", "deploy", "analyze", "research",
  "develop", "implement", "optimize", "fix", "refactor", "build",
  "evaluate", "investigate", "design", "verify", "configure",
  "install", "upgrade", "publish", "sync", "scan", "backup",
];

// CHINESE_STOP_CHARS — merged from pattern-discovery.ts and intent-registry.ts (union)
export const CHINESE_STOP_CHARS = new Set([
  "的", "了", "在", "是", "我", "有", "和", "就", "不", "人", "都", "一",
  "上", "也", "很", "到", "说", "要", "去", "你", "会", "着", "没", "看",
  "好", "自", "这", "那", "什", "为", "啊", "把", "被", "让", "从", "与",
  // Additional entries from intent-registry.ts
  "一个", "没有", "什么",
]);

// CHINESE_STOP_WORDS — multi-character stopwords for better phrase filtering
export const CHINESE_STOP_WORDS = new Set([
  "这个", "那个", "什么", "怎么", "如何", "为什么", "哪里", "那里",
  "一个", "一些", "不是", "可以", "可能", "应该", "因为", "所以",
  "但是", "如果", "虽然", "或者", "而且", "然后", "这样", "那样",
  "的话", "时候", "地方", "东西", "事情", "问题", "一下", "一点",
  "没有", "已经", "还是", "只是", "就是", "都是", "或是", "而是",
]);

// CHINESE_PHRASE_BLACKLIST — meaningless bigram patterns to filter out
export const CHINESE_PHRASE_BLACKLIST = new Set([
  "这是", "那是", "不是", "是的", "有的", "我的", "你的", "他的",
  "就是", "都是", "还是", "或者", "但是", "因为", "所以", "然后",
  "如果", "虽然", "而且", "或者", "然后", "这样", "那样", "这个",
  "那个", "什么", "怎么", "如何", "为什么", "哪里", "那里", "一个",
  "可以", "可能", "应该", "没有", "已经", "只是", "或是", "而是",
  "一下", "一点", "时候", "地方", "东西", "事情", "问题", "的话",
]);

// ENGLISH_STOP_WORDS — merged from pattern-discovery.ts and intent-registry.ts (identical)
export const ENGLISH_STOP_WORDS = new Set([
  "the", "a", "an", "is", "are", "was", "were", "be", "been", "being",
  "have", "has", "had", "do", "does", "did", "will", "would", "shall", "should",
  "may", "might", "must", "can", "could", "to", "of", "in", "on", "at",
  "by", "for", "with", "from", "as", "it", "its", "this", "that", "these",
  "those", "and", "or", "but", "not", "no", "so", "if", "then", "than",
  "all", "also", "just", "me", "my", "we", "our", "you", "your", "he",
  "she", "they", "them", "their", "i", "am", "now", "please", "ok",
]);

// ESCALATION_SIGNALS — merged from observation-engine.ts and intent-registry.ts (union)
export const ESCALATION_SIGNALS: RegExp[] = [
  // From observation-engine.ts
  /应该.*派/, /应该.*agent/, /太简单/, /不要自己做/, /派出去/,
  /你.*派.*agent/, /需要.*多.*agent/, /应该.*调度/, /为什么不派/,
  /should.*dispatch/, /should.*delegate/, /too simple/i,
  // Additional from intent-registry.ts (not covered by the above)
  /应该派.*(agent|子|工)/,
  /用多.*agent/, /需要.*agent.*去/, /太简单了/, /这个要.*agent/,
];

// DE_ESCALATION_SIGNALS — merged from observation-engine.ts and intent-registry.ts (union)
export const DE_ESCALATION_SIGNALS: RegExp[] = [
  // From observation-engine.ts
  /不用.*复杂/, /直接做.*好/, /太重了/, /不需要.*agent/,
  /简单.*就行/, /不用派/, /太麻烦/, /别搞这么复杂/,
  /too complex/i, /just do it/i, /no need.*agent/i,
  // Additional from intent-registry.ts (not covered by the above)
  /不用这么复杂/, /直接做就好/,
];
