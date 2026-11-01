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
  /** 显示名/说明的文案 key（三语，见 shared/err-i18n.ts） */
  labelKey: string;
  noteKey: string;
  baseUrl: string;
  /** 该服务商支持哪些能力槽位 */
  capabilities: Capability[];
  /** 各槽位的默认模型；没列出的槽位表示该服务商不支持，空串也表示不支持 */
  models: Partial<Record<Capability, string>>;
  balance: BalanceKind;
  requiresKey: boolean;
}

export const CAPABILITY_LABEL_KEYS: Record<Capability, string> = {
  chat: 'cap.chat',
  image: 'cap.image',
  video: 'cap.video',
};

export const PROVIDER_PRESETS: ProviderPreset[] = [
  {
    id: 'doubao',
    labelKey: 'provider.doubao.label',
    noteKey: 'provider.doubao.note',
    baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
    capabilities: ['chat', 'image', 'video'],
    models: {
      chat: 'doubao-seed-1-6-250615',
      image: 'doubao-seedream-5-0-flash-260915',
      video: 'doubao-seedance-2-5-260628',
    },
    balance: 'none',
    requiresKey: true,
  },
  {
    id: 'deepseek',
    labelKey: 'provider.deepseek.label',
    noteKey: 'provider.deepseek.note',
    baseUrl: 'https://api.deepseek.com/v1',
    capabilities: ['chat'],
    models: { chat: 'deepseek-chat', image: '', video: '' },
    balance: 'deepseek',
    requiresKey: true,
  },
  {
    id: 'openai',
    labelKey: 'provider.openai.label',
    noteKey: 'provider.openai.note',
    baseUrl: 'https://api.openai.com/v1',
    capabilities: ['chat', 'image'],
    models: { chat: 'gpt-4o-mini', image: 'gpt-image-1', video: '' },
    balance: 'none',
    requiresKey: true,
  },
  {
    id: 'siliconflow',
    labelKey: 'provider.siliconflow.label',
    noteKey: 'provider.siliconflow.note',
    baseUrl: 'https://api.siliconflow.cn/v1',
    capabilities: ['chat', 'image'],
    models: { chat: 'Qwen/Qwen2.5-7B-Instruct', image: 'black-forest-labs/FLUX.1-schnell', video: '' },
    balance: 'none',
    requiresKey: true,
  },
  {
    id: 'zhipu',
    labelKey: 'provider.zhipu.label',
    noteKey: 'provider.zhipu.note',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    capabilities: ['chat', 'image'],
    models: { chat: 'glm-4-flash', image: 'cogview-3-flash', video: '' },
    balance: 'none',
    requiresKey: true,
  },
  {
    id: 'openrouter',
    labelKey: 'provider.openrouter.label',
    noteKey: 'provider.openrouter.note',
    baseUrl: 'https://openrouter.ai/api/v1',
    capabilities: ['chat'],
    models: { chat: 'openai/gpt-4o-mini', image: '', video: '' },
    balance: 'openrouter',
    requiresKey: true,
  },
  {
    id: 'moonshot',
    labelKey: 'provider.moonshot.label',
    noteKey: 'provider.moonshot.note',
    baseUrl: 'https://api.moonshot.cn/v1',
    capabilities: ['chat'],
    models: { chat: 'moonshot-v1-8k', image: '', video: '' },
    balance: 'moonshot',
    requiresKey: true,
  },
  {
    id: 'qwen',
    labelKey: 'provider.qwen.label',
    noteKey: 'provider.qwen.note',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    capabilities: ['chat'],
    models: { chat: 'qwen-plus', image: '', video: '' },
    balance: 'none',
    requiresKey: true,
  },
  {
    id: 'ollama',
    labelKey: 'provider.ollama.label',
    noteKey: 'provider.ollama.note',
    baseUrl: 'http://localhost:11434/v1',
    capabilities: ['chat'],
    models: { chat: 'llama3.2', image: '', video: '' },
    balance: 'none',
    requiresKey: false,
  },
  {
    id: 'custom',
    labelKey: 'provider.custom.label',
    noteKey: 'provider.custom.note',
    baseUrl: '',
    capabilities: ['chat', 'image', 'video'],
    models: { chat: '', image: '', video: '' },
    balance: 'none',
    requiresKey: true,
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
