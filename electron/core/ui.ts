import fs from 'node:fs';
import path from 'node:path';
import type { Lang, ThemeMode } from '../../shared/ipc';
import { getDataDirs } from './paths';
import { msg } from './msg';
import { setErrLang } from '../../shared/err-i18n';

interface StoredUi {
  version: number;
  theme: ThemeMode;
  /** 界面语言（老版本没有这个字段，读不到就按简体中文） */
  lang?: Lang;
}

const UI_VERSION = 1;

let cachedTheme: ThemeMode | null = null;
let cachedLang: Lang | null = null;

function uiFilePath(): string {
  return path.join(getDataDirs().config, 'ui.json');
}

function isTheme(value: unknown): value is ThemeMode {
  return value === 'dark' || value === 'light';
}

export function isLang(value: unknown): value is Lang {
  return value === 'zh-CN' || value === 'zh-TW' || value === 'en';
}

/** 读出整个 ui.json（读不到就给默认值），两个 getter 共用，避免重复读盘 */
function readStored(): StoredUi {
  try {
    const parsed = JSON.parse(fs.readFileSync(uiFilePath(), 'utf8')) as Partial<StoredUi>;
    return {
      version: UI_VERSION,
      theme: isTheme(parsed.theme) ? parsed.theme : 'dark',
      lang: isLang(parsed.lang) ? parsed.lang : 'zh-CN',
    };
  } catch {
    return { version: UI_VERSION, theme: 'dark', lang: 'zh-CN' };
  }
}

function writeStored(next: StoredUi): void {
  const file = uiFilePath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, file);
}

export function getTheme(): ThemeMode {
  if (cachedTheme) return cachedTheme;
  cachedTheme = readStored().theme;
  return cachedTheme;
}

export function setTheme(theme: unknown): ThemeMode {
  if (!isTheme(theme)) throw new Error(msg('err.ui.badTheme'));
  // 写回时保留 lang，否则换主题会把语言设置清掉
  writeStored({ ...readStored(), theme });
  cachedTheme = theme;
  return theme;
}

export function getLang(): Lang {
  if (cachedLang) return cachedLang;
  cachedLang = readStored().lang ?? 'zh-CN';
  setErrLang(cachedLang);
  return cachedLang;
}

export function setLang(lang: unknown): Lang {
  if (!isLang(lang)) throw new Error(msg('err.ui.badLang'));
  writeStored({ ...readStored(), lang });
  cachedLang = lang;
  setErrLang(lang);
  return lang;
}
