/**
 * 功能开关。
 * AI 抠图 = @imgly/background-removal-node（ISNet 语义分割，本地 CPU 推理，模型随依赖装好，不联网）。
 * ISNet 是 U2Net 系列的改进版：靠「语义」判断前景，与色键（靠颜色）互补，
 * 主体和背景同色时也能分开。
 */
export const FEATURE_AI_MATTING = true;

/**
 * AI 抠图模型档位。
 * 这个 npm 包只随附 /models/small 与 /models/medium 两个权重（见 dist/resources.json），
 * 没有 large —— 写 'large' 会报 "Resource /models/large not found"。
 */
export const AI_MATTING_MODEL = 'medium' as const;
