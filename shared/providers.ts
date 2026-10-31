/**
 * 大模型服务商预设。主进程与渲染层共用（纯常量，无副作用）。
 *
 * 关键设计：按「能力槽位」组织，而不是一个模型包打天下。
 *  - chat ：文本 / 推理，写提示词、解析需求
 *  - image：图像生成，产出立绘 / 精灵图素材
 *  - video：视频生成，图片 → 循环视频
 * 同一个服务商可以同时具备多种能力（例如豆包三样都行）。
 */

export type ProviderId =
  | 'doubao'
  | 'deepseek'
  | 'openai'
  | 'openrouter'
  | 'moonshot'
  | 'zhipu'
  | 'qwen'
  | 'siliconflow'
  | 'ollama'
  | 'custom';

/** 能力槽位 */
export type Capability = 'chat' | 'image' | 'video';

/** 余额查询的接口形态；none 表示该服务商没有公开的余额接口 */
export type BalanceKind = 'deepseek' | 'openrouter' | 'moonshot' | 'none';

export interface ProviderPreset {
  id: ProviderId;
  label: string;
  baseUrl: string;
  /** 该服务商支持哪些能力槽位 */
  capabilities: Capability[];
  /** 各槽位的默认模型；没列出的槽位表示该服务商不支持，空串也表示不支持 */
  models: Partial<Record<Capability, string>>;
  balance: BalanceKind;
  requiresKey: boolean;
  note: string;
}

export const CAPABILITY_LABELS: Record<Capability, string> = {
  chat: '文本 / 推理',
  image: '图像生成',
  video: '视频生成',
};

export const PROVIDER_PRESETS: ProviderPreset[] = [
  {
    id: 'doubao',
    label: '豆包 · 火山方舟（图片 / 视频 / 文本）',
    baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
    capabilities: ['chat', 'image', 'video'],
    models: {
      chat: 'doubao-seed-1-6-250615',
      image: 'doubao-seedream-5-0-flash-260915',
      video: 'doubao-seedance-2-5-260628',
    },
    balance: 'none',
    requiresKey: true,
    note:
      '图片默认用 Seedream 5.0-flash：0.12 元/张（不分分辨率档位，约 15–20 秒出图，支持透明背景 / 图层拆分 / 图生图），比 5.0-pro（0.3 元/张）便宜 2.5 倍、快 6 倍；要极致画质可切到 doubao-seedream-5-0-pro-260628。视频用 Seedance 2.5（1.0 已下架）：480P/720P 70 元、1080P 77 元每百万 tokens（5 秒 480P ≈ 3.36 元），且官方要求账户余额 ≥ 200 元才能开通。返回的 URL 24 小时后失效，本应用会立刻下载存档。',
  },
  {
    id: 'deepseek',
    label: 'DeepSeek 深度求索（文本）',
    baseUrl: 'https://api.deepseek.com/v1',
    capabilities: ['chat'],
    models: { chat: 'deepseek-chat', image: '', video: '' },
    balance: 'deepseek',
    requiresKey: true,
    note:
      '只能做文本 / 看图理解，不能生图。deepseek-chat 会路由到 deepseek-flash（输入支持图片，可直接喂素材库参考图），另有 deepseek-v4-pro。',
  },
  {
    id: 'openai',
    label: 'OpenAI（文本 / 图像）',
    baseUrl: 'https://api.openai.com/v1',
    capabilities: ['chat', 'image'],
    models: { chat: 'gpt-4o-mini', image: 'gpt-image-1', video: '' },
    balance: 'none',
    requiresKey: true,
    note: '图像走 Images API（gpt-image-1）。官方没有公开余额接口，额度到 platform.openai.com 查看。',
  },
  {
    id: 'siliconflow',
    label: 'SiliconFlow 硅基流动（文本 / 图像）',
    baseUrl: 'https://api.siliconflow.cn/v1',
    capabilities: ['chat', 'image'],
    models: { chat: 'Qwen/Qwen2.5-7B-Instruct', image: 'black-forest-labs/FLUX.1-schnell', video: '' },
    balance: 'none',
    requiresKey: true,
    note: '国内可充值，图像模型如 FLUX.1、Kolors；接口为 OpenAI 兼容 /images/generations。',
  },
  {
    id: 'zhipu',
    label: '智谱 GLM（文本 / 图像）',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    capabilities: ['chat', 'image'],
    models: { chat: 'glm-4-flash', image: 'cogview-3-flash', video: '' },
    balance: 'none',
    requiresKey: true,
    note: 'CogView 系列出图，接口为 OpenAI 兼容模式。',
  },
  {
    id: 'openrouter',
    label: 'OpenRouter（文本）',
    baseUrl: 'https://openrouter.ai/api/v1',
    capabilities: ['chat'],
    models: { chat: 'openai/gpt-4o-mini', image: '', video: '' },
    balance: 'openrouter',
    requiresKey: true,
    note: '聚合多家文本模型，支持查询 credit / 已用量。',
  },
  {
    id: 'moonshot',
    label: 'Kimi（月之暗面，文本）',
    baseUrl: 'https://api.moonshot.cn/v1',
    capabilities: ['chat'],
    models: { chat: 'moonshot-v1-8k', image: '', video: '' },
    balance: 'moonshot',
    requiresKey: true,
    note: '支持查询账户余额（含代金券 / 现金）。',
  },
  {
    id: 'qwen',
    label: '通义千问（文本）',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    capabilities: ['chat'],
    models: { chat: 'qwen-plus', image: '', video: '' },
    balance: 'none',
    requiresKey: true,
    note: '使用 compatible-mode 兼容接口；万相出图是另一套异步接口，暂未接入。',
  },
  {
    id: 'ollama',
    label: 'Ollama（本地文本）',
    baseUrl: 'http://localhost:11434/v1',
    capabilities: ['chat'],
    models: { chat: 'llama3.2', image: '', video: '' },
    balance: 'none',
    requiresKey: false,
    note: '本机运行，无需 API Key（需先启动 ollama serve）。',
  },
  {
    id: 'custom',
    label: '自定义（OpenAI 兼容 / 中转站）',
    baseUrl: '',
    capabilities: ['chat', 'image', 'video'],
    models: { chat: '', image: '', video: '' },
    balance: 'none',
    requiresKey: true,
    note: '填任意 OpenAI 兼容接口：文本走 /chat/completions、图像走 /images/generations。',
  },
];

export function getProviderPreset(id: ProviderId): ProviderPreset {
  return PROVIDER_PRESETS.find((preset) => preset.id === id) ?? PROVIDER_PRESETS[0];
}

/** 某能力槽位可选的预设 */
export function presetsFor(capability: Capability): ProviderPreset[] {
  return PROVIDER_PRESETS.filter((preset) => preset.capabilities.includes(capability));
}

export function supportsCapability(preset: ProviderPreset, capability: Capability): boolean {
  return preset.capabilities.includes(capability);
}

/** 余额查询能力的中文说明，给界面用 */
export function describeBalanceSupport(kind: BalanceKind): string {
  switch (kind) {
    case 'deepseek':
    case 'moonshot':
    case 'openrouter':
      return '支持余额查询';
    default:
      return '该服务商未提供余额查询接口';
  }
}
