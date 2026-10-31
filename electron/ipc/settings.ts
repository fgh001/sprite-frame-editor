import { ipcMain } from 'electron';
import type {
  BackgroundSuggestion,
  BalanceInfo,
  GenerateImageInput,
  GenerateImageResult,
  IpcErr,
  IpcResult,
  ModelInfo,
  OptimizePromptResult,
  SaveSlotInput,
  SlotKey,
  SlotSettingsView,
  TestResult,
} from '../../shared/ipc';
import { PROVIDER_PRESETS, type ProviderId } from '../../shared/providers';
import { clearSlotKey, copySlotKey, getSlotRuntime, getSlotView, getSlotViews, SLOT_KEYS, saveSlot } from '../core/settings';
import { setSlotEnabled } from '../core/slot-flags';
import {
  assistantReply,
  fetchBalance,
  listModels,
  optimizePrompt,
  suggestBackgroundColor,
  testConnection,
} from '../services/ai';
import { generateImages } from '../services/image';

function toError(err: unknown): IpcErr {
  return { ok: false, error: err instanceof Error ? err.message : String(err) };
}

function isProviderId(value: unknown): value is ProviderId {
  return typeof value === 'string' && PROVIDER_PRESETS.some((preset) => preset.id === value);
}

function isSlotKey(value: unknown): value is SlotKey {
  // 统一用 SLOT_KEYS 判断：新增 / 删除槽位只改一处，这里自动跟随
  return typeof value === 'string' && (SLOT_KEYS as string[]).includes(value);
}

/** 渲染层传来的数据一律当作不可信输入处理 */
function validateSaveSlot(raw: unknown): SaveSlotInput {
  if (!raw || typeof raw !== 'object') throw new Error('设置参数无效');
  const input = raw as Partial<SaveSlotInput>;

  if (!isSlotKey(input.slot)) throw new Error('未知的能力槽位');
  if (!isProviderId(input.providerId)) throw new Error('未知的模型服务商');

  const baseUrl = typeof input.baseUrl === 'string' ? input.baseUrl.trim() : '';
  if (baseUrl.length > 512) throw new Error('Base URL 过长');
  if (baseUrl && !/^https?:\/\//i.test(baseUrl) && input.providerId !== 'ollama') {
    throw new Error('Base URL 需要以 http:// 或 https:// 开头');
  }

  const model = typeof input.model === 'string' ? input.model.trim() : '';
  if (model.length > 200) throw new Error('模型名称过长');

  let apiKey: string | undefined;
  if (input.apiKey !== undefined) {
    if (typeof input.apiKey !== 'string') throw new Error('API Key 必须是字符串');
    apiKey = input.apiKey.trim();
    if (apiKey.length > 512) throw new Error('API Key 过长');
  }

  return { slot: input.slot, providerId: input.providerId, baseUrl, model, apiKey };
}

function validateGenerateInput(raw: unknown): GenerateImageInput {
  if (!raw || typeof raw !== 'object') throw new Error('生成参数无效');
  const input = raw as Partial<GenerateImageInput>;

  const prompt = typeof input.prompt === 'string' ? input.prompt.trim() : '';
  if (!prompt) throw new Error('提示词不能为空');
  if (prompt.length > 4000) throw new Error('提示词过长（上限 4000 字）');

  const size = typeof input.size === 'string' && input.size.trim() ? input.size.trim() : '2K';
  if (size.length > 32) throw new Error('尺寸参数过长');

  const count = Math.min(Math.max(Math.trunc(Number(input.count) || 1), 1), 4);

  const backgroundColor =
    typeof input.backgroundColor === 'string' && /^#[0-9a-fA-F]{6}$/.test(input.backgroundColor.trim())
      ? input.backgroundColor.trim().toUpperCase()
      : '#00B140';

  return {
    prompt,
    size,
    count,
    saveToKnowledge: input.saveToKnowledge !== false,
    backgroundColor,
  };
}

export function registerSettingsIpc(): void {
  ipcMain.handle('settings:getSlots', async (): Promise<IpcResult<SlotSettingsView[]>> => {
    try {
      return { ok: true, data: await getSlotViews() };
    } catch (err) {
      return toError(err);
    }
  });

  ipcMain.handle('settings:saveSlot', async (_event, raw: unknown): Promise<IpcResult<SlotSettingsView>> => {
    try {
      return { ok: true, data: await saveSlot(validateSaveSlot(raw)) };
    } catch (err) {
      return toError(err);
    }
  });

  ipcMain.handle(
    'settings:clearSlotKey',
    async (_event, slot: unknown, providerId: unknown): Promise<IpcResult<SlotSettingsView>> => {
      try {
        if (!isSlotKey(slot)) throw new Error('未知的能力槽位');
        if (providerId !== undefined && !isProviderId(providerId)) throw new Error('未知的模型服务商');
        return { ok: true, data: await clearSlotKey(slot, providerId) };
      } catch (err) {
        return toError(err);
      }
    },
  );

  // 复用其他槽位的 Key（同一把豆包 Key 只需填一次）
  ipcMain.handle(
    'settings:copySlotKey',
    async (_event, from: unknown, to: unknown, providerId: unknown): Promise<IpcResult<SlotSettingsView>> => {
      try {
        if (!isSlotKey(from) || !isSlotKey(to)) throw new Error('未知的能力槽位');
        if (from === to) throw new Error('来源和目标槽位相同');
        if (providerId !== undefined && !isProviderId(providerId)) throw new Error('未知的模型服务商');
        return { ok: true, data: await copySlotKey(from, to, providerId) };
      } catch (err) {
        return toError(err);
      }
    },
  );

  // 启用 / 停用某个槽位（停用后界面隐藏配置，也不会被调用）
  ipcMain.handle(
    'settings:setSlotEnabled',
    async (_event, slot: unknown, enabled: unknown): Promise<IpcResult<SlotSettingsView>> => {
      try {
        if (!isSlotKey(slot)) throw new Error('未知的能力槽位');
        if (typeof enabled !== 'boolean') throw new Error('启用状态无效');
        setSlotEnabled(slot, enabled);
        return { ok: true, data: await getSlotView(slot) };
      } catch (err) {
        return toError(err);
      }
    },
  );

  ipcMain.handle('ai:test', async (_event, slot: unknown): Promise<IpcResult<TestResult>> => {
    try {
      if (!isSlotKey(slot)) throw new Error('未知的能力槽位');
      return { ok: true, data: await testConnection(slot) };
    } catch (err) {
      return toError(err);
    }
  });

  // 右侧 AI 助手（问答窗口），走文本槽位同一个模型
  ipcMain.handle(
    'ai:assistantChat',
    async (_event, raw: unknown): Promise<IpcResult<{ reply: string; model: string }>> => {
      try {
        if (!Array.isArray(raw)) throw new Error('消息格式无效');
        const messages = raw
          .filter((item): item is { role: string; content: string } => Boolean(item) && typeof item === 'object')
          .map((item) => ({
            role: item.role === 'assistant' ? ('assistant' as const) : ('user' as const),
            content: typeof item.content === 'string' ? item.content : '',
          }));
        const reply = await assistantReply(messages);
        const runtime = await getSlotRuntime('chat');
        return { ok: true, data: { reply, model: runtime?.model ?? '' } };
      } catch (err) {
        return toError(err);
      }
    },
  );

  ipcMain.handle('ai:suggestBackground', async (_event, prompt: unknown): Promise<IpcResult<BackgroundSuggestion>> => {
    try {
      if (typeof prompt !== 'string') throw new Error('提示词无效');
      return { ok: true, data: await suggestBackgroundColor(prompt) };
    } catch (err) {
      return toError(err);
    }
  });

  ipcMain.handle('ai:optimizePrompt', async (_event, prompt: unknown, kind: unknown): Promise<IpcResult<OptimizePromptResult>> => {
    try {
      if (typeof prompt !== 'string') throw new Error('提示词无效');
      if (kind !== 'image' && kind !== 'video') throw new Error('优化类型无效');
      return { ok: true, data: await optimizePrompt(prompt, kind) };
    } catch (err) {
      return toError(err);
    }
  });

  ipcMain.handle('ai:models', async (_event, slot: unknown): Promise<IpcResult<ModelInfo[]>> => {
    try {
      if (!isSlotKey(slot)) throw new Error('未知的能力槽位');
      return { ok: true, data: await listModels(slot) };
    } catch (err) {
      return toError(err);
    }
  });

  ipcMain.handle('ai:balance', async (): Promise<IpcResult<BalanceInfo>> => {
    try {
      return { ok: true, data: await fetchBalance() };
    } catch (err) {
      return toError(err);
    }
  });

  ipcMain.handle('ai:generateImage', async (_event, raw: unknown): Promise<IpcResult<GenerateImageResult>> => {
    try {
      return { ok: true, data: await generateImages(validateGenerateInput(raw)) };
    } catch (err) {
      return toError(err);
    }
  });
}
