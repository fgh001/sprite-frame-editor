import fs from 'node:fs';
import path from 'node:path';
import { safeStorage } from 'electron';
import { getProviderPreset, PROVIDER_PRESETS, type ProviderId } from '../../shared/providers';
import type { KeyStorage, SaveSlotInput, SlotKey, SlotKeyEntry, SlotSettingsView } from '../../shared/ipc';
import { getDataDirs } from './paths';
import { isSlotEnabled } from './slot-flags';
import { msg } from './msg';

interface StoredKey {
  /** base64：encrypted 时是系统密文，plain 时是明文（回退） */
  value: string;
  storage: Exclude<KeyStorage, 'none'>;
}

interface StoredEndpoint {
  baseUrl: string;
  model: string;
}

interface StoredSlot {
  /** 当前选中的服务商 */
  providerId: ProviderId;
  /** 按服务商分别记忆的 Key（同一个槽位下豆包 / DeepSeek 各存各的） */
  keys: Partial<Record<ProviderId, StoredKey>>;
  /** 按服务商分别记忆的 Base URL / 模型，切回来还是上次那套 */
  endpoints: Partial<Record<ProviderId, StoredEndpoint>>;
}

interface StoredSettings {
  version: number;
  slots: Record<SlotKey, StoredSlot>;
  updatedAt: string;
}

const SETTINGS_VERSION = 3;
export const SLOT_KEYS: SlotKey[] = ['chat', 'image', 'video'];

/**
 * 各槽位的默认服务商。
 *
 * 统一默认「自定义（OpenAI 兼容）」：接入任何模型其实只要有 URL + Key + 模型名，
 * 默认摆出某个厂商会让人以为必须用那家。想在界面上快速填 URL 时再切预设即可。
 */
const SLOT_DEFAULT_PROVIDER: Record<SlotKey, ProviderId> = {
  chat: 'custom',
  image: 'custom',
  video: 'custom',
};

let cached: StoredSettings | null = null;

export function getSettingsFilePath(): string {
  return path.join(getDataDirs().config, 'settings.json');
}

function emptySlot(slot: SlotKey): StoredSlot {
  return { providerId: SLOT_DEFAULT_PROVIDER[slot], keys: {}, endpoints: {} };
}

function buildDefaults(): StoredSettings {
  return {
    version: SETTINGS_VERSION,
    slots: {
      chat: emptySlot('chat'),
      image: emptySlot('image'),
      video: emptySlot('video'),
    },
    updatedAt: new Date().toISOString(),
  };
}

function isProviderId(value: unknown): value is ProviderId {
  return typeof value === 'string' && PROVIDER_PRESETS.some((preset) => preset.id === value);
}

function normalizeKey(raw: unknown): StoredKey | null {
  if (!raw || typeof raw !== 'object') return null;
  const key = raw as Partial<StoredKey>;
  if (typeof key.value !== 'string' || (key.storage !== 'encrypted' && key.storage !== 'plain')) return null;
  return { value: key.value, storage: key.storage };
}

/** 生效的 baseUrl / model：该服务商上次保存的，否则用预设默认 */
export function endpointFor(slot: SlotKey, stored: StoredSlot, providerId: ProviderId = stored.providerId): StoredEndpoint {
  const preset = getProviderPreset(providerId);
  const saved = stored.endpoints[providerId];
  return {
    baseUrl: saved?.baseUrl || preset.baseUrl,
    model: saved?.model || preset.models[slot] || '',
  };
}

/**
 * 同时兼容三种历史结构：
 *  - v1: { ai: { providerId, baseUrl, model, apiKey } }
 *  - v2: { slots: { chat|image|video: { providerId, baseUrl, model, apiKey } } }
 *  - v3: { slots: { …: { providerId, keys, endpoints } } }   ← 当前
 * 老结构里的单个 apiKey 会迁移到「该服务商」名下，不会被别的服务商覆盖。
 */
function normalizeSlot(slot: SlotKey, raw: unknown, fallback: StoredSlot): StoredSlot {
  if (!raw || typeof raw !== 'object') return fallback;

  const source = raw as {
    providerId?: unknown;
    baseUrl?: unknown;
    model?: unknown;
    apiKey?: unknown;
    keys?: Record<string, unknown>;
    endpoints?: Record<string, unknown>;
  };

  const providerId = isProviderId(source.providerId) ? source.providerId : fallback.providerId;
  const preset = getProviderPreset(providerId);

  const result: StoredSlot = {
    providerId,
    keys: { ...fallback.keys },
    endpoints: { ...fallback.endpoints },
  };

  // 迁移 v1 / v2 的顶层字段
  const legacyBaseUrl = typeof source.baseUrl === 'string' && source.baseUrl ? source.baseUrl : '';
  const legacyModel = typeof source.model === 'string' && source.model ? source.model : '';
  if (legacyBaseUrl || legacyModel) {
    result.endpoints[providerId] = {
      baseUrl: legacyBaseUrl || preset.baseUrl,
      model: legacyModel || preset.models[slot] || '',
    };
  }
  const legacyKey = normalizeKey(source.apiKey);
  if (legacyKey) result.keys[providerId] = legacyKey;

  // v3 结构
  if (source.endpoints && typeof source.endpoints === 'object') {
    for (const [pid, value] of Object.entries(source.endpoints)) {
      if (!isProviderId(pid) || !value || typeof value !== 'object') continue;
      const endpoint = value as { baseUrl?: unknown; model?: unknown };
      const endpointPreset = getProviderPreset(pid);
      result.endpoints[pid] = {
        baseUrl: typeof endpoint.baseUrl === 'string' && endpoint.baseUrl ? endpoint.baseUrl : endpointPreset.baseUrl,
        model: typeof endpoint.model === 'string' && endpoint.model ? endpoint.model : (endpointPreset.models[slot] || ''),
      };
    }
  }

  if (source.keys && typeof source.keys === 'object') {
    for (const [pid, value] of Object.entries(source.keys)) {
      if (!isProviderId(pid)) continue;
      const key = normalizeKey(value);
      if (key) result.keys[pid] = key;
    }
  }

  return result;
}

function normalizeLoaded(parsed: unknown): StoredSettings {
  const result = buildDefaults();
  if (!parsed || typeof parsed !== 'object') return result;

  const raw = parsed as {
    slots?: Partial<Record<SlotKey, unknown>>;
    ai?: unknown;
    updatedAt?: string;
  };

  // v1：单一 ai 配置 → chat 槽位
  if (raw.ai) result.slots.chat = normalizeSlot('chat', raw.ai, result.slots.chat);

  if (raw.slots) {
    for (const slot of SLOT_KEYS) {
      result.slots[slot] = normalizeSlot(slot, raw.slots[slot], result.slots[slot]);
    }
  }

  if (typeof raw.updatedAt === 'string') result.updatedAt = raw.updatedAt;
  return result;
}

export function loadSettings(): StoredSettings {
  if (cached) return cached;
  try {
    cached = normalizeLoaded(JSON.parse(fs.readFileSync(getSettingsFilePath(), 'utf8')));
  } catch {
    // 首次运行 / 文件损坏：回落到默认设置，不阻断启动
    cached = buildDefaults();
  }
  return cached;
}

function persist(settings: StoredSettings): void {
  const file = getSettingsFilePath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  // 先写临时文件再改名：避免写一半断电导致配置损坏
  fs.writeFileSync(tmp, `${JSON.stringify(settings, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, file);
}

/* ------------------------------------------------------------------ */
/* Key 加密（Electron 45 起使用异步 safeStorage API）                    */
/* ------------------------------------------------------------------ */

async function isEncryptionAvailable(): Promise<boolean> {
  try {
    return await safeStorage.isAsyncEncryptionAvailable();
  } catch {
    return false;
  }
}

async function encryptKey(plain: string): Promise<StoredKey> {
  if (await isEncryptionAvailable()) {
    const buffer = await safeStorage.encryptStringAsync(plain);
    return { value: buffer.toString('base64'), storage: 'encrypted' };
  }
  // 系统不支持加密时退化为 base64 并如实标记，界面会提示风险
  return { value: Buffer.from(plain, 'utf8').toString('base64'), storage: 'plain' };
}

async function decryptKey(stored: StoredKey | null | undefined): Promise<string> {
  if (!stored) return '';
  try {
    const buffer = Buffer.from(stored.value, 'base64');
    if (stored.storage === 'encrypted') {
      if (!(await isEncryptionAvailable())) return '';
      const decrypted = await safeStorage.decryptStringAsync(buffer);
      // shouldReEncrypt = 系统密钥已轮换：本次仍返回可用明文，按需重存即可
      return decrypted.result;
    }
    return buffer.toString('utf8');
  } catch {
    return '';
  }
}

export function maskApiKey(apiKey: string): string {
  if (!apiKey) return '';
  if (apiKey.length <= 8) return '••••••••';
  return `${apiKey.slice(0, 4)}••••${apiKey.slice(-4)}`;
}

/* ------------------------------------------------------------------ */
/* 对外接口                                                            */
/* ------------------------------------------------------------------ */

export interface SlotRuntime {
  slot: SlotKey;
  providerId: ProviderId;
  baseUrl: string;
  model: string;
  apiKey: string;
}

/** 主进程内部使用：拿到槽位的明文 Key 与实际生效的 baseUrl / model */
export async function getSlotRuntime(slot: SlotKey): Promise<SlotRuntime> {
  const stored = loadSettings().slots[slot];
  const endpoint = endpointFor(slot, stored);
  return {
    slot,
    providerId: stored.providerId,
    baseUrl: endpoint.baseUrl.trim(),
    model: endpoint.model.trim(),
    apiKey: await decryptKey(stored.keys[stored.providerId]),
  };
}

export async function getSlotView(slot: SlotKey): Promise<SlotSettingsView> {
  const stored = loadSettings().slots[slot];
  const endpoint = endpointFor(slot, stored);
  const currentKey = stored.keys[stored.providerId];

  const keyEntries: SlotKeyEntry[] = [];
  for (const [pid, key] of Object.entries(stored.keys)) {
    if (!isProviderId(pid) || !key) continue;
    keyEntries.push({
      providerId: pid,
      keyMask: maskApiKey(await decryptKey(key)),
      keyStorage: key.storage,
    });
  }

  return {
    slot,
    enabled: isSlotEnabled(slot),
    providerId: stored.providerId,
    baseUrl: endpoint.baseUrl,
    model: endpoint.model,
    hasKey: Boolean(currentKey),
    keyMask: currentKey ? maskApiKey(await decryptKey(currentKey)) : '',
    keyStorage: currentKey ? currentKey.storage : 'none',
    keyEntries,
    endpoints: Object.entries(stored.endpoints).map(([pid, value]) => ({
      providerId: pid as ProviderId,
      baseUrl: value?.baseUrl ?? '',
      model: value?.model ?? '',
    })),
    configPath: getSettingsFilePath(),
  };
}

export async function getSlotViews(): Promise<SlotSettingsView[]> {
  return Promise.all(SLOT_KEYS.map((slot) => getSlotView(slot)));
}

export async function saveSlot(input: SaveSlotInput): Promise<SlotSettingsView> {
  const current = loadSettings();
  const slotState = current.slots[input.slot];
  const preset = getProviderPreset(input.providerId);
  const previousEndpoint = slotState.endpoints[input.providerId];

  const baseUrl = input.baseUrl.trim() || previousEndpoint?.baseUrl || preset.baseUrl;
  const model = input.model.trim() || previousEndpoint?.model || preset.models[input.slot];

  // 只动「当前服务商」那把 Key，其他服务商的 Key 保持原样
  const keys = { ...slotState.keys };
  if (typeof input.apiKey === 'string') {
    const trimmed = input.apiKey.trim();
    if (trimmed) keys[input.providerId] = await encryptKey(trimmed);
    else delete keys[input.providerId];
  }

  const nextSlot: StoredSlot = {
    providerId: input.providerId,
    keys,
    endpoints: { ...slotState.endpoints, [input.providerId]: { baseUrl, model } },
  };

  const next: StoredSettings = {
    ...current,
    slots: { ...current.slots, [input.slot]: nextSlot },
    updatedAt: new Date().toISOString(),
  };

  persist(next);
  cached = next;
  return getSlotView(input.slot);
}

export async function clearSlotKey(slot: SlotKey, providerId?: ProviderId): Promise<SlotSettingsView> {
  const current = loadSettings();
  const slotState = current.slots[slot];
  const target = providerId ?? slotState.providerId;

  const keys = { ...slotState.keys };
  delete keys[target];

  const next: StoredSettings = {
    ...current,
    slots: { ...current.slots, [slot]: { ...slotState, keys } },
    updatedAt: new Date().toISOString(),
  };

  persist(next);
  cached = next;
  return getSlotView(slot);
}

/**
 * 把某个槽位里「同一服务商」的 Key 复制到另一个槽位。
 * 直接复用密文（同一个 userData 加密，无需解密再加密），所以豆包 Key 只填一次就能三处共用。
 */
export async function copySlotKey(from: SlotKey, to: SlotKey, providerId?: ProviderId): Promise<SlotSettingsView> {
  const current = loadSettings();
  const source = current.slots[from];
  const pid = providerId ?? source.providerId;
  const key = source.keys[pid];
  if (!key) throw new Error(msg('err.settings.copyNoKey'));

  const target = current.slots[to];
  const next: StoredSettings = {
    ...current,
    slots: {
      ...current.slots,
      [to]: { ...target, keys: { ...target.keys, [pid]: key } },
    },
    updatedAt: new Date().toISOString(),
  };

  persist(next);
  cached = next;
  return getSlotView(to);
}
