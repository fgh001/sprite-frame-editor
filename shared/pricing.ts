/**
 * 图像生成单价表（元/张）与花费估算。主进程与渲染层共用。
 * 价格变了直接改这里；未列出的模型返回 null（不瞎猜）。
 */
export const IMAGE_UNIT_PRICE: Record<string, number> = {
  'doubao-seedream-5-0-flash-260915': 0.12,
  'doubao-seedream-5-0-pro-260628': 0.3,
  'doubao-seedream-4-5-251128': 0.25,
  'doubao-seedream-4-0-250828': 0.2,
  'doubao-seedream-3-0-t2i-250415': 0.2,
  'gpt-image-1': 0.3,
  'black-forest-labs/FLUX.1-schnell': 0.05,
  'cogview-3-flash': 0,
};

export function unitPriceOf(model: string): number | undefined {
  return IMAGE_UNIT_PRICE[model];
}

/** 按张数估算花费；单价未知时返回 null */
export function estimateImageCost(model: string, count: number): number | null {
  const price = IMAGE_UNIT_PRICE[model];
  if (price === undefined) return null;
  return Number((price * Math.max(count, 0)).toFixed(2));
}

/* ------------------------------------------------------------------ */
/* 背景色：纯色背景 + 与主体撞色避让                                     */
/* ------------------------------------------------------------------ */

export interface BackgroundChoice {
  /** hex 颜色，例如 #FFFFFF */
  color: string;
  label: string;
}

/** 供界面选择的纯色背景（都便于做色键抠图） */
export const BACKGROUND_PRESETS: BackgroundChoice[] = [
  { color: '#FFFFFF', label: '纯白' },
  { color: '#000000', label: '纯黑' },
  { color: '#00B140', label: '绿幕' },
  { color: '#0047AB', label: '钴蓝' },
  { color: '#808080', label: '中灰' },
  { color: '#FF00FF', label: '洋红' },
];

/**
 * 「自动」模式的关键词回退（真正的分析在 electron/services/ai.ts 里调用文本模型）。
 * 只按提示词猜主体色调；猜不出时默认洋红 —— 自然界最少见，撞色概率最低。
 */
export function pickAutoBackground(prompt: string): BackgroundChoice {
  const text = prompt.toLowerCase();
  const greanish =
    /green|绿|草|forest|森林|叶|leaf|elf|精灵|自然|nature|moss|苔|藤|vine|蘑菇|mushroom|毒|poison|德鲁伊|druid/.test(
      text,
    );
  const blueish = /blue|蓝|水|water|ice|冰|sky|天空|海|sea|ocean|霜|frost|雪|snow/.test(text);
  const warmish = /red|红|fire|火|orange|橙|yellow|黄|gold|金|棕|brown|木|wood|沙|sand|铜|copper/.test(text);
  const purpleish = /purple|紫|magenta|洋红|粉|pink|violet|薰衣草|lavender/.test(text);

  if (greanish) return { color: '#FF00FF', label: '洋红（避开绿色主体）' };
  if (blueish) return { color: '#FF00FF', label: '洋红（避开蓝色主体）' };
  if (warmish) return { color: '#0047AB', label: '钴蓝（避开暖色主体）' };
  if (purpleish) return { color: '#00B140', label: '绿幕（避开紫/粉主体）' };
  return { color: '#FF00FF', label: '洋红（默认，撞色概率最低）' };
}

/** 拼在用户提示词后面的硬约束，保证出图背景是纯色 */
export function buildBackgroundPrompt(color: string): string {
  return [
    '',
    '【背景要求】',
    `- 使用单一纯色背景，颜色严格为 ${color}`,
    '- 背景必须完全平整：无渐变、无纹理、无阴影、无地面、无道具、无其他角色',
    '- 主体完整居中，轮廓清晰，边缘干净，不要有与背景融合的柔光或烟雾',
  ].join('\n');
}
