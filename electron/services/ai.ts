import { pickAutoBackground } from '../../shared/pricing';
import { getProviderPreset, type ProviderId } from '../../shared/providers';
import type {
  BackgroundSuggestion,
  BalanceInfo,
  BalanceLine,
  ModelInfo,
  OptimizePromptResult,
  SlotKey,
  TestResult,
} from '../../shared/ipc';
import { getSlotRuntime, type SlotRuntime } from '../core/settings';
import { isSlotEnabled } from '../core/slot-flags';
import { msg } from '../core/msg';

const REQUEST_TIMEOUT_MS = 20_000;

interface SlotContext {
  runtime: SlotRuntime;
  requiresKey: boolean;
}

async function contextFor(slot: SlotKey): Promise<SlotContext> {
  const runtime = await getSlotRuntime(slot);
  const preset = getProviderPreset(runtime.providerId);
  return { runtime, requiresKey: preset.requiresKey };
}

function assertConfigured(ctx: SlotContext): void {
  if (!ctx.runtime.baseUrl) {
    throw new Error(msg('err.ai.noBaseUrl'));
  }
  if (ctx.requiresKey && !ctx.runtime.apiKey) {
    throw new Error(msg('err.ai.noKey'));
  }
}

function joinUrl(baseUrl: string, suffix: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/${suffix.replace(/^\/+/, '')}`;
}

function originOf(baseUrl: string): string {
  try {
    return new URL(baseUrl).origin;
  } catch {
    throw new Error(msg('err.ai.badUrl', { url: baseUrl }));
  }
}

function authHeaders(apiKey: string): Record<string, string> {
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  return headers;
}

async function describeHttpError(res: Response): Promise<string> {
  let detail = '';
  try {
    const text = await res.text();
    try {
      const parsed = JSON.parse(text) as { error?: { message?: string }; message?: string };
      detail = parsed?.error?.message ?? parsed?.message ?? text;
    } catch {
      detail = text;
    }
  } catch {
    /* 响应体读不出来就只报状态码 */
  }
  const hint =
    res.status === 401 ? msg('err.ai.hint401') : res.status === 404 ? msg('err.ai.hint404') : '';
  const detailPart = detail ? msg('err.ai.httpDetail', { detail: String(detail).slice(0, 300) }) : '';
  return msg('err.ai.http', {
    status: String(res.status),
    statusText: res.statusText,
    hint,
    detail: detailPart,
  });
}

/** 统一的 GET + JSON 解析，把网络异常翻译成人话 */
async function getJson(url: string, apiKey: string): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(url, {
      method: 'GET',
      headers: authHeaders(apiKey),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(msg('err.ai.connectFailed', { url, reason }));
  }
  if (!response.ok) throw new Error(await describeHttpError(response));
  try {
    return await response.json();
  } catch {
    throw new Error(msg('err.ai.badJson', { url }));
  }
}

/* ------------------------------------------------------------------ */
/* 模型列表 / 连接测试                                                  */
/* ------------------------------------------------------------------ */

/** /models 返回的条目（方舟会附带 domain / task_type / status，其他家通常只有 id / owned_by） */
interface RemoteModelEntry {
  id?: string;
  owned_by?: string;
  domain?: string;
  status?: string;
  task_type?: string[];
}

/** 按槽位能力判断这个模型是否适合用在这里 */
function matchesCapability(entry: RemoteModelEntry, slot: SlotKey): boolean {
  const domain = String(entry.domain ?? '');
  const taskTypes = Array.isArray(entry.task_type) ? entry.task_type.map(String) : [];
  // 没有任何能力元信息（通用 OpenAI 兼容 /models）→ 无法判断，全部保留
  if (!domain && taskTypes.length === 0) return true;
  if (slot === 'image') {
    return domain === 'ImageGeneration' || taskTypes.some((t) => /ImageToImage|TextToImage/i.test(t));
  }
  if (slot === 'video') {
    return domain === 'VideoGeneration' || taskTypes.some((t) => /Video/i.test(t));
  }
  return domain === 'LLM' || domain === 'VLM' || taskTypes.some((t) => /TextGeneration|VisualQuestionAnswering/i.test(t));
}

export async function listModels(slot: SlotKey = 'chat'): Promise<ModelInfo[]> {
  const ctx = await contextFor(slot);
  assertConfigured(ctx);

  const body = (await getJson(joinUrl(ctx.runtime.baseUrl, 'models'), ctx.runtime.apiKey)) as {
    data?: RemoteModelEntry[];
  };
  const items = Array.isArray(body?.data) ? body.data : [];
  return items
    .filter((item): item is RemoteModelEntry & { id: string } => typeof item?.id === 'string')
    // 已下线 / 即将下线的型号不列出来，避免选中后才发现不可用
    .filter((item) => !/^(shutdown|retiring)$/i.test(String(item.status ?? '')))
    .filter((item) => matchesCapability(item, slot))
    .map((item) => ({ id: item.id, ownedBy: item.owned_by }))
    .sort((a, b) => a.id.localeCompare(b.id))
    .slice(0, 1000);
}

export async function testConnection(slot: SlotKey = 'chat'): Promise<TestResult> {
  const startedAt = Date.now();
  const models = await listModels(slot);
  const latencyMs = Date.now() - startedAt;
  return {
    ok: true,
    latencyMs,
    modelCount: models.length,
    message: msg('err.ai.testOk', { ms: String(latencyMs), count: String(models.length) }),
  };
}

/* ------------------------------------------------------------------ */
/* 余额（使用 chat 槽位所在服务商）                                     */
/* ------------------------------------------------------------------ */

function unsupportedBalance(message: string): BalanceInfo {
  return {
    supported: false,
    available: false,
    lines: [],
    extra: [],
    fetchedAt: new Date().toISOString(),
    message,
  };
}

async function fetchDeepSeekBalance(ctx: SlotContext): Promise<BalanceInfo> {
  const origin = originOf(ctx.runtime.baseUrl);
  const body = (await getJson(`${origin}/user/balance`, ctx.runtime.apiKey)) as {
    is_available?: boolean;
    balance_infos?: {
      currency?: string;
      total_balance?: string;
      granted_balance?: string;
      topped_up_balance?: string;
    }[];
  };

  const lines: BalanceLine[] = (body.balance_infos ?? []).map((info) => ({
    currency: info.currency ?? 'CNY',
    total: String(info.total_balance ?? '0'),
    granted: info.granted_balance === undefined ? undefined : String(info.granted_balance),
    toppedUp: info.topped_up_balance === undefined ? undefined : String(info.topped_up_balance),
  }));

  return {
    supported: true,
    available: body.is_available === true,
    lines,
    extra: [],
    fetchedAt: new Date().toISOString(),
    message: lines.length === 0 ? msg('err.ai.balanceNoInfo') : undefined,
  };
}

async function fetchOpenRouterBalance(ctx: SlotContext): Promise<BalanceInfo> {
  const body = (await getJson(joinUrl(ctx.runtime.baseUrl, 'credits'), ctx.runtime.apiKey)) as {
    data?: { total_credits?: number; total_usage?: number };
  };
  const credits = Number(body?.data?.total_credits ?? 0);
  const usage = Number(body?.data?.total_usage ?? 0);
  const remaining = credits - usage;

  return {
    supported: true,
    available: remaining > 0,
    lines: [{ currency: 'USD', total: remaining.toFixed(4) }],
    extra: [
      { label: msg('err.ai.balanceCredits'), value: credits.toFixed(4) },
      { label: msg('err.ai.balanceUsed'), value: usage.toFixed(4) },
    ],
    fetchedAt: new Date().toISOString(),
  };
}

async function fetchMoonshotBalance(ctx: SlotContext): Promise<BalanceInfo> {
  const body = (await getJson(joinUrl(ctx.runtime.baseUrl, 'users/me/balance'), ctx.runtime.apiKey)) as {
    data?: { available_balance?: number; voucher_balance?: number; cash_balance?: number };
  };
  const data = body?.data;
  if (!data) return unsupportedBalance(msg('err.ai.balanceEmptyResponse'));

  const total = Number(data.available_balance ?? 0);
  return {
    supported: true,
    available: total > 0,
    lines: [
      {
        currency: 'CNY',
        total: total.toFixed(2),
        granted: data.voucher_balance === undefined ? undefined : Number(data.voucher_balance).toFixed(2),
        toppedUp: data.cash_balance === undefined ? undefined : Number(data.cash_balance).toFixed(2),
      },
    ],
    extra: [],
    fetchedAt: new Date().toISOString(),
  };
}

export async function fetchBalance(): Promise<BalanceInfo> {
  const ctx = await contextFor('chat');
  assertConfigured(ctx);

  const preset = getProviderPreset(ctx.runtime.providerId);
  switch (preset.balance) {
    case 'deepseek':
      return fetchDeepSeekBalance(ctx);
    case 'openrouter':
      return fetchOpenRouterBalance(ctx);
    case 'moonshot':
      return fetchMoonshotBalance(ctx);
    default:
      return unsupportedBalance(msg('err.ai.balanceUnsupportedProvider', { provider: preset.label }));
  }
}

/** 当前生效的文本模型上下文（后续生成阶段会用到） */
export async function getActiveChatContext(): Promise<{
  providerId: ProviderId;
  baseUrl: string;
  model: string;
  apiKey: string;
}> {
  const runtime = await getSlotRuntime('chat');
  return {
    providerId: runtime.providerId,
    baseUrl: runtime.baseUrl,
    model: runtime.model,
    apiKey: runtime.apiKey,
  };
}

/* ------------------------------------------------------------------ */
/* 文本对话（给「自动背景色分析」等功能用）                             */
/* ------------------------------------------------------------------ */

interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

async function chatComplete(messages: ChatMessage[], maxTokens = 200): Promise<string> {
  const ctx = await contextFor('chat');
  if (!ctx.runtime.baseUrl) throw new Error(msg('err.ai.chatNoBaseUrl'));
  if (ctx.requiresKey && !ctx.runtime.apiKey) throw new Error(msg('err.ai.chatNoKey'));
  if (!isSlotEnabled('chat')) throw new Error(msg('err.ai.chatDisabled'));

  const url = joinUrl(ctx.runtime.baseUrl, 'chat/completions');
  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        ...authHeaders(ctx.runtime.apiKey),
      },
      body: JSON.stringify({
        model: ctx.runtime.model,
        messages,
        temperature: 0.3,
        max_tokens: maxTokens,
        stream: false,
      }),
      signal: AbortSignal.timeout(45_000),
    });
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(msg('err.ai.chatFailed', { reason }));
  }
  if (!response.ok) throw new Error(await describeHttpError(response));

  const body = (await response.json()) as {
    choices?: { message?: { content?: string } }[];
  };
  const content = body.choices?.[0]?.message?.content;
  if (typeof content !== 'string' || !content.trim()) throw new Error(msg('err.ai.emptyReply'));
  return content;
}

/** 右侧 AI 助手：用文本槽位的模型做多轮对话（历史由前端维护并整段发来） */
export async function assistantReply(messages: ChatMessage[]): Promise<string> {
  const cleaned = messages
    .filter((message) => (message.role === 'user' || message.role === 'assistant') && message.content.trim())
    .slice(-20)
    .map((message) => ({ role: message.role, content: message.content.slice(0, 4000) }));
  if (cleaned.length === 0) throw new Error(msg('err.ai.emptyInput'));

  const system: ChatMessage = {
    role: 'system',
    content: msg('prompt.assistant'),
  };

  return chatComplete([system, ...cleaned], 1200);
}

/** 让文本模型分析主体主色调，返回与主体对比最大的纯色背景 */
export async function suggestBackgroundColor(prompt: string): Promise<BackgroundSuggestion> {
  const heuristic = pickAutoBackground(prompt);
  const fallback: BackgroundSuggestion = {
    color: heuristic.color,
    reason: heuristic.label,
    source: 'heuristic',
  };

  if (!prompt.trim()) return fallback;

  try {
    const system = msg('prompt.bgColor');

    const content = await chatComplete(
      [
        { role: 'system', content: system },
        { role: 'user', content: msg('prompt.bgColor.user', { text: prompt.slice(0, 1500) }) },
      ],
      200,
    );

    const colorMatch = content.match(/#[0-9a-fA-F]{6}/);
    if (!colorMatch) throw new Error(msg('err.ai.noColor'));

    const reasonMatch = content.match(/"reason"\s*:\s*"([^"]{0,80})"/);
    return {
      color: colorMatch[0].toUpperCase(),
      reason: reasonMatch ? reasonMatch[1] : msg('err.ai.colorFallbackReason'),
      source: 'ai',
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      ...fallback,
      reason: `${fallback.reason}${msg('err.ai.colorReasonSuffix', { message: message.slice(0, 60) })}`,
    };
  }
}

/* ------------------------------------------------------------------ */
/* 提示词优化（只回填输入框，不触发生成）                                */
/* ------------------------------------------------------------------ */

/* 提示词优化器的 system prompt。
   关键约束来自实际流程：生成出来的东西后面要抠图 → 做帧动画，
   所以背景必须纯色、边缘必须干净、不能有水印文字。
   豆包会在图片/视频角落自动打水印，提示词里要求「四角留纯背景」，
   后期直接裁掉或用色键一起抠掉就行。 */
const PROMPT_SYSTEM: Record<'image' | 'video', string> = {
  image: 'prompt.optImage',
  video: 'prompt.optVideo',
};
export async function optimizePrompt(prompt: string, kind: 'image' | 'video'): Promise<OptimizePromptResult> {
  const text = (prompt || '').trim();
  if (!text) throw new Error(msg('err.ai.emptyPrompt'));

  const content = await chatComplete(
    [
      { role: 'system', content: msg(PROMPT_SYSTEM[kind]) },
      { role: 'user', content: text.slice(0, 1500) },
    ],
    500,
  );

  const optimized = content
    .trim()
    .replace(/^```[\s\S]*?\n/, '')
    .replace(/```$/, '')
    .replace(/^(提示词|Prompt)[:：]\s*/i, '')
    .trim();

  if (!optimized) throw new Error(msg('err.ai.emptyOptimized'));
  return { prompt: optimized, source: 'ai' };
}
