import { contextBridge, ipcRenderer } from 'electron';
import type {
  AssistantMessage,
  GenerateImageInput,
  GenerateLoopVideoInput,
  Lang,
  LoopVideoProgress,
  SaveEditedImageInput,
  SaveFrameProjectInput,
  SaveSlotInput,
  SkeletonElfApi,
  SlotKey,
  ThemeMode,
} from '../shared/ipc';
import type { ProviderId } from '../shared/providers';

/**
 * 渲染层唯一的通道：只暴露白名单方法，绝不暴露 ipcRenderer / node API。
 * API Key 只在主进程解密使用，渲染层拿到的永远是掩码。
 */
const api: SkeletonElfApi = {
  app: {
    info: () => ipcRenderer.invoke('app:info'),
    openDataDir: () => ipcRenderer.invoke('app:openDataDir'),
  },
  ui: {
    getTheme: () => ipcRenderer.invoke('ui:getTheme'),
    setTheme: (theme: ThemeMode) => ipcRenderer.invoke('ui:setTheme', theme),
    getLang: () => ipcRenderer.invoke('ui:getLang'),
    setLang: (lang: Lang) => ipcRenderer.invoke('ui:setLang', lang),
  },
  settings: {
    getSlots: () => ipcRenderer.invoke('settings:getSlots'),
    saveSlot: (input: SaveSlotInput) => ipcRenderer.invoke('settings:saveSlot', input),
    clearSlotKey: (slot: SlotKey, providerId?: ProviderId) => ipcRenderer.invoke('settings:clearSlotKey', slot, providerId),
    setSlotEnabled: (slot: SlotKey, enabled: boolean) => ipcRenderer.invoke('settings:setSlotEnabled', slot, enabled),
    copySlotKey: (from: SlotKey, to: SlotKey, providerId?: ProviderId) =>
      ipcRenderer.invoke('settings:copySlotKey', from, to, providerId),
  },
  ai: {
    test: (slot: SlotKey) => ipcRenderer.invoke('ai:test', slot),
    models: (slot: SlotKey) => ipcRenderer.invoke('ai:models', slot),
    balance: () => ipcRenderer.invoke('ai:balance'),
    generateImage: (input: GenerateImageInput) => ipcRenderer.invoke('ai:generateImage', input),
    usage: () => ipcRenderer.invoke('ai:usage'),
    suggestBackground: (prompt: string) => ipcRenderer.invoke('ai:suggestBackground', prompt),
  },
  assistant: {
    chat: (messages: AssistantMessage[]) => ipcRenderer.invoke('ai:assistantChat', messages),
  },
  files: {
    openDir: (kind: 'knowledge' | 'cache' | 'root') =>
      ipcRenderer.invoke('files:openDir', kind),
    reveal: (absPath: string) => ipcRenderer.invoke('files:reveal', absPath),
    readImage: (absPath: string) => ipcRenderer.invoke('files:readImage', absPath),
    removeBackground: (absPath: string) => ipcRenderer.invoke('files:removeBackground', absPath),
    removeBackgroundBirefnet: (absPath: string, options?: { threshold?: number; feather?: number }) =>
      ipcRenderer.invoke('files:removeBackgroundBirefnet', absPath, options),
    birefnetStatus: () => ipcRenderer.invoke('files:birefnetStatus'),
    rembgRemove: (
      absPath: string,
      options?: { model?: string; alphaMatting?: boolean; noDecontaminate?: boolean },
    ) => ipcRenderer.invoke('files:rembgRemove', absPath, options),
    rembgStatus: () => ipcRenderer.invoke('files:rembgStatus'),
    /** 本地已下载的 rembg 模型（只有这些能选，避免现场下载超时） */
    rembgModels: () => ipcRenderer.invoke('files:rembgModels'),
    rembgBatch: (
      frameDir: string,
      options?: {
        model?: string;
        alphaMatting?: boolean;
        noDecontaminate?: boolean;
        workers?: number;
      },
      jobId?: string,
    ) => ipcRenderer.invoke('files:rembgBatch', frameDir, options, jobId),
    /** 强制停止正在跑的批量抠图（kill 掉 Python 子进程） */
    rembgCancel: (jobId: string) => ipcRenderer.invoke('files:rembgCancel', jobId),
    /** 找循环点并裁掉尾部多余帧；dryRun=true 只算不删，prefer 0–100 控制搜索位置偏好 */
    trimLoop: (frameDir: string, dryRun = false, prefer = 0, keepCycles?: number) =>
      ipcRenderer.invoke('files:trimLoop', frameDir, dryRun, prefer, keepCycles ?? null),
    /** 取帧项目第一帧的四角平均色（传统抠图的背景色初值） */
    sampleFrameBackground: (frameDir: string) =>
      ipcRenderer.invoke('files:sampleFrameBackground', frameDir),
    /** 批量传统抠图（颜色键控） */
    batchKeyOut: (
      frameDir: string,
      options: {
        colors: Array<{ r: number; g: number; b: number }>;
        tolerance: number;
        mode: 'global' | 'connected';
        edgeTrim?: number;
      },
    ) => ipcRenderer.invoke('files:batchKeyOut', frameDir, options),
    /** 订阅批量抠图进度；返回取消订阅函数 */
    onRembgBatchProgress: (handler: (progress: { done: number; total: number; file: string }) => void) => {
      const listener = (_event: unknown, progress: { done: number; total: number; file: string }) =>
        handler(progress);
      ipcRenderer.on('rembg:batchProgress', listener);
      return () => {
        ipcRenderer.removeListener('rembg:batchProgress', listener);
      };
    },
    saveEdited: (input: SaveEditedImageInput) => ipcRenderer.invoke('files:saveEdited', input),
    readMedia: (fileName: string) => ipcRenderer.invoke('files:readMedia', fileName),
  },
  knowledge: {
    list: () => ipcRenderer.invoke('kb:list'),
    importFiles: () => ipcRenderer.invoke('kb:importFiles'),
    rename: (id: string, name: string) => ipcRenderer.invoke('kb:rename', id, name),
    remove: (id: string) => ipcRenderer.invoke('kb:remove', id),
    /**
     * 订阅「素材容器目录被改动」（用户在 data/knowledge/files/images 里
     * 手动拷入 / 删除 / 改名）。返回取消订阅函数。
     */
    onMediaChanged: (handler: () => void) => {
      const listener = (): void => handler();
      ipcRenderer.on('kb:mediaChanged', listener);
      return () => {
        ipcRenderer.removeListener('kb:mediaChanged', listener);
      };
    },
  },
  video: {
    generateLoop: (input: GenerateLoopVideoInput) => ipcRenderer.invoke('video:generateLoop', input),
    onProgress: (listener: (progress: LoopVideoProgress) => void) => {
      const handler = (_event: unknown, progress: LoopVideoProgress): void => listener(progress);
      ipcRenderer.on('video:progress', handler);
      return () => {
        ipcRenderer.removeListener('video:progress', handler);
      };
    },
  },
  frames: {
    list: () => ipcRenderer.invoke('frames:list'),
    /** 独立列出 outputs/ 下的抠图结果（不依赖源集合是否还在） */
    listOutputs: () => ipcRenderer.invoke('frames:listOutputs'),
    save: (input: SaveFrameProjectInput) => ipcRenderer.invoke('frames:save', input),
    rename: (id: string, name: string) => ipcRenderer.invoke('frames:rename', id, name),
    renameOutput: (name: string, nextName: string) =>
      ipcRenderer.invoke('frames:renameOutput', name, nextName),
    remove: (id: string) => ipcRenderer.invoke('frames:remove', id),
    /** 删掉集合里的单个帧文件（找循环帧页手动剔帧用） */
    removeFrame: (id: string, fileName: string) =>
      ipcRenderer.invoke('frames:removeFrame', id, fileName),
    /** 用编辑器改完的 PNG 覆盖某一帧（素材库里编辑帧集合用） */
    writeFrame: (id: string, fileName: string, pngBase64: string) =>
      ipcRenderer.invoke('frames:writeFrame', id, fileName, pngBase64),
    /** 同上，写的是抠图结果（frames/outputs/<目录名>） */
    writeOutputFrame: (dirName: string, fileName: string, pngBase64: string) =>
      ipcRenderer.invoke('frames:writeOutputFrame', dirName, fileName, pngBase64),
    openDir: (id?: string) => ipcRenderer.invoke('frames:openDir', id),
  },
  prompts: {
    optimize: (prompt: string, kind: 'image' | 'video') => ipcRenderer.invoke('ai:optimizePrompt', prompt, kind),
  },
};

contextBridge.exposeInMainWorld('skeletonElf', api);
