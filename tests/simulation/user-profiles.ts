/**
 * 5 种用户画像定义 — 每种画像有不同的消息分布和纠正行为。
 *
 * 画像驱动模拟器生成消息，并决定用户对 OMA 分类结果的反应。
 */

export interface UserProfile {
  id: string;
  name: string;
  description: string;

  /** 消息 tier 分布概率 [light, tracked, delegation]，总和 = 1 */
  tierDistribution: [number, number, number];

  /** 纠正敏感度：用户在 OMA 判错时发起纠正的概率 (0-1) */
  correctionRate: number;

  /** 每种 tier 的消息模板 */
  templates: {
    light: string[];
    tracked: string[];
    delegation: string[];
  };

  /** 用户纠正时使用的表达 */
  correctionPhrases: {
    up: string[];   // 升级纠正（应该派 agent）
    down: string[]; // 降级纠正（不用那么复杂）
  };
}

export const PROFILES: UserProfile[] = [
  {
    id: "conservative",
    name: "保守型用户",
    description: "偏好简单直接，不喜欢复杂编排，经常降级纠正",
    tierDistribution: [0.4, 0.5, 0.1],
    correctionRate: 0.7,
    templates: {
      light: [
        "好的",
        "收到",
        "明白了",
        "可以",
        "嗯",
        "ok",
        "谢谢",
        "对",
        "行",
        "是的",
        "hello",
        "你好",
        "方案A",
      ],
      tracked: [
        "帮我看下这个报错信息",
        "修复一下这个 bug",
        "帮我配置 nginx",
        "检查一下服务器状态",
        "帮我重启一下服务",
        "你先检查下日志有没有报错",
        "帮我找一下这个文件在哪里",
        "写个简单的脚本清理日志",
        "帮我看看 ssh 连不上是什么原因",
        "查一下 github 上有没有类似的 issue",
        "帮我把这个配置改一下",
        "你去看看文档怎么说的",
        "帮我安装一下 redis",
        "读取一下这个 json 文件的内容",
        "帮我把这个推送到远程仓库",
      ],
      delegation: [
        "帮我做一个完整的系统部署方案",
        "需要你组建团队来开发这个新功能",
        "全面审查一下代码库的安全问题",
      ],
    },
    correctionPhrases: {
      up: ["这个确实需要 agent 来做"],
      down: [
        "不用这么复杂，直接做就好",
        "太重了，简单处理就行",
        "不需要 agent，你自己做吧",
        "别搞这么复杂",
        "简单处理就行了",
      ],
    },
  },

  {
    id: "aggressive",
    name: "激进型用户",
    description: "倾向大量使用 agent，经常升级纠正",
    tierDistribution: [0.1, 0.3, 0.6],
    correctionRate: 0.8,
    templates: {
      light: [
        "好",
        "ok",
        "收到",
        "是的",
        "嗯",
      ],
      tracked: [
        "分析一下当前的部署架构",
        "帮我优化一下数据库查询",
        "检查并修复所有测试用例",
        "帮我重构这个模块",
        "研究一下新的技术方案",
        "帮我搭建 CI/CD 流水线",
      ],
      delegation: [
        "全力推进这个项目从 M0 到 M4",
        "你是总控，派出所有 agent 并行执行",
        "组成团队开发，每个里程碑都要出测试报告",
        "启动多 agent 并行审查所有模块",
        "释放你的最大力量，全面推进",
        "我需要你调度多个 agent 来完成以下任务：\n1. 安全审计\n2. 性能优化\n3. 代码审查\n4. 测试覆盖",
        "派出子 agent 分别处理前端、后端和数据库",
        "全面审核代码质量，出审查报告",
        "强力推进，里程碑 M1 开工",
        "产品经理模式，出任务清单和进度表",
        "组建团队，分工协作，每完成一个阶段汇报进度",
        "从 M1 推进到 M3，每个阶段都要验收",
        "召唤所有 agent，全面优化系统性能",
        "真实执行，不要只给方案",
        "深度思考这个架构问题，然后派 agent 分别实现",
      ],
    },
    correctionPhrases: {
      up: [
        "应该派 agent 来做这个",
        "这个需要多个 agent 并行",
        "太简单了，应该用 agent 调度",
        "不要自己做，派出去",
        "你应该调度 agent 来执行",
        "这个要 agent 去做",
      ],
      down: ["这个不用那么复杂"],
    },
  },

  {
    id: "developer",
    name: "开发者用户",
    description: "技术导向，主要是 tracked 任务，偶尔需要多 agent 协作",
    tierDistribution: [0.15, 0.65, 0.2],
    correctionRate: 0.5,
    templates: {
      light: [
        "ok",
        "好的",
        "收到",
        "thanks",
        "嗯",
        "方案B",
        "是的",
      ],
      tracked: [
        "帮我修复这个 TypeScript 编译错误",
        "配置一下 ESLint 规则",
        "写个单元测试覆盖这个函数",
        "帮我看看这个 403 报错是什么原因",
        "重构一下这个模块，把大文件拆分",
        "帮我部署到测试服务器",
        "检查一下测试覆盖率",
        "升级一下 Node.js 版本",
        "帮我排查一下内存泄漏问题",
        "创建一个新的 API 端点",
        "帮我写个 migration 脚本",
        "优化一下这个查询，现在太慢了",
        "帮我搭建 Docker 开发环境",
        "修复所有 lint warning",
        "帮我写个 README",
        "同步一下远程仓库的代码",
        "加载配置文件并验证格式",
        "扫描一下依赖有没有安全漏洞",
        "写一个自动化部署脚本",
        "帮我设计数据库表结构",
      ],
      delegation: [
        "全面审查代码库，分别检查安全、性能、代码质量",
        "搭建完整的微服务架构，包括网关、认证、日志",
        "组成团队来做这次大版本升级",
        "多 agent 并行执行：前端重构 + 后端优化 + 数据库迁移",
        "设计并实现完整的 CI/CD 流水线",
      ],
    },
    correctionPhrases: {
      up: [
        "这个应该派 agent 来做",
        "需要多个 agent 协作",
      ],
      down: [
        "不用这么复杂",
        "直接做就好了",
        "简单改一下就行",
      ],
    },
  },

  {
    id: "researcher",
    name: "研究者用户",
    description: "偏好深度分析和调研，中等复杂度为主",
    tierDistribution: [0.2, 0.5, 0.3],
    correctionRate: 0.4,
    templates: {
      light: [
        "好的",
        "明白",
        "谢谢",
        "收到了",
        "ok",
        "对",
      ],
      tracked: [
        "分析一下这个日志文件的模式",
        "调研一下竞品的技术方案",
        "帮我研究一下这个算法的复杂度",
        "评估一下迁移到新框架的风险",
        "帮我整理一下这些数据",
        "研究一下这个 API 的使用方式",
        "分析一下用户行为数据",
        "评测一下不同模型的效果",
        "帮我做个技术选型对比",
        "调研一下这个开源项目的活跃度",
        "帮我总结一下这篇论文的要点",
        "检查一下数据一致性",
        "验证一下这个假设是否成立",
      ],
      delegation: [
        "全面调研并对比 5 种技术方案，出对比报告",
        "深度思考这个架构问题，从多个角度分析",
        "组建研究团队，分别调研不同方向",
        "全面分析竞品，每个维度都要出详细报告",
        "从多个角度全面评估这个方案的可行性",
        "派出多个 agent 分别分析：性能、安全性、可维护性、扩展性",
      ],
    },
    correctionPhrases: {
      up: [
        "这个需要更深入的分析",
        "应该多角度来看这个问题",
      ],
      down: [
        "不用那么深入，简要分析就行",
        "太重了，给个概要就好",
      ],
    },
  },

  {
    id: "manager",
    name: "管理者用户",
    description: "关注进度管理和团队协调，常用 delegation 模式",
    tierDistribution: [0.15, 0.35, 0.5],
    correctionRate: 0.6,
    templates: {
      light: [
        "好",
        "ok",
        "收到",
        "可以",
        "行",
        "知道了",
      ],
      tracked: [
        "帮我看一下当前项目进度",
        "整理一下本周的任务清单",
        "检查一下哪些任务还没完成",
        "帮我写个周报",
        "更新一下项目文档",
        "帮我安排一下下周的工作计划",
        "查一下这个 issue 的状态",
        "同步一下最新的代码到服务器",
        "备份一下数据库",
      ],
      delegation: [
        "安排团队分工，按里程碑推进",
        "产品经理模式，出任务看板和进度表",
        "全面推进 Q2 目标，每个阶段都要检查验收",
        "组成团队开发新功能模块",
        "调度多个 agent，分别负责开发、测试、部署",
        "出一份完整的项目规划，包含里程碑、任务清单、人员分工",
        "派出 agent 并行执行所有待办事项",
        "你当总控，组建团队执行以下工作：\n1. 代码审查\n2. 安全扫描\n3. 性能测试\n4. 文档更新",
        "全面审查项目状态，出验收报告",
        "强力推进 M2 里程碑",
      ],
    },
    correctionPhrases: {
      up: [
        "应该派 agent 来做",
        "需要调度团队来执行",
        "为什么不派 agent？",
        "用多 agent 并行处理",
      ],
      down: [
        "这个不需要那么多 agent",
        "太复杂了，简化一下",
      ],
    },
  },
];

/**
 * 从画像的 tier 分布中随机选择一个 tier
 */
export function sampleTier(profile: UserProfile): "light" | "tracked" | "delegation" {
  const [pLight, pTracked] = profile.tierDistribution;
  const r = Math.random();
  if (r < pLight) return "light";
  if (r < pLight + pTracked) return "tracked";
  return "delegation";
}

/**
 * 从画像中随机选择一条模板消息
 */
export function sampleMessage(profile: UserProfile, tier: "light" | "tracked" | "delegation"): string {
  const templates = profile.templates[tier];
  return templates[Math.floor(Math.random() * templates.length)];
}

/**
 * 判断用户是否会纠正 OMA 的分类
 */
export function wouldCorrect(profile: UserProfile, predictedTier: string, actualTier: string): boolean {
  if (predictedTier === actualTier) return false;
  return Math.random() < profile.correctionRate;
}

/**
 * 随机选择一个纠正短语
 */
export function sampleCorrectionPhrase(
  profile: UserProfile,
  direction: "up" | "down",
): string {
  const phrases = profile.correctionPhrases[direction];
  return phrases[Math.floor(Math.random() * phrases.length)];
}
