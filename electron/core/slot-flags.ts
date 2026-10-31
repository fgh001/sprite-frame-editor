import fs from 'node:fs';
import path from 'node:path';
import type { SlotKey } from '../../shared/ipc';
import { getDataDirs } from './paths';

/**
 * 槽位启用状态单独存放（data/config/slot-flags.json），
 * 不改 settings.json 的结构，迁移成本为零。
 */
interface StoredFlags {
  version: number;
  /** 只记录被明确停用的槽位；缺省视为启用 */
  disabled: Partial<Record<SlotKey, boolean>>;
}

const FLAGS_VERSION = 1;
const SLOTS: SlotKey[] = ['chat', 'image', 'video'];

let cached: StoredFlags | null = null;

function flagsPath(): string {
  return path.join(getDataDirs().config, 'slot-flags.json');
}

function load(): StoredFlags {
  if (cached) return cached;
  try {
    const parsed = JSON.parse(fs.readFileSync(flagsPath(), 'utf8')) as Partial<StoredFlags>;
    const disabled: Partial<Record<SlotKey, boolean>> = {};
    for (const slot of SLOTS) {
      if (parsed.disabled && parsed.disabled[slot] === true) disabled[slot] = true;
    }
    cached = { version: FLAGS_VERSION, disabled };
  } catch {
    cached = { version: FLAGS_VERSION, disabled: {} };
  }
  return cached;
}

function persist(flags: StoredFlags): void {
  const file = flagsPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(flags, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, file);
  cached = flags;
}

export function isSlotEnabled(slot: SlotKey): boolean {
  return load().disabled[slot] !== true;
}

export function setSlotEnabled(slot: SlotKey, enabled: boolean): boolean {
  const flags = load();
  const disabled: Partial<Record<SlotKey, boolean>> = { ...flags.disabled };
  if (enabled) delete disabled[slot];
  else disabled[slot] = true;
  persist({ version: FLAGS_VERSION, disabled });
  return enabled;
}
