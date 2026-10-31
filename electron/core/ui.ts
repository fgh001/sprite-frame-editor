import fs from 'node:fs';
import path from 'node:path';
import type { ThemeMode } from '../../shared/ipc';
import { getDataDirs } from './paths';

interface StoredUi {
  version: number;
  theme: ThemeMode;
}

const UI_VERSION = 1;

let cached: ThemeMode | null = null;

function uiFilePath(): string {
  return path.join(getDataDirs().config, 'ui.json');
}

function isTheme(value: unknown): value is ThemeMode {
  return value === 'dark' || value === 'light';
}

export function getTheme(): ThemeMode {
  if (cached) return cached;
  try {
    const parsed = JSON.parse(fs.readFileSync(uiFilePath(), 'utf8')) as Partial<StoredUi>;
    cached = isTheme(parsed.theme) ? parsed.theme : 'dark';
  } catch {
    cached = 'dark';
  }
  return cached;
}

export function setTheme(theme: unknown): ThemeMode {
  if (!isTheme(theme)) throw new Error('未知的主题模式');
  const next: StoredUi = { version: UI_VERSION, theme };
  const file = uiFilePath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, file);
  cached = theme;
  return theme;
}
