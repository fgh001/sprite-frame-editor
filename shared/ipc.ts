/**
 * 主进程 ↔ 渲染层共享的 IPC 契约。
 * 统一返回 IpcResult，渲染层不需要 try/catch 就能处理失败。
 */
import type { Capability, ProviderId } from './providers';

export interface DataDirs {
  /** 便携数据根目录（安装目录 / 项目根下的 data） */
  root: string;
  /** 配置文件：settings.json 等 */
  config: string;
  /** 素材库根目录 */
  knowledge: string;
  /** 素材库原始素材根目录（下面按类型分 images / videos） */
  knowledgeFiles: string;
  /** 素材库缩略图根目录（下面按类型分 images / videos） */
  knowledgeThumbs: string;
  /** 素材库图片原文件 */
  knowledgeImages: string;
  /** 素材库视频原文件 */
  knowledgeVideos: string;
  /** 素材库图片缩略图 */
  knowledgeThumbImages: string;
  /** 素材库视频缩略图 */
  knowledgeThumbVideos: string;
  /** 可随时清理的缓存（视频抽帧等） */
  cache: string;
  /** 运行日志 */
  logs: string;
  /** 各阶段工程文件 */
  projects: string;
  /** 帧动画项目根目录 */
  frames: string;
  /** 抽帧集合：frames/sources/<项目>/ */
  frameSources: string;
  /** 抠图结果：frames/outputs/<项目>-matte/ */
  frameOutputs: string;
}

export interface AppInfo {
  name: string;
  version: string;
  isPackaged: boolean;
  platform: string;
  /** 完整数据目录，界面上要能直接看到，方便用户备份/迁移 */
  dataDir: string;
  dirs: DataDirs;
  versions: {
    electron: string;
    chrome: string;
    node: string;
  };
}

export interface IpcOk<T> {
  ok: true;
  data: T;
}

export interface IpcErr {
  ok: false;
  error: string;
}

export type IpcResult<T> = IpcOk<T> | IpcErr;

/* ------------------------------------------------------------------ */
/* 界面主题                                                            */
/* ------------------------------------------------------------------ */

export type ThemeMode = 'dark' | 'light';

/** 界面语言：简体中文 / 繁體中文 / English */
export type Lang = 'zh-CN' | 'zh-TW' | 'en';

/* ------------------------------------------------------------------ */
/* 能力槽位设置                                                        */
/* ------------------------------------------------------------------ */

/** API Key 的存储方式：encrypted = 系统 DPAPI 加密；plain = 明文回退（系统不支持加密时） */
export type KeyStorage = 'encrypted' | 'plain' | 'none';

export type SlotKey = Capability;

/** 某个服务商在该槽位下已保存的 Key（只有掩码） */
export interface SlotKeyEntry {
  providerId: ProviderId;
  keyMask: string;
  keyStorage: Exclude<KeyStorage, 'none'>;
}

/** 某个服务商在该槽位下上次使用的 Base URL / 模型 */
export interface SlotEndpoint {
  providerId: ProviderId;
  baseUrl: string;
  model: string;
}

/**
 * 单个能力槽位的设置视图 —— 永远不含明文 Key。
 * Key 与 Base URL / 模型都按「服务商」分别记忆：
 * 在文本槽位为豆包配过 Key，切回 DeepSeek 会拿回 DeepSeek 自己的那份。
 */
export interface SlotSettingsView {
  slot: SlotKey;
  /** 该槽位是否启用；停用后界面隐藏配置且不会被调用 */
  enabled: boolean;
  /** 当前选中的服务商 */
  providerId: ProviderId;
  baseUrl: string;
  model: string;
  /** 当前服务商是否有 Key */
  hasKey: boolean;
  /** 当前服务商的 Key 掩码，没有时为空串 */
  keyMask: string;
  keyStorage: KeyStorage;
  /** 该槽位下所有服务商的 Key（切换服务商时用来显示对应状态） */
  keyEntries: SlotKeyEntry[];
  /** 该槽位下所有服务商上次使用的 Base URL / 模型 */
  endpoints: SlotEndpoint[];
  /** 配置文件路径，界面上展示，方便用户自己查看 */
  configPath: string;
}

export interface SaveSlotInput {
  slot: SlotKey;
  providerId: ProviderId;
  baseUrl: string;
  model: string;
  /** 省略 = 不改动该服务商已存的 Key；空串 = 清除该服务商的 Key；其他 = 保存新 Key */
  apiKey?: string;
  /** 省略 = 不改动启用状态 */
  enabled?: boolean;
}

export interface ModelInfo {
  id: string;
  ownedBy?: string;
}

export interface BalanceLine {
  currency: string;
  /** 总余额 */
  total: string;
  /** 赠送 / 代金券余额 */
  granted?: string;
  /** 充值 / 现金余额 */
  toppedUp?: string;
}

export interface BalanceInfo {
  /** 该服务商是否提供余额接口 */
  supported: boolean;
  /** 账户是否可用（DeepSeek 提供该字段） */
  available: boolean;
  lines: BalanceLine[];
  /** 额外指标，例如 OpenRouter 的累计充值 / 已用 */
  extra: { label: string; value: string }[];
  fetchedAt: string;
  /** 不支持或调用失败时的说明 */
  message?: string;
}

export interface TestResult {
  ok: boolean;
  latencyMs: number;
  modelCount: number;
  message: string;
}

/* ------------------------------------------------------------------ */
/* 用量统计（服务商没有余额接口时的替代信息）                           */
/* ------------------------------------------------------------------ */

export interface UsageModelStat {
  model: string;
  count: number;
  /** 内置单价（元/张），未知模型为 undefined */
  unitPrice?: number;
  estimatedCost?: number;
}

export interface UsageStats {
  /** 素材库里 AI 生成的图片数（含编辑产物） */
  knowledgeImages: number;
  /** cache/generated 下未入库的生成文件数 */
  cachedFiles: number;
  totalImages: number;
  byModel: UsageModelStat[];
  /** 估算花费（元），有未知单价模型时为 null */
  estimatedCost: number | null;
  note: string;
}

/* ------------------------------------------------------------------ */
/* 图像生成                                                            */
/* ------------------------------------------------------------------ */

/** 自动背景色的分析结果 */
export interface BackgroundSuggestion {
  /** 建议的纯色背景（hex） */
  color: string;
  /** 为什么选这个颜色 */
  reason: string;
  /** ai = 文本模型分析得出；heuristic = 关键词回退 */
  source: 'ai' | 'heuristic';
}

/** AI 优化后的提示词（只回填到输入框，不会自动提交生成） */
export interface OptimizePromptResult {
  prompt: string;
  /** ai = 文本模型改写；unchanged = 未改动（例如原文为空） */
  source: 'ai' | 'unchanged';
}

export interface GenerateImageInput {
  prompt: string;
  /** 直接透传给服务商的尺寸，例如 2K / 1024x1024 */
  size: string;
  count: number;
  /** 勾选后生成的图同时登记进素材库 */
  saveToKnowledge: boolean;
  /** 纯色背景色（hex，如 #00B140）；主进程会写进提示词并记进素材库 */
  backgroundColor: string;
}

/* ------------------------------------------------------------------ */
/* 循环视频（图片 → 循环视频）                                          */
/* ------------------------------------------------------------------ */

export interface GenerateLoopVideoInput {
  /** 作为首帧（同时作为尾帧，做成无缝循环）的图片绝对路径 */
  imageAbsPath: string;
  /** 动作/画面描述，可留空 */
  prompt: string;
  /** 时长（秒） */
  duration: number;
  resolution: '480p' | '720p' | '1080p';
  /**
   * direct = 首帧+尾帧（首尾同一张图，天然循环）
   * reference = 用素材库里的图片作为参考图生成（需要支持多模态参考的模型，如 Seedance 2.0+）
   */
  mode: 'direct' | 'reference';
  /** mode=reference 时的参考图绝对路径（1–4 张） */
  referenceImagePaths?: string[];
  /** 锁定纯色背景：提示词里强制背景保持不变，防止 AI 生成新场景（默认 true） */
  lockBackground?: boolean;
}

export type LoopVideoStage = 'submitting' | 'queued' | 'running' | 'downloading' | 'done' | 'failed';

export interface LoopVideoProgress {
  stage: LoopVideoStage;
  message: string;
  taskId?: string;
  /** 0-100，仅用于粗略展示 */
  percent?: number;
}

export interface GenerateLoopVideoResult {
  taskId: string;
  id: string;
  fileName: string;
  absPath: string;
  bytes: number;
  durationSeconds: number;
  resolution: string;
  elapsedMs: number;
  inKnowledge: boolean;
}

export interface GeneratedImage {
  id: string;
  fileName: string;
  /** 原图绝对路径（界面预览用缩略图，点「打开目录」看原图） */
  absPath: string;
  width: number;
  height: number;
  bytes: number;
  inKnowledge: boolean;
  /** 缩略图 data URL，供界面直接预览 */
  thumbDataUrl: string;
  /** 生成时使用的纯色背景色（编辑去背景时作为初始背景色） */
  backgroundColor: string;
}

export interface GenerateImageResult {
  providerId: ProviderId;
  model: string;
  prompt: string;
  images: GeneratedImage[];
  elapsedMs: number;
  /** 实际发给服务商的纯色背景色 */
  backgroundColor: string;
  /** 本次估算花费（元）；单价未知时为 null */
  estimatedCost: number | null;
}

/* ------------------------------------------------------------------ */
/* 图片编辑                                                            */
/* ------------------------------------------------------------------ */

export interface EditableImage {
  absPath: string;
  fileName: string;
  dataUrl: string;
  width: number;
  height: number;
  bytes: number;
  /** 生成时记录过的纯色背景色，没有则为空串 */
  backgroundColor: string;
}

export interface SaveEditedImageInput {
  /** 被编辑的原图绝对路径（必须在数据目录内） */
  sourceAbsPath: string;
  /** 编辑结果的 PNG base64（可带 data:image/png;base64, 前缀） */
  pngBase64: string;
  note?: string;
}

/** AI 抠图结果 */
export interface AiMattingResult {
  /** 处理后的 PNG（带 alpha）data URL */
  dataUrl: string;
  width: number;
  height: number;
  bytes: number;
  elapsedMs: number;
}

/* ------------------------------------------------------------------ */
/* 素材库                                                              */
/* ------------------------------------------------------------------ */

export type KnowledgeKind = 'image' | 'video';

/**
 * 素材库条目：**完全由磁盘文件推导**，没有任何索引/元数据。
 *
 * 文件名就是身份 —— 用户可以在资源管理器里自由增删改名，界面跟着变。
 * 代价：标签、备注、生成来源都不保存（这些需要额外的索引文件，已按要求移除）。
 */
export interface KnowledgeItem {
  id: string;
  fileName: string;
  kind: KnowledgeKind;
  bytes: number;
  width?: number;
  height?: number;
  durationMs?: number;
  createdAt: string;
}

/** 供界面直接渲染的素材库条目（带 kbmedia 协议的预览地址） */
export interface KnowledgeView extends KnowledgeItem {
  /** 原图/原视频预览地址（kbmedia://file/<fileName>） */
  mediaUrl: string;
  /** 缩略图地址（kbmedia://thumb/<id>.png），没有缩略图时为空串 */
  thumbUrl: string;
  /** 原文件绝对路径，用于定位/编辑 */
  absPath: string;
}

export interface ImportResult {
  imported: number;
  skippedDuplicates: number;
  skippedUnsupported: number;
  items: KnowledgeView[];
}

/* ------------------------------------------------------------------ */
/* 帧动画（视频 → 帧序列，一个项目 = data/frames 下一个文件夹）           */
/* ------------------------------------------------------------------ */

export interface FrameProjectMeta {
  id: string;
  /** 文件夹名（用户可自定义） */
  name: string;
  /** 来源视频文件名 */
  sourceVideo: string;
  /** 抽帧后的帧率 */
  fps: number;
  frameCount: number;
  width: number;
  height: number;
  /** 抽帧时是否已批量去背景 */
  backgroundRemoved: boolean;
  createdAt: string;
}

/** 批量抠图的输出目录（和原始帧分开存，方便对比和定位） */
export interface FrameProjectOutput {  /** matte = 模型抠图；key = 传统抠图 */
  kind: 'matte' | 'key';
  /** 目录名，例如 walk-matte */
  name: string;
  /** 绝对路径 */
  absPath: string;
  frameCount: number;
  /** 前几帧的预览地址（kbmedia://frame/walk-matte/frame_000.png），用于列表里显示缩略图 */
  previewUrls: string[];
}

export interface FrameProjectView extends FrameProjectMeta {
  /** 项目文件夹绝对路径 */
  absPath: string;
  /** 每帧预览地址（kbmedia://frame/<id>/<fileName>） */
  frameUrls: string[];
  frameFileNames: string[];
  /** 已经跑过的批量抠图输出（-matte / -key），用于在列表里单独定位 */
  outputs: FrameProjectOutput[];
}

/**
 * 抠图结果目录（独立于源集合存在）。
 * 用户删掉源集合后，outputs/ 里的结果仍然需要能列出、播放、删除。
 */
export interface FrameOutputView {
  /** 目录名，例如 walk-matte */
  name: string;
  /** matte = 模型抠图；key = 传统抠图 */
  kind: 'matte' | 'key';
  /** 绝对路径 */
  absPath: string;
  frameCount: number;
  /** 全部帧的预览地址（kbmedia://output/<目录名>/<文件名>） */
  previewUrls: string[];
  /** 源集合名（去掉 -matte / -key 后缀），源集合可能已被删除 */
  sourceName: string;
}

export interface SaveFrameProjectInput {
  /** 文件夹名，留空则自动生成 */
  name: string;
  sourceVideo: string;
  fps: number;
  width: number;
  height: number;
  backgroundRemoved: boolean;
  /** 按顺序的 PNG dataURL */
  frames: string[];
}

/* ------------------------------------------------------------------ */
/* 右侧 AI 助手（问答窗口，走文本槽位的模型）                            */
/* ------------------------------------------------------------------ */

export interface AssistantMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface AssistantReply {
  reply: string;
  /** 实际使用的模型，界面上显示出来便于确认走的是哪个槽位 */
  model: string;
}

/**
 * 渲染层可见的 API（由 preload 通过 contextBridge 暴露为 window.skeletonElf）。
 *
 * 关于这个名字：`skeletonElf`（骨骼精灵）是项目早期的代号，当时打算做骨骼动画。
 * 现在骨骼/绑定的功能已经彻底移除，名字和功能对不上了 —— 但它出现在 100+ 处调用里，
 * 改名的收益远小于出错风险，所以保留（它是**内部**通道名，用户看不到）。
 *
 * **对外展示的名称统一是「精灵帧动画编辑器」/ `SpriteFrameEditor`**，与此无关：
 *   - 窗口标题 / 界面标题：见 electron/main.ts、src/App.tsx
 *   - exe 文件名 / userData 目录：package.json 的 productName
 *   - 版本号徽章：app.getVersion()
 */
export interface SkeletonElfApi {
  app: {
    info(): Promise<IpcResult<AppInfo>>;
    openDataDir(): Promise<IpcResult<null>>;
  };
  ui: {
    getTheme(): Promise<IpcResult<ThemeMode>>;
    setTheme(theme: ThemeMode): Promise<IpcResult<ThemeMode>>;
    /** 界面语言（简中 / 繁中 / EN），存在 data/config/ui.json */
    getLang(): Promise<IpcResult<Lang>>;
    setLang(lang: Lang): Promise<IpcResult<Lang>>;
  };
  settings: {
    /** 返回 chat / image / video 三个槽位的设置 */
    getSlots(): Promise<IpcResult<SlotSettingsView[]>>;
    saveSlot(input: SaveSlotInput): Promise<IpcResult<SlotSettingsView>>;
    /** 启用 / 停用某个槽位（停用后界面隐藏配置，也不会被调用） */
    setSlotEnabled(slot: SlotKey, enabled: boolean): Promise<IpcResult<SlotSettingsView>>;
    /** 清除某槽位下指定服务商的 Key（省略 providerId 时清当前服务商） */
    clearSlotKey(slot: SlotKey, providerId?: ProviderId): Promise<IpcResult<SlotSettingsView>>;
    /** 把 from 槽位里同一服务商的 Key 复制到 to 槽位（同一把豆包 Key 可三处共用） */
    copySlotKey(from: SlotKey, to: SlotKey, providerId?: ProviderId): Promise<IpcResult<SlotSettingsView>>;
  };
  ai: {
    /** 用指定槽位打一次 /models，验证 Key 与连通性 */
    test(slot: SlotKey): Promise<IpcResult<TestResult>>;
    models(slot: SlotKey): Promise<IpcResult<ModelInfo[]>>;
    /** 查询余额（用 chat 槽位的服务商） */
    balance(): Promise<IpcResult<BalanceInfo>>;
    /** 图像生成：结果自动落盘，可选登记进素材库 */
    generateImage(input: GenerateImageInput): Promise<IpcResult<GenerateImageResult>>;
    /** 本地用量统计（服务商没有余额接口时用） */
    usage(): Promise<IpcResult<UsageStats>>;
    /** 让文本模型分析主体主色，给出对比最大的纯色背景 */
    suggestBackground(prompt: string): Promise<IpcResult<BackgroundSuggestion>>;
  };
  assistant: {
    /** 右侧问答窗口：整段历史发过去，用文本槽位的模型回答 */
    chat(messages: AssistantMessage[]): Promise<IpcResult<AssistantReply>>;
  };
  video: {
    /** 图片 → 循环视频（首帧=尾帧）；进度通过 onProgress 推送 */
    generateLoop(input: GenerateLoopVideoInput): Promise<IpcResult<GenerateLoopVideoResult>>;
    /** 订阅生成进度，返回取消订阅函数 */
    onProgress(listener: (progress: LoopVideoProgress) => void): () => void;
  };
  prompts: {
    /** 用文本模型优化提示词，只回填输入框，不触发任何生成 */
    optimize(prompt: string, kind: 'image' | 'video'): Promise<IpcResult<OptimizePromptResult>>;
  };
  files: {
    /** 打开数据目录：素材库原图 / 生成缓存 / 数据根目录 */
    openDir(kind: 'knowledge' | 'cache' | 'root'): Promise<IpcResult<null>>;
    /** 在资源管理器中定位某个文件（必须在数据目录内） */
    reveal(absPath: string): Promise<IpcResult<null>>;
    /** 读取图片为 data URL，供编辑器使用 */
    readImage(absPath: string): Promise<IpcResult<EditableImage>>;
    /** AI 语义分割抠图（本地 ONNX 模型，与颜色无关） */
    removeBackground(absPath: string): Promise<IpcResult<AiMattingResult>>;
    /** BiRefNet 抠图（rembg 同款模型，纯 ONNX 推理，不依赖 Python） */
    removeBackgroundBirefnet(
      absPath: string,
      options?: { threshold?: number; feather?: number },
    ): Promise<IpcResult<AiMattingResult>>;
    /** BiRefNet 模型是否已就位（权重放在 data/models/） */
    birefnetStatus(): Promise<IpcResult<{ available: boolean; modelPath: string; sizeMb: number }>>;
    /**
     * 走官方 rembg（pyshim/python.exe + rembg 包）抠图。
     * 模型名直接透传给 rembg 的 new_session，例如 birefnet-general / u2net / isnet-anime。
     */
    rembgRemove(
      absPath: string,
      options?: { model?: string; alphaMatting?: boolean; noDecontaminate?: boolean },
    ): Promise<IpcResult<AiMattingResult>>;
    /** pyshim 里的 rembg 是否可用 */
    rembgStatus(): Promise<IpcResult<{ available: boolean; message: string }>>;
    /** 本地已下载的 rembg 模型列表（下拉只列这些，避免现场下载超时） */
    rembgModels(): Promise<IpcResult<{ name: string; sizeMb: number }[]>>;
    /**
     * 对磁盘上的帧目录找循环点并裁掉尾部多余帧。
     * dryRun=true 只算不删（先给用户看会裁多少帧）。
     */
    trimLoop(
      frameDir: string,
      dryRun?: boolean,
      prefer?: number,
      /** 保留几个循环；不传 = 全部。传 1 就是「4 个循环缩成 1 个」 */
      keepCycles?: number,
    ): Promise<
      IpcResult<{
        kept: number;
        removed: number;
        loopFrame: number;
        score: number;
        cycleLength: number;
        cycles: number;
      }>
    >;
    /**
     * 批量抠图：对帧项目目录整体处理（模型只加载一次），输出到「目录-matte」。
     * 进度通过 rembg:batchProgress 事件推送。
     */
    rembgBatch(
      frameDir: string,
      options?: {
        model?: string;
        alphaMatting?: boolean;
        noDecontaminate?: boolean;
        workers?: number;
      },
      jobId?: string,
    ): Promise<IpcResult<{ total: number; elapsedMs: number; errors: string[]; outDir: string }>>;
    /** 强制停止正在跑的批量抠图（kill 掉 Python 子进程） */
    rembgCancel(jobId: string): Promise<IpcResult<{ cancelled: boolean }>>;
    /** 订阅批量抠图进度，返回取消订阅函数 */
    onRembgBatchProgress(
      handler: (progress: { done: number; total: number; file: string }) => void,
    ): () => void;
    /** 取帧项目第一帧的四角平均色，作为传统抠图的背景色初值 */
    sampleFrameBackground(frameDir: string): Promise<IpcResult<{ r: number; g: number; b: number }>>;
    /** 批量传统抠图（颜色键控），输出到「<目录>-key」 */
    batchKeyOut(
      frameDir: string,
      options: {
        colors: Array<{ r: number; g: number; b: number }>;
        tolerance: number;
        mode: 'global' | 'connected';
        edgeTrim?: number;
      },
    ): Promise<IpcResult<{ total: number; elapsedMs: number; skipped: string[]; outDir: string }>>;
    /** 保存编辑结果为新素材（写入素材库） */
    saveEdited(input: SaveEditedImageInput): Promise<IpcResult<GeneratedImage>>;
    /**
     * 读取素材库媒体文件的原始字节（图片/视频）。
     * 渲染层拼成 blob URL 使用 —— 同源，画布不会被污染，也不依赖协议 CORS。
     */
    readMedia(fileName: string): Promise<IpcResult<{ data: Uint8Array; mime: string }>>;
  };
  knowledge: {
    /** 列出素材库全部素材（含 kbmedia 预览地址） */
    list(): Promise<IpcResult<KnowledgeView[]>>;
    /** 弹文件选择框，把图片/视频导入素材库（内容去重） */
    importFiles(): Promise<IpcResult<ImportResult>>;
    /** 重命名素材文件（改磁盘文件名；重名报错，不覆盖） */
    rename(id: string, name: string): Promise<IpcResult<KnowledgeView>>;
    /** 从素材库删除（同时删掉原文件与缩略图） */
    remove(id: string): Promise<IpcResult<null>>;
    /**
     * 订阅素材容器目录的变化：用户直接在 data/knowledge/files/images、
     * files/videos 里拷入 / 删除 / 改名文件时触发，界面据此自动刷新。
     * 返回取消订阅函数。
     */
    onMediaChanged(handler: () => void): () => void;
  };
  frames: {
    /** 列出全部帧动画项目（data/frames/sources 下每个文件夹一个项目） */
    list(): Promise<IpcResult<FrameProjectView[]>>;
    /** 独立列出 data/frames/outputs 下的抠图结果（不依赖源集合是否还在） */
    listOutputs(): Promise<IpcResult<FrameOutputView[]>>;
    /** 把抽好的帧写成新项目（一个项目一个文件夹，可自定义名称） */
    save(input: SaveFrameProjectInput): Promise<IpcResult<FrameProjectView>>;
    /** 重命名帧集合（改磁盘文件夹名 + meta.json；重名报错，不覆盖） */
    rename(id: string, name: string): Promise<IpcResult<FrameProjectView>>;
    /** 重命名抠图结果目录（保留 -matte / -key 后缀；重名报错，不覆盖） */
    renameOutput(name: string, nextName: string): Promise<IpcResult<string>>;
    /** 删除整个项目文件夹 */
    remove(id: string): Promise<IpcResult<null>>;
    /** 删掉集合里的某一帧（找循环帧后手动剔多余帧用） */
    removeFrame(id: string, fileName: string): Promise<IpcResult<{ frameCount: number }>>;
    /**
     * 用编辑器改完的单帧 PNG 覆盖磁盘上的这一帧。
     * 只允许写 data/frames/sources/<集合>/frame_XXX.png，不会碰其他位置。
     */
    writeFrame(id: string, fileName: string, pngBase64: string): Promise<IpcResult<null>>;
    /** 在资源管理器中打开帧动画项目目录 */
    openDir(id?: string): Promise<IpcResult<null>>;
  };
}
