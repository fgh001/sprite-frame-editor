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
  /** 文案 key：界面和主进程共用一份，按当前语言取（见 shared/err-i18n.ts） */
  labelKey: string;
}

/** 供界面选择的纯色背景（都便于做色键抠图） */
export const BACKGROUND_PRESETS: BackgroundChoice[] = [
  { color: '#FFFFFF', labelKey: 'bg.white' },
  { color: '#000000', labelKey: 'bg.black' },
  { color: '#00B140', labelKey: 'bg.green' },
  { color: '#0047AB', labelKey: 'bg.cobalt' },
  { color: '#808080', labelKey: 'bg.gray' },
  { color: '#FF00FF', labelKey: 'bg.magenta' },
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

  if (greanish) return { color: '#FF00FF', labelKey: 'bg.magentaAvoidGreen' };
  if (blueish) return { color: '#FF00FF', labelKey: 'bg.magentaAvoidBlue' };
  if (warmish) return { color: '#0047AB', labelKey: 'bg.cobaltAvoidWarm' };
  if (purpleish) return { color: '#00B140', labelKey: 'bg.greenAvoidPurple' };
  return { color: '#FF00FF', labelKey: 'bg.magentaDefault' };
}

/** 拼在用户提示词后面的硬约束，保证出图背景是纯色 */
export function buildBackgroundPrompt(color: string, text: (key: string, vars?: Record<string, string>) => string): string {
  return [
    '',
    text('bgPrompt.header'),
    text('bgPrompt.color', { color }),
    text('bgPrompt.flat'),
    text('bgPrompt.subject'),
  ].join('\n');
}
