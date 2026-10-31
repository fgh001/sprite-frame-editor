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
    throw new Error('还没有填写 Base URL，请先在模型设置里补上接口地址');
  }
  if (ctx.requiresKey && !ctx.runtime.apiKey) {
    throw new Error('还没有填写 API Key，请在模型设置里填入并保存');
  }
}

function joinUrl(baseUrl: string, suffix: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/${suffix.replace(/^\/+/, '')}`;
}

function originOf(baseUrl: string): string {
  try {
    return new URL(baseUrl).origin;
  } catch {
    throw new Error(`Base URL 不是合法地址：${baseUrl}`);
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
    res.status === 401 ? '（API Key 无效或已过期）' : res.status === 404 ? '（接口地址不存在，检查 Base URL）' : '';
  return `HTTP ${res.status} ${res.statusText}${hint}${detail ? `：${String(detail).slice(0, 300)}` : ''}`;
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
    throw new Error(`连接 ${url} 失败：${reason}（检查网络 / 代理 / VPN，或 Base URL 是否正确）`);
  }
  if (!response.ok) throw new Error(await describeHttpError(response));
  try {
    return await response.json();
  } catch {
    throw new Error(`接口 ${url} 返回的不是合法 JSON`);
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
    message: `连接成功（${latencyMs}ms），可用模型 ${models.length} 个`,
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
    message: lines.length === 0 ? '接口未返回余额信息' : undefined,
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
      { label: '累计额度', value: credits.toFixed(4) },
      { label: '已使用', value: usage.toFixed(4) },
    ],
    fetchedAt: new Date().toISOString(),
  };
}

async function fetchMoonshotBalance(ctx: SlotContext): Promise<BalanceInfo> {
  const body = (await getJson(joinUrl(ctx.runtime.baseUrl, 'users/me/balance'), ctx.runtime.apiKey)) as {
    data?: { available_balance?: number; voucher_balance?: number; cash_balance?: number };
  };
  const data = body?.data;
  if (!data) return unsupportedBalance('余额接口返回为空');

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
      return unsupportedBalance(`${preset.label} 未提供余额查询接口，余额请到服务商控制台查看`);
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
  if (!ctx.runtime.baseUrl) throw new Error('文本槽位还没有配置 Base URL');
  if (ctx.requiresKey && !ctx.runtime.apiKey) throw new Error('文本槽位还没有填写 API Key');
  if (!isSlotEnabled('chat')) throw new Error('文本槽位已停用');

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
    throw new Error(`调用文本模型失败：${reason}`);
  }
  if (!response.ok) throw new Error(await describeHttpError(response));

  const body = (await response.json()) as {
    choices?: { message?: { content?: string } }[];
  };
  const content = body.choices?.[0]?.message?.content;
  if (typeof content !== 'string' || !content.trim()) throw new Error('文本模型没有返回内容');
  return content;
}

/** 右侧 AI 助手：用文本槽位的模型做多轮对话（历史由前端维护并整段发来） */
export async function assistantReply(messages: ChatMessage[]): Promise<string> {
  const cleaned = messages
    .filter((message) => (message.role === 'user' || message.role === 'assistant') && message.content.trim())
    .slice(-20)
    .map((message) => ({ role: message.role, content: message.content.slice(0, 4000) }));
  if (cleaned.length === 0) throw new Error('先输入内容再发送');

  const system: ChatMessage = {
    role: 'system',
    content:
      '你是「精灵帧动画编辑器」的内置助手，服务对象是做 2D 游戏精灵动画的美术/程序。' +
      '流程是：图片 → 循环视频 → 2D 帧动画。' +
      '回答用简体中文，简洁、可执行；涉及具体操作时说明在哪个页面点哪个按钮。不要臆造本应用不存在的功能。',
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
    const system = [
      '你是游戏美术资源助手，负责为 AI 出图挑选「键控纯色背景」。',
      '步骤：1) 从描述里判断主体（角色/物件）最突出的主色调；2) 选一个与主体色相差最大的高饱和纯色作为背景。',
      '硬性要求：背景必须是单一纯色、无渐变；不要选白色或黑色（边缘容易脏）；主体偏绿时不要选绿幕。',
      '只输出一行 JSON，不要解释，格式：{"color":"#RRGGBB","reason":"不超过30字的中文理由"}',
    ].join('\n');

    const content = await chatComplete(
      [
        { role: 'system', content: system },
        { role: 'user', content: `素材描述：${prompt.slice(0, 1500)}` },
      ],
      200,
    );

    const colorMatch = content.match(/#[0-9a-fA-F]{6}/);
    if (!colorMatch) throw new Error('模型没有返回颜色');

    const reasonMatch = content.match(/"reason"\s*:\s*"([^"]{0,80})"/);
    return {
      color: colorMatch[0].toUpperCase(),
      reason: reasonMatch ? reasonMatch[1] : '由文本模型分析主体色后选出',
      source: 'ai',
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ...fallback, reason: `${fallback.reason}（AI 分析不可用：${message.slice(0, 60)}）` };
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
  image:
    '你是游戏美术提示词工程师，专门为「后续要抠图做成帧动画素材」的生图任务写提示词。' +
    '把用户的一句话扩写成详细提示词，必须包含这些要素：' +
    '① 主体外观、服装材质、姿态、镜头、光影、画风、画幅；' +
    '② 背景写死成一种纯色（明确说出颜色，如纯白、亮绿 #00FF00、深蓝），' +
    '并要求背景没有渐变、没有纹理、没有地面投影、没有任何道具或环境元素；' +
    '③ 主体轮廓干净清晰，不要毛发级碎边、不要半透明、不要烟雾粒子光效；' +
    '④ 四角和画面边缘保持纯背景色，主体不要碰到边缘，方便后期裁掉角落水印；' +
    '⑤ 画面里绝对不能出现水印、logo、文字、签名、边框、平台标识、时间戳。' +
    '不要改变用户原意，不要编造与角色无关的内容。' +
    '只输出改写后的提示词本身，不要解释、不要分点。长度 100–180 字。',
  video:
    '你是游戏动画导演，专门为「首帧=尾帧无缝循环 + 后续要抠图」的 AI 视频写提示词。' +
    '把用户的动作描述改写成详细提示词，必须包含这些要素：' +
    '① 只描述主体动作、节奏和镜头，镜头固定不动；' +
    '② 明确强调首尾姿态完全一致、动作幅度适中、不要出现新物体、主体不要进出画面；' +
    '③ 背景写死成一种纯色（明确说出颜色，和主体反差要大），' +
    '并要求整段视频背景完全不变、没有渐变、没有地面投影、没有环境元素；' +
    '④ 主体轮廓干净清晰，不要毛发级碎边、不要半透明、不要烟雾火焰粒子光效；' +
    '⑤ 四角和画面边缘保持纯背景色，主体不要碰到边缘，方便后期裁掉角落水印；' +
    '⑥ 画面里绝对不能出现水印、logo、文字、签名、边框、平台标识、时间戳。' +
    '只输出改写后的提示词本身，不要解释、不要分点。长度 80–160 字。',
};
export async function optimizePrompt(prompt: string, kind: 'image' | 'video'): Promise<OptimizePromptResult> {
  const text = (prompt || '').trim();
  if (!text) throw new Error('先写一句提示词再优化');

  const content = await chatComplete(
    [
      { role: 'system', content: PROMPT_SYSTEM[kind] },
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

  if (!optimized) throw new Error('模型没有返回内容');
  return { prompt: optimized, source: 'ai' };
}
