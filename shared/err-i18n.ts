/**
 * 主进程返回给界面的错误文案（三语）。
 *
 * 为什么单独一份、而不是和 src/i18n 合并：
 * - 主进程（electron/）不能 import React，src/i18n 里有 useLang() 的 hook；
 * - 界面文案和「IPC 返回的错误」本来就是两拨词，分开维护反而更清楚。
 *
 * 约定：这里只放**会显示在界面上**的文案。日志、开发者注释不在此列。
 * 缺 key 时回落简体中文，再不行直接把 key 显示出来（方便一眼看出漏翻译）。
 */
import type { Lang } from './ipc';

type Dict = Record<string, string>;

const zhCN: Dict = {
  /* ---------- 通用 ---------- */
  'err.unknown': '未知错误',
  'err.badRequest': '请求格式不对',
  'err.notFound': '找不到目标',
  'err.ioFailed': '读写文件失败：{error}',

  /* ---------- 界面设置（主题 / 语言） ---------- */
  'err.ui.badTheme': '未知的主题模式',
  'err.ui.badLang': '未知的语言',

  /* ---------- 模型设置 ---------- */
  'err.settings.badSlot': '未知的槽位：{slot}',
  'err.settings.badProvider': '未知的服务商：{provider}',
  'err.settings.slotNotFound': '这个槽位还没有配置',
  'err.settings.readFailed': '读取配置失败：{error}',
  'err.settings.writeFailed': '写入配置失败：{error}',
  'err.settings.badJson': '配置文件不是合法的 JSON：{error}',
  'err.settings.balanceNoKey': '还没保存 API Key，无法查询余额',
  'err.settings.balanceUnsupported': '这个服务商不支持余额查询',
  'err.settings.balanceFailed': '查询余额失败：{error}',
  'err.settings.testFailed': '连接测试失败：{error}',
  'err.settings.testNoUrl': '还没有填写 Base URL，无法测试',
  'err.settings.testNoModel': '还没有选择模型，无法测试',
  'err.settings.modelListFailed': '拉取模型列表失败：{error}',
  'err.settings.modelListEmpty': '接口没有返回任何模型（部分平台不开放 /models）',
  'err.settings.saveFailed': '保存模型设置失败：{error}',
  'err.settings.keyClearFailed': '删除 API Key 失败：{error}',
  'err.settings.noActiveSlot': '没有可用的槽位',

  /* ---------- 参数校验（渲染层传错才会出现，但同样显示在界面上） ---------- */
  'err.args.badSettings': '设置参数无效',
  'err.args.badSlot': '未知的能力槽位',
  'err.args.badProvider': '未知的模型服务商',
  'err.args.modelTooLong': '模型名称过长',
  'err.args.badGenerate': '生成参数无效',
  'err.args.promptEmpty': '提示词不能为空',
  'err.args.promptTooLong': '提示词过长（上限 4000 字）',
  'err.args.sizeTooLong': '尺寸参数过长',
  'err.args.sameSlot': '来源和目标槽位相同',
  'err.args.badEnabled': '启用状态无效',
  'err.args.badMessages': '消息格式无效',
  'err.args.badPrompt': '提示词无效',
  'err.args.badOptimizeKind': '优化类型无效',
  'err.args.baseUrlTooLong': 'Base URL 过长',
  'err.args.baseUrlScheme': 'Base URL 需要以 http:// 或 https:// 开头',
  'err.args.apiKeyNotString': 'API Key 必须是字符串',
  'err.args.apiKeyTooLong': 'API Key 过长',

  /* ---------- AI 服务（调用模型 / 余额 / 连接测试） ---------- */
  'err.ai.noBaseUrl': '还没有填写 Base URL，请先在模型设置里补上接口地址',
  'err.ai.noKey': '还没有填写 API Key，请在模型设置里填入并保存',
  'err.ai.badUrl': 'Base URL 不是合法地址：{url}',
  'err.ai.hint401': '（API Key 无效或已过期）',
  'err.ai.hint404': '（接口地址不存在，检查 Base URL）',
  'err.ai.http': 'HTTP {status} {statusText}{hint}{detail}',
  'err.ai.httpDetail': '：{detail}',
  'err.ai.connectFailed': '连接 {url} 失败：{reason}（检查网络 / 代理 / VPN，或 Base URL 是否正确）',
  'err.ai.badJson': '接口 {url} 返回的不是合法 JSON',
  'err.ai.testOk': '连接成功（{ms}ms），可用模型 {count} 个',
  'err.ai.balanceNoInfo': '接口未返回余额信息',
  'err.ai.balanceCredits': '累计额度',
  'err.ai.balanceUsed': '已使用',
  'err.ai.balanceEmptyResponse': '余额接口返回为空',
  'err.ai.balanceUnsupportedProvider': '{provider} 未提供余额查询接口，余额请到服务商控制台查看',
  'err.ai.chatNoBaseUrl': '文本槽位还没有配置 Base URL',
  'err.ai.chatNoKey': '文本槽位还没有填写 API Key',
  'err.ai.chatDisabled': '文本槽位已停用',
  'err.ai.chatFailed': '调用文本模型失败：{reason}',
  'err.ai.emptyReply': '文本模型没有返回内容',
  'err.ai.emptyInput': '先输入内容再发送',
  'err.ai.noColor': '模型没有返回颜色',
  'err.ai.colorFallbackReason': '由文本模型分析主体色后选出',
  'err.ai.colorReasonSuffix': '（AI 分析不可用：{message}）',
  'err.ai.emptyPrompt': '先写一句提示词再优化',
  'err.ai.emptyOptimized': '模型没有返回内容',

  /* ---------- 其它会显示在界面上的主进程文案 ---------- */
  'app.name': '精灵帧动画编辑器',
  'err.settings.copyNoKey': '来源槽位没有该服务商的 Key，请先在那里填写',
  'app.usage.note': '本地统计：素材库登记数 + 缓存目录文件数，按内置单价估算，不等于服务商账单',

  /* ---------- 视频生成 ---------- */
  'err.video.badImagePath': '图片路径无效',
  'err.video.outsideData': '不允许访问数据目录以外的文件',
  'err.video.hintNotOpen':
    '（该账号还没开通这个视频模型：去方舟控制台「开通管理」开通 Seedance；注意 2.5 要求账户余额 ≥ 200 元）',
  'err.video.hint401': '（API Key 无效或未开通该模型）',
  'err.video.hint403': '（没有权限，检查视频模型是否已在控制台开通）',
  'err.video.hint404': '（接口地址不存在，检查 Base URL）',
  'err.video.hint429': '（触发限流，稍后再试）',
  'err.video.http': 'HTTP {status} {statusText}{hint}{detail}',
  'err.video.httpDetail': '：{detail}',
  'err.video.requestFailed': '请求 {url} 失败：{reason}（检查网络 / 代理 / VPN，或 Base URL）',
  'err.video.badJson': '接口 {url} 返回的不是合法 JSON',
  'err.video.downloadFailed': '下载视频失败：{reason}',
  'err.video.downloadHttp': '下载视频失败：HTTP {status}',
  'err.video.noBaseUrl': '视频槽位还没有配置 Base URL',
  'err.video.noModel': '视频槽位还没有配置模型',
  'err.video.noKey': '视频槽位还没有填写 API Key，请到「模型设置 → 视频生成」里保存',
  'err.video.emptyImage': '图片内容为空',
  'err.video.imageTooLarge': '图片过大（上限 20MB），请先缩尺寸',
  'err.video.needRef': '参考模式下至少要选 1 张参考图',
  'err.video.refTooLarge': '参考图过大（上限 20MB）',
  'err.video.submitting': '正在提交生成任务…',
  'err.video.noTaskId': '服务商没有返回任务 id',
  'err.video.genFailed': '生成失败：{reason}',
  'err.video.noReason': '服务商未说明原因',
  'err.video.cancelled': '任务已取消',
  'err.video.expired': '任务已过期',
  'err.video.queued': '排队中…',
  'err.video.generating': '生成中…',
  'err.video.waiting': '{message}（已等待 {seconds} 秒）',
  'err.video.timeout': '等待超时（20 分钟）：任务可能仍在服务商侧排队，稍后可重试',
  'err.video.downloading': '正在下载视频…',
  'err.video.emptyDownload': '下载到的视频为空',
  'err.video.done': '生成完成，已存入素材库',

  /* ---------- 本地抠图模型（名称 / 下载提示 / 错误） ---------- */
  'model.birefnet.label': 'BiRefNet 官方原版 · 官网同款（fp32 973MB，最准）',
  'model.birefnet.hint':
    'birefnet.onnx ← https://hf-mirror.com/onnx-community/BiRefNet-ONNX/resolve/main/onnx/model.onnx',
  'model.u2net.label': 'U2Net · 轻量备选（168MB，320 输入，很快）',
  'model.u2net.hint':
    'u2net.onnx ← https://github.com/danielgatis/rembg/releases/download/v0.0.0/u2net.onnx（放到 data/models/，不用改名）',
  'model.lite.label': 'BiRefNet_lite-512 · 备选（182MB，1.6 秒）',
  'model.lite.hint':
    'birefnet-lite-512.onnx ← https://hf-mirror.com/studioludens/birefnet-lite-512/resolve/main/onnx/model.onnx',
  'model.toonout.label': 'ToonOut · 动漫立绘最强（469MB，慢）',
  'model.toonout.hint':
    'birefnet-toonout.onnx ← https://hf-mirror.com/sprited/birefnet-toonout-onnx/resolve/main/birefnet-toonout-fp16.onnx',
  'model.anime.label': 'isnet-anime · 动漫专用（168MB，快）',
  'model.anime.hint':
    'isnet-anime.onnx ← https://hf-mirror.com/skytnt/anime-seg/resolve/main/isnetis.onnx',
  'model.ben2.label': 'BEN2 · 主体保留最完整（208MB，需 CPU 支持 fp16，多数机器跑不了）',
  'model.ben2.hint':
    'ben2.onnx ← https://hf-mirror.com/onnx-community/BEN2-ONNX/resolve/main/onnx/model_fp16.onnx',
  'model.isnetGeneral.label': 'ISNet general-use · rembg 高质量（176MB）',
  'model.isnetGeneral.hint':
    'isnet-general-use.onnx ← https://github.com/danielgatis/rembg/releases/download/v0.0.0/isnet-general-use.onnx（放到 data/models/，不用改名）',
  'err.model.missing': '没有找到 {id} 模型。请把权重放到：\n{dir}\n下载地址：{hint}',
  'err.model.decodeFailed': '图片解码失败',
  'err.model.bitmapIncomplete': '位图数据不完整',
  'err.model.emptyImage': '图片为空',
  'err.model.noOutput': '模型没有输出',
  'err.model.emptyResult': '抠图结果为空',
  'err.model.noSubject':
    '模型没认出主体（前景占比仅 {percent}%），结果会是一张全透明的空图。常见原因：① 背景是纯白/纯色，当前模型对它不敏感 —— 换「isnet-anime」或「ToonOut」再试；② 这张图本身已经是抠好的透明 PNG；③ 主体在画面里太小。',

  /* ---------- 文件 / 帧目录（抠图批次、取色、保存） ---------- */
  'err.file.mattingDisabled': 'AI 抠图已禁用（shared/features.ts 里可重新开启）',
  'err.file.badPath': '文件路径无效',
  'err.file.emptyImagePath': '图片路径为空（帧动画的内存帧请传 dataUrl）',
  'err.file.noPyshim': '没有找到 pyshim/python.exe（项目 pyshim 目录缺失）',
  'err.file.badFrameDir': '帧目录无效',
  'err.file.badJobId': '任务标识无效',
  'err.file.noFrames': '目录里没有帧文件',
  'err.file.colorPickFailed': '取色失败（图片太小或无法解码）',
  'err.file.needColor': '至少要有一个背景色',
  'err.file.badDirKind': '未知的目录类型',
  'err.file.badFileName': '文件名无效',
  'err.file.badSaveArgs': '保存参数无效',
  'err.file.noSourcePath': '缺少原图路径',
  'err.file.noImageData': '缺少图片数据',

  /* ---------- 帧集合 / 抠图结果目录 ---------- */
  'err.frames.badData': '帧数据格式无效（需要 PNG dataURL）',
  'err.frames.empty': '没有可保存的帧',
  'err.frames.tooFew': '至少要 2 帧才能组成动画（现在只有 1 帧）',
  'err.frames.nameExists': '已存在同名文件夹「{name}」，请换一个名称',
  'err.frames.setMissing': '帧集合「{id}」不存在',
  'err.frames.emptyName': '名称不能为空',
  'err.frames.noMeta': '这个集合缺少 meta.json，无法重命名',
  'err.frames.nameExistsNoOverwrite': '已存在同名文件夹「{name}」，不覆盖，重命名失败',
  'err.frames.noFramesInSet': '这个集合里没有可识别的帧，无法重命名',
  'err.frames.outsideDir': '非法的项目目录',
  'err.frames.notOutputDir': '只能重命名抠图结果目录（名字以 -matte / -key 结尾）',
  'err.frames.outputMissing': '抠图结果「{name}」不存在',
  'err.frames.badFrameName': '帧文件名不合法：{name}',
  'err.frames.badFramePath': '非法的帧路径',

  /* ---------- 素材库 ---------- */
  'err.kb.missing': '素材不存在',
  'err.kb.emptyName': '文件名不能为空',
  'err.kb.nameExists': '已存在同名文件「{name}」，不覆盖，重命名失败',
  'err.kb.sourceGone': '原文件已不存在，无法重命名',
  'err.kb.badArgs': '参数无效',
  'err.kb.noId': '缺少素材 id',
  'err.kb.badNewName': '新文件名无效',
  'dialog.import.title': '导入到素材库（图片 / 视频）',
  'dialog.import.media': '图片与视频',
  'dialog.import.images': '图片',
  'dialog.import.videos': '视频',
  'dialog.import.all': '全部文件',

  /* ---------- 图像生成 ---------- */
  'err.image.hint401': '（API Key 无效或未开通该模型）',
  'err.image.hint403': '（没有权限，检查模型是否已在控制台开通）',
  'err.image.hint404': '（接口地址不存在，检查 Base URL）',
  'err.image.hint429': '（触发限流，稍后再试）',
  'err.image.http': 'HTTP {status} {statusText}{hint}{detail}',
  'err.image.httpDetail': '：{detail}',
  'err.image.callFailed': '调用 {url} 失败：{reason}（检查网络 / 代理 / Base URL）',
  'err.image.badJson': '接口 {url} 返回的不是合法 JSON',
  'err.image.noImageData': '服务商返回的图片既没有 b64_json 也没有 url',
  'err.image.downloadFailed': '下载生成结果失败：{reason}',
  'err.image.downloadHttp': '下载生成结果失败：HTTP {status}',
  'err.image.emptyPrompt': '提示词不能为空',
  'err.image.promptTooLong': '提示词过长（上限 {max} 字）',
  'err.image.noBaseUrl': '图像槽位还没有配置 Base URL',
  'err.image.noModel': '图像槽位还没有配置模型',
  'err.image.noKey': '图像槽位还没有填写 API Key，请到「模型设置 → 图像生成」里保存',
  'err.image.noImages': '接口没有返回任何图片',
  'err.image.genFailed': '生成失败：{reason}',
  'err.image.emptyResult': '生成结果为空，可能被服务商过滤，换提示词再试',

  /* ---------- rembg 本地抠图进程 ---------- */
  'err.rembg.ready': 'rembg 就绪',
  'err.rembg.probeFailed': 'rembg 探测失败（退出码 {code}）',
  'err.rembg.noPyshim':
    '没有找到 pyshim/python.exe。请把便携 Python 放到项目的 pyshim/ 目录（或用 npm run setup:rembg 准备）。',
  'err.rembg.badImageData': '图片数据格式不正确',
  'err.rembg.imageMissing': '图片文件不存在：{path}',
  'err.rembg.spawnFailed': '启动 rembg 失败：{error}',
  'err.rembg.exitCode': 'rembg 退出码 {code}',
  'err.rembg.noOutput': 'rembg 没有生成输出文件',
  'err.rembg.noPyshimBatch': '没有找到 pyshim/python.exe，无法批量抠图',
  'err.rembg.inputDirMissing': '输入目录不存在：{dir}',
  'err.rembg.memoryNote':
    '可用内存只剩 {free} GB，并行数从 {requested} 自动降到 {workers}（防止卡死）',
  'err.rembg.unknownError': '未知错误',
  'err.rembg.cancelled': '已手动停止批量抠图',
  'err.rembg.batchExitCode': 'rembg 批量处理退出码 {code}',

  /* ---------- 帧 IPC / 媒体文件 ---------- */
  'err.frames.badArgs': '参数无效',
  'err.frames.tooMany': '单次最多保存 600 帧，请减少抽帧数量',
  'err.frames.badId': '项目 id 无效',
  'err.frames.badNewName': '新名称无效',
  'err.frames.badOutputName': '结果目录名无效',
  'err.frames.badFileName': '帧文件名无效',
  'err.file.outsideData': '不允许访问数据目录以外的文件',
  'err.file.missing': '文件不存在',
  'err.file.imageTooLarge30': '图片过大（上限 30MB）',
  'err.file.emptyEdit': '编辑结果为空',
  'err.file.editTooLarge': '编辑结果过大（上限 30MB）',
  'err.file.editedFrom': '编辑自 {name}',
  'err.file.assetMissing': '素材文件不存在',
  'err.video.badArgs': '生成参数无效',
  'err.video.noImage': '请先选择一张图片',
  'err.frames.dirMissing': '目录不存在：{dir}',
  'err.frames.tooFewLoop': '帧太少（至少 3 帧）才能找循环点',
  'err.frames.badFirstFrame': '第 1 帧解码失败',

  /* ---------- 发给 AI 模型的系统提示词（跟随界面语言） ---------- */
  'prompt.assistant':
    '你是「精灵帧动画编辑器」的内置助手，服务对象是做 2D 游戏精灵动画的美术/程序。' +
    '流程是：图片 → 循环视频 → 2D 帧动画。' +
    '回答用简体中文，简洁、可执行；涉及具体操作时说明在哪个页面点哪个按钮。不要臆造本应用不存在的功能。',
  'prompt.bgColor': [
    '你是游戏美术资源助手，负责为 AI 出图挑选「键控纯色背景」。',
    '步骤：1) 从描述里判断主体（角色/物件）最突出的主色调；2) 选一个与主体色相差最大的高饱和纯色作为背景。',
    '硬性要求：背景必须是单一纯色、无渐变；不要选白色或黑色（边缘容易脏）；主体偏绿时不要选绿幕。',
    '只输出一行 JSON，不要解释，格式：{"color":"#RRGGBB","reason":"不超过30字的中文理由"}',
  ].join('\n'),
  'prompt.bgColor.user': '素材描述：{text}',
  'prompt.optImage':
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
  'prompt.optVideo':
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
  'prompt.video.default':
    '角色轻微呼吸、衣摆与发丝自然摆动，镜头固定，动作首尾衔接无缝循环',
  'prompt.video.bg':
    '【背景要求】严格保持原图的纯色背景不变：颜色、亮度、平整度都不得变化；禁止新增地面、道具、光斑、烟雾、阴影或渐变，禁止更换场景或改变画面构图。',
  'prompt.video.ref':
    '【参考要求】参考素材仅用于参考动作节奏与姿态变化；不要复制参考素材里的角色外观、服装、配色或画风，保持原图美术风格不变。',
};

const zhTW: Dict = {
  /* ---------- 通用 ---------- */
  'err.unknown': '未知錯誤',
  'err.badRequest': '請求格式不正確',
  'err.notFound': '找不到目標',
  'err.ioFailed': '讀寫檔案失敗：{error}',

  /* ---------- 介面設定（主題 / 語言） ---------- */
  'err.ui.badTheme': '未知的主題模式',
  'err.ui.badLang': '未知的語言',

  /* ---------- 模型設定 ---------- */
  'err.settings.badSlot': '未知的欄位：{slot}',
  'err.settings.badProvider': '未知的服務商：{provider}',
  'err.settings.slotNotFound': '這個欄位還沒有設定',
  'err.settings.readFailed': '讀取設定失敗：{error}',
  'err.settings.writeFailed': '寫入設定失敗：{error}',
  'err.settings.badJson': '設定檔不是合法的 JSON：{error}',
  'err.settings.balanceNoKey': '還沒儲存 API Key，無法查詢餘額',
  'err.settings.balanceUnsupported': '這個服務商不支援餘額查詢',
  'err.settings.balanceFailed': '查詢餘額失敗：{error}',
  'err.settings.testFailed': '連線測試失敗：{error}',
  'err.settings.testNoUrl': '還沒填寫 Base URL，無法測試',
  'err.settings.testNoModel': '還沒選擇模型，無法測試',
  'err.settings.modelListFailed': '拉取模型列表失敗：{error}',
  'err.settings.modelListEmpty': '介面沒有回傳任何模型（部分平台不開放 /models）',
  'err.settings.saveFailed': '儲存模型設定失敗：{error}',
  'err.settings.keyClearFailed': '刪除 API Key 失敗：{error}',
  'err.settings.noActiveSlot': '沒有可用的欄位',

  /* ---------- 參數驗證 ---------- */
  'err.args.badSettings': '設定參數無效',
  'err.args.badSlot': '未知的能力欄位',
  'err.args.badProvider': '未知的模型服務商',
  'err.args.modelTooLong': '模型名稱過長',
  'err.args.badGenerate': '生成參數無效',
  'err.args.promptEmpty': '提示詞不能為空',
  'err.args.promptTooLong': '提示詞過長（上限 4000 字）',
  'err.args.sizeTooLong': '尺寸參數過長',
  'err.args.sameSlot': '來源和目標欄位相同',
  'err.args.badEnabled': '啟用狀態無效',
  'err.args.badMessages': '訊息格式無效',
  'err.args.badPrompt': '提示詞無效',
  'err.args.badOptimizeKind': '優化類型無效',
  'err.args.baseUrlTooLong': 'Base URL 過長',
  'err.args.baseUrlScheme': 'Base URL 必須以 http:// 或 https:// 開頭',
  'err.args.apiKeyNotString': 'API Key 必須是字串',
  'err.args.apiKeyTooLong': 'API Key 過長',

  /* ---------- AI 服務（呼叫模型 / 餘額 / 連線測試） ---------- */
  'err.ai.noBaseUrl': '還沒填寫 Base URL，請先在模型設定裡補上介面位址',
  'err.ai.noKey': '還沒填寫 API Key，請在模型設定裡填入並儲存',
  'err.ai.badUrl': 'Base URL 不是合法位址：{url}',
  'err.ai.hint401': '（API Key 無效或已過期）',
  'err.ai.hint404': '（介面位址不存在，檢查 Base URL）',
  'err.ai.http': 'HTTP {status} {statusText}{hint}{detail}',
  'err.ai.httpDetail': '：{detail}',
  'err.ai.connectFailed': '連線 {url} 失敗：{reason}（檢查網路 / 代理 / VPN，或 Base URL 是否正確）',
  'err.ai.badJson': '介面 {url} 回傳的不是合法 JSON',
  'err.ai.testOk': '連線成功（{ms}ms），可用模型 {count} 個',
  'err.ai.balanceNoInfo': '介面未回傳餘額資訊',
  'err.ai.balanceCredits': '累計額度',
  'err.ai.balanceUsed': '已使用',
  'err.ai.balanceEmptyResponse': '餘額介面回傳為空',
  'err.ai.balanceUnsupportedProvider': '{provider} 未提供餘額查詢介面，餘額請到服務商控制台查看',
  'err.ai.chatNoBaseUrl': '文字欄位還沒設定 Base URL',
  'err.ai.chatNoKey': '文字欄位還沒填寫 API Key',
  'err.ai.chatDisabled': '文字欄位已停用',
  'err.ai.chatFailed': '呼叫文字模型失敗：{reason}',
  'err.ai.emptyReply': '文字模型沒有回傳內容',
  'err.ai.emptyInput': '先輸入內容再送出',
  'err.ai.noColor': '模型沒有回傳顏色',
  'err.ai.colorFallbackReason': '由文字模型分析主體色後選出',
  'err.ai.colorReasonSuffix': '（AI 分析不可用：{message}）',
  'err.ai.emptyPrompt': '先寫一句提示詞再優化',
  'err.ai.emptyOptimized': '模型沒有回傳內容',

  /* ---------- 其它會顯示在介面上的主程序文案 ---------- */
  'app.name': '精靈影格動畫編輯器',
  'err.settings.copyNoKey': '來源欄位沒有該服務商的 Key，請先在那裡填寫',
  'app.usage.note': '本機統計：素材庫登記數 + 快取目錄檔案數，按內建單價估算，不等於服務商帳單',

  /* ---------- 影片生成 ---------- */
  'err.video.badImagePath': '圖片路徑無效',
  'err.video.outsideData': '不允許存取資料目錄以外的檔案',
  'err.video.hintNotOpen':
    '（該帳號還沒開通這個影片模型：去方舟控制台「開通管理」開通 Seedance；注意 2.5 要求帳戶餘額 ≥ 200 元）',
  'err.video.hint401': '（API Key 無效或未開通該模型）',
  'err.video.hint403': '（沒有權限，檢查影片模型是否已在控制台開通）',
  'err.video.hint404': '（介面位址不存在，檢查 Base URL）',
  'err.video.hint429': '（觸發限流，稍後再試）',
  'err.video.http': 'HTTP {status} {statusText}{hint}{detail}',
  'err.video.httpDetail': '：{detail}',
  'err.video.requestFailed': '請求 {url} 失敗：{reason}（檢查網路 / 代理 / VPN，或 Base URL）',
  'err.video.badJson': '介面 {url} 回傳的不是合法 JSON',
  'err.video.downloadFailed': '下載影片失敗：{reason}',
  'err.video.downloadHttp': '下載影片失敗：HTTP {status}',
  'err.video.noBaseUrl': '影片欄位還沒設定 Base URL',
  'err.video.noModel': '影片欄位還沒設定模型',
  'err.video.noKey': '影片欄位還沒填寫 API Key，請到「模型設定 → 影片生成」裡儲存',
  'err.video.emptyImage': '圖片內容為空',
  'err.video.imageTooLarge': '圖片過大（上限 20MB），請先縮小尺寸',
  'err.video.needRef': '參考模式下至少要選 1 張參考圖',
  'err.video.refTooLarge': '參考圖過大（上限 20MB）',
  'err.video.submitting': '正在提交生成任務…',
  'err.video.noTaskId': '服務商沒有回傳任務 id',
  'err.video.genFailed': '生成失敗：{reason}',
  'err.video.noReason': '服務商未說明原因',
  'err.video.cancelled': '任務已取消',
  'err.video.expired': '任務已過期',
  'err.video.queued': '排隊中…',
  'err.video.generating': '生成中…',
  'err.video.waiting': '{message}（已等待 {seconds} 秒）',
  'err.video.timeout': '等待逾時（20 分鐘）：任務可能仍在服務商端排隊，稍後可重試',
  'err.video.downloading': '正在下載影片…',
  'err.video.emptyDownload': '下載到的影片為空',
  'err.video.done': '生成完成，已存入素材庫',

  /* ---------- 本機去背模型 ---------- */
  'model.birefnet.label': 'BiRefNet 官方原版 · 官網同款（fp32 973MB，最準）',
  'model.birefnet.hint':
    'birefnet.onnx ← https://hf-mirror.com/onnx-community/BiRefNet-ONNX/resolve/main/onnx/model.onnx',
  'model.u2net.label': 'U2Net · 輕量備選（168MB，320 輸入，很快）',
  'model.u2net.hint':
    'u2net.onnx ← https://github.com/danielgatis/rembg/releases/download/v0.0.0/u2net.onnx（放到 data/models/，不用改名）',
  'model.lite.label': 'BiRefNet_lite-512 · 備選（182MB，1.6 秒）',
  'model.lite.hint':
    'birefnet-lite-512.onnx ← https://hf-mirror.com/studioludens/birefnet-lite-512/resolve/main/onnx/model.onnx',
  'model.toonout.label': 'ToonOut · 動漫立繪最強（469MB，慢）',
  'model.toonout.hint':
    'birefnet-toonout.onnx ← https://hf-mirror.com/sprited/birefnet-toonout-onnx/resolve/main/birefnet-toonout-fp16.onnx',
  'model.anime.label': 'isnet-anime · 動漫專用（168MB，快）',
  'model.anime.hint':
    'isnet-anime.onnx ← https://hf-mirror.com/skytnt/anime-seg/resolve/main/isnetis.onnx',
  'model.ben2.label': 'BEN2 · 主體保留最完整（208MB，需 CPU 支援 fp16，多數機器跑不了）',
  'model.ben2.hint':
    'ben2.onnx ← https://hf-mirror.com/onnx-community/BEN2-ONNX/resolve/main/onnx/model_fp16.onnx',
  'model.isnetGeneral.label': 'ISNet general-use · rembg 高品質（176MB）',
  'model.isnetGeneral.hint':
    'isnet-general-use.onnx ← https://github.com/danielgatis/rembg/releases/download/v0.0.0/isnet-general-use.onnx（放到 data/models/，不用改名）',
  'err.model.missing': '沒有找到 {id} 模型。請把權重放到：\n{dir}\n下載位址：{hint}',
  'err.model.decodeFailed': '圖片解碼失敗',
  'err.model.bitmapIncomplete': '點陣圖資料不完整',
  'err.model.emptyImage': '圖片為空',
  'err.model.noOutput': '模型沒有輸出',
  'err.model.emptyResult': '去背結果為空',
  'err.model.noSubject':
    '模型沒認出主體（前景占比僅 {percent}%），結果會是一張全透明的空圖。常見原因：① 背景是純白/純色，目前模型對它不敏感 —— 換「isnet-anime」或「ToonOut」再試；② 這張圖本身已經是去背好的透明 PNG；③ 主體在畫面裡太小。',

  /* ---------- 檔案 / 影格目錄 ---------- */
  'err.file.mattingDisabled': 'AI 去背已停用（shared/features.ts 裡可重新開啟）',
  'err.file.badPath': '檔案路徑無效',
  'err.file.emptyImagePath': '圖片路徑為空（影格動畫的記憶體影格請傳 dataUrl）',
  'err.file.noPyshim': '沒有找到 pyshim/python.exe（專案 pyshim 目錄缺失）',
  'err.file.badFrameDir': '影格目錄無效',
  'err.file.badJobId': '任務標識無效',
  'err.file.noFrames': '目錄裡沒有影格檔案',
  'err.file.colorPickFailed': '取色失敗（圖片太小或無法解碼）',
  'err.file.needColor': '至少要有一個背景色',
  'err.file.badDirKind': '未知的目錄類型',
  'err.file.badFileName': '檔名無效',
  'err.file.badSaveArgs': '儲存參數無效',
  'err.file.noSourcePath': '缺少原圖路徑',
  'err.file.noImageData': '缺少圖片資料',

  /* ---------- 影格集合 / 去背結果目錄 ---------- */
  'err.frames.badData': '影格資料格式無效（需要 PNG dataURL）',
  'err.frames.empty': '沒有可儲存的影格',
  'err.frames.tooFew': '至少要 2 格才能組成動畫（現在只有 1 格）',
  'err.frames.nameExists': '已存在同名資料夾「{name}」，請換一個名稱',
  'err.frames.setMissing': '影格集合「{id}」不存在',
  'err.frames.emptyName': '名稱不能為空',
  'err.frames.noMeta': '這個集合缺少 meta.json，無法重新命名',
  'err.frames.nameExistsNoOverwrite': '已存在同名資料夾「{name}」，不覆蓋，重新命名失敗',
  'err.frames.noFramesInSet': '這個集合裡沒有可辨識的影格，無法重新命名',
  'err.frames.outsideDir': '專案目錄不合法',
  'err.frames.notOutputDir': '只能重新命名去背結果目錄（名稱以 -matte / -key 結尾）',
  'err.frames.outputMissing': '去背結果「{name}」不存在',
  'err.frames.badFrameName': '影格檔名不合法：{name}',
  'err.frames.badFramePath': '影格路徑不合法',

  /* ---------- 素材庫 ---------- */
  'err.kb.missing': '素材不存在',
  'err.kb.emptyName': '檔名不能為空',
  'err.kb.nameExists': '已存在同名檔案「{name}」，不覆蓋，重新命名失敗',
  'err.kb.sourceGone': '原始檔案已不存在，無法重新命名',
  'err.kb.badArgs': '參數無效',
  'err.kb.noId': '缺少素材 id',
  'err.kb.badNewName': '新檔名無效',
  'dialog.import.title': '匯入素材庫（圖片 / 影片）',
  'dialog.import.media': '圖片與影片',
  'dialog.import.images': '圖片',
  'dialog.import.videos': '影片',
  'dialog.import.all': '所有檔案',

  /* ---------- 影像生成 ---------- */
  'err.image.hint401': '（API Key 無效或未開通該模型）',
  'err.image.hint403': '（沒有權限，檢查模型是否已在控制台開通）',
  'err.image.hint404': '（介面位址不存在，檢查 Base URL）',
  'err.image.hint429': '（觸發限流，稍後再試）',
  'err.image.http': 'HTTP {status} {statusText}{hint}{detail}',
  'err.image.httpDetail': '：{detail}',
  'err.image.callFailed': '呼叫 {url} 失敗：{reason}（檢查網路 / 代理 / Base URL）',
  'err.image.badJson': '介面 {url} 回傳的不是合法 JSON',
  'err.image.noImageData': '服務商回傳的圖片既沒有 b64_json 也沒有 url',
  'err.image.downloadFailed': '下載生成結果失敗：{reason}',
  'err.image.downloadHttp': '下載生成結果失敗：HTTP {status}',
  'err.image.emptyPrompt': '提示詞不能為空',
  'err.image.promptTooLong': '提示詞過長（上限 {max} 字）',
  'err.image.noBaseUrl': '影像欄位還沒設定 Base URL',
  'err.image.noModel': '影像欄位還沒設定模型',
  'err.image.noKey': '影像欄位還沒填寫 API Key，請到「模型設定 → 影像生成」裡儲存',
  'err.image.noImages': '介面沒有回傳任何圖片',
  'err.image.genFailed': '生成失敗：{reason}',
  'err.image.emptyResult': '生成結果為空，可能被服務商過濾，換提示詞再試',

  /* ---------- rembg 本機去背程序 ---------- */
  'err.rembg.ready': 'rembg 就緒',
  'err.rembg.probeFailed': 'rembg 偵測失敗（結束碼 {code}）',
  'err.rembg.noPyshim':
    '沒有找到 pyshim/python.exe。請把可攜 Python 放到專案的 pyshim/ 目錄（或用 npm run setup:rembg 準備）。',
  'err.rembg.badImageData': '圖片資料格式不正確',
  'err.rembg.imageMissing': '圖片檔案不存在：{path}',
  'err.rembg.spawnFailed': '啟動 rembg 失敗：{error}',
  'err.rembg.exitCode': 'rembg 結束碼 {code}',
  'err.rembg.noOutput': 'rembg 沒有產生輸出檔案',
  'err.rembg.noPyshimBatch': '沒有找到 pyshim/python.exe，無法批次去背',
  'err.rembg.inputDirMissing': '輸入目錄不存在：{dir}',
  'err.rembg.memoryNote':
    '可用記憶體只剩 {free} GB，並行數從 {requested} 自動降到 {workers}（防止卡死）',
  'err.rembg.unknownError': '未知錯誤',
  'err.rembg.cancelled': '已手動停止批次去背',
  'err.rembg.batchExitCode': 'rembg 批次處理結束碼 {code}',

  /* ---------- 影格 IPC / 媒體檔案 ---------- */
  'err.frames.badArgs': '參數無效',
  'err.frames.tooMany': '單次最多儲存 600 格，請減少抽格數量',
  'err.frames.badId': '專案 id 無效',
  'err.frames.badNewName': '新名稱無效',
  'err.frames.badOutputName': '結果目錄名無效',
  'err.frames.badFileName': '影格檔名無效',
  'err.file.outsideData': '不允許存取資料目錄以外的檔案',
  'err.file.missing': '檔案不存在',
  'err.file.imageTooLarge30': '圖片過大（上限 30MB）',
  'err.file.emptyEdit': '編輯結果為空',
  'err.file.editTooLarge': '編輯結果過大（上限 30MB）',
  'err.file.editedFrom': '編輯自 {name}',
  'err.file.assetMissing': '素材檔案不存在',
  'err.video.badArgs': '生成參數無效',
  'err.video.noImage': '請先選擇一張圖片',
  'err.frames.dirMissing': '目錄不存在：{dir}',
  'err.frames.tooFewLoop': '影格太少（至少 3 格）才能找循環點',
  'err.frames.badFirstFrame': '第 1 格解碼失敗',

  /* ---------- 發給 AI 模型的系統提示詞（跟隨介面語言） ---------- */
  'prompt.assistant':
    '你是「精靈影格動畫編輯器」的內建助手，服務對象是做 2D 遊戲精靈動畫的美術/程式。' +
    '流程是：圖片 → 循環影片 → 2D 影格動畫。' +
    '回答用繁體中文，簡潔、可執行；涉及具體操作時說明在哪個頁面按哪個按鈕。不要臆造本應用不存在的功能。',
  'prompt.bgColor': [
    '你是遊戲美術資源助手，負責為 AI 出圖挑選「鍵控純色背景」。',
    '步驟：1) 從描述裡判斷主體（角色/物件）最突出的主色調；2) 選一個與主體色相差最大的高飽和純色作為背景。',
    '硬性要求：背景必須是單一純色、無漸層；不要選白色或黑色（邊緣容易髒）；主體偏綠時不要選綠幕。',
    '只輸出一行 JSON，不要解釋，格式：{"color":"#RRGGBB","reason":"不超過30字的繁體中文理由"}',
  ].join('\n'),
  'prompt.bgColor.user': '素材描述：{text}',
  'prompt.optImage':
    '你是遊戲美術提示詞工程師，專門為「後續要去背做成影格動畫素材」的生圖任務寫提示詞。' +
    '把使用者的一句話擴寫成詳細提示詞，必須包含這些要素：' +
    '① 主體外觀、服裝材質、姿態、鏡頭、光影、畫風、畫幅；' +
    '② 背景寫死成一種純色（明確說出顏色，如純白、亮綠 #00FF00、深藍），' +
    '並要求背景沒有漸層、沒有紋理、沒有地面投影、沒有任何道具或環境元素；' +
    '③ 主體輪廓乾淨清晰，不要毛髮級碎邊、不要半透明、不要煙霧粒子光效；' +
    '④ 四角和畫面邊緣保持純背景色，主體不要碰到邊緣，方便後期裁掉角落浮水印；' +
    '⑤ 畫面裡絕對不能出現浮水印、logo、文字、簽名、邊框、平台標識、時間戳。' +
    '不要改變使用者原意，不要編造與角色無關的內容。' +
    '只輸出改寫後的提示詞本身，不要解釋、不要分點。長度 100–180 字。',
  'prompt.optVideo':
    '你是遊戲動畫導演，專門為「首格=末格無縫循環 + 後續要去背」的 AI 影片寫提示詞。' +
    '把使用者的動作描述改寫成詳細提示詞，必須包含這些要素：' +
    '① 只描述主體動作、節奏和鏡頭，鏡頭固定不動；' +
    '② 明確強調首尾姿態完全一致、動作幅度適中、不要出現新物體、主體不要進出畫面；' +
    '③ 背景寫死成一種純色（明確說出顏色，和主體反差要大），' +
    '並要求整段影片背景完全不變、沒有漸層、沒有地面投影、沒有環境元素；' +
    '④ 主體輪廓乾淨清晰，不要毛髮級碎邊、不要半透明、不要煙霧火焰粒子光效；' +
    '⑤ 四角和畫面邊緣保持純背景色，主體不要碰到邊緣，方便後期裁掉角落浮水印；' +
    '⑥ 畫面裡絕對不能出現浮水印、logo、文字、簽名、邊框、平台標識、時間戳。' +
    '只輸出改寫後的提示詞本身，不要解釋、不要分點。長度 80–160 字。',
  'prompt.video.default':
    '角色輕微呼吸、衣襬與髮絲自然擺動，鏡頭固定，動作首尾銜接無縫循環',
  'prompt.video.bg':
    '【背景要求】嚴格保持原圖的純色背景不變：顏色、亮度、平整度都不得變化；禁止新增地面、道具、光斑、煙霧、陰影或漸層，禁止更換場景或改變畫面構圖。',
  'prompt.video.ref':
    '【參考要求】參考素材僅用於參考動作節奏與姿態變化；不要複製參考素材裡的角色外觀、服裝、配色或畫風，保持原圖美術風格不變。',
};

const en: Dict = {
  /* ---------- Common ---------- */
  'err.unknown': 'Unknown error',
  'err.badRequest': 'Malformed request',
  'err.notFound': 'Not found',
  'err.ioFailed': 'File read/write failed: {error}',

  /* ---------- UI settings (theme / language) ---------- */
  'err.ui.badTheme': 'Unknown theme mode',
  'err.ui.badLang': 'Unknown language',

  /* ---------- Model settings ---------- */
  'err.settings.badSlot': 'Unknown slot: {slot}',
  'err.settings.badProvider': 'Unknown provider: {provider}',
  'err.settings.slotNotFound': 'This slot has not been configured yet',
  'err.settings.readFailed': 'Could not read the settings: {error}',
  'err.settings.writeFailed': 'Could not write the settings: {error}',
  'err.settings.badJson': 'The settings file is not valid JSON: {error}',
  'err.settings.balanceNoKey': 'No API key saved yet — cannot query the balance',
  'err.settings.balanceUnsupported': 'This provider does not support balance queries',
  'err.settings.balanceFailed': 'Balance query failed: {error}',
  'err.settings.testFailed': 'Connection test failed: {error}',
  'err.settings.testNoUrl': 'No Base URL yet — cannot test',
  'err.settings.testNoModel': 'No model selected yet — cannot test',
  'err.settings.modelListFailed': 'Could not fetch the model list: {error}',
  'err.settings.modelListEmpty': 'The endpoint returned no models (some platforms do not expose /models)',
  'err.settings.saveFailed': 'Could not save the model settings: {error}',
  'err.settings.keyClearFailed': 'Could not delete the API key: {error}',
  'err.settings.noActiveSlot': 'No usable slot',

  /* ---------- Argument validation ---------- */
  'err.args.badSettings': 'Invalid settings payload',
  'err.args.badSlot': 'Unknown capability slot',
  'err.args.badProvider': 'Unknown model provider',
  'err.args.modelTooLong': 'Model name is too long',
  'err.args.badGenerate': 'Invalid generation payload',
  'err.args.promptEmpty': 'The prompt cannot be empty',
  'err.args.promptTooLong': 'The prompt is too long (4000 characters max)',
  'err.args.sizeTooLong': 'Size parameter is too long',
  'err.args.sameSlot': 'Source and target slots are the same',
  'err.args.badEnabled': 'Invalid enabled state',
  'err.args.badMessages': 'Invalid message format',
  'err.args.badPrompt': 'Invalid prompt',
  'err.args.badOptimizeKind': 'Invalid optimisation type',
  'err.args.baseUrlTooLong': 'Base URL is too long',
  'err.args.baseUrlScheme': 'Base URL must start with http:// or https://',
  'err.args.apiKeyNotString': 'API key must be a string',
  'err.args.apiKeyTooLong': 'API key is too long',

  /* ---------- AI service (model calls / balance / connection test) ---------- */
  'err.ai.noBaseUrl': 'No Base URL yet — add the endpoint in Model settings first',
  'err.ai.noKey': 'No API key yet — fill it in and save it in Model settings',
  'err.ai.badUrl': 'Base URL is not a valid address: {url}',
  'err.ai.hint401': ' (the API key is invalid or expired)',
  'err.ai.hint404': ' (the endpoint does not exist — check the Base URL)',
  'err.ai.http': 'HTTP {status} {statusText}{hint}{detail}',
  'err.ai.httpDetail': ': {detail}',
  'err.ai.connectFailed':
    'Could not connect to {url}: {reason} (check the network / proxy / VPN, or whether the Base URL is correct)',
  'err.ai.badJson': 'The endpoint {url} did not return valid JSON',
  'err.ai.testOk': 'Connected in {ms}ms — {count} models available',
  'err.ai.balanceNoInfo': 'The endpoint returned no balance information',
  'err.ai.balanceCredits': 'Total credits',
  'err.ai.balanceUsed': 'Used',
  'err.ai.balanceEmptyResponse': 'The balance endpoint returned an empty response',
  'err.ai.balanceUnsupportedProvider':
    '{provider} does not expose a balance endpoint — check the balance in the provider console',
  'err.ai.chatNoBaseUrl': 'The text slot has no Base URL configured',
  'err.ai.chatNoKey': 'The text slot has no API key yet',
  'err.ai.chatDisabled': 'The text slot is disabled',
  'err.ai.chatFailed': 'Text model call failed: {reason}',
  'err.ai.emptyReply': 'The text model returned nothing',
  'err.ai.emptyInput': 'Type something before sending',
  'err.ai.noColor': 'The model did not return a colour',
  'err.ai.colorFallbackReason': 'Chosen by analysing the subject colour with the text model',
  'err.ai.colorReasonSuffix': ' (AI analysis unavailable: {message})',
  'err.ai.emptyPrompt': 'Write a prompt before optimising',
  'err.ai.emptyOptimized': 'The model returned nothing',

  /* ---------- Other main-process strings shown in the UI ---------- */
  'app.name': 'Sprite Frame Editor',
  'err.settings.copyNoKey': 'The source slot has no key for this provider — fill it in there first',
  'app.usage.note':
    'Local estimate: asset-library entries + cached files, valued with built-in unit prices. It is not the provider invoice.',

  /* ---------- Video generation ---------- */
  'err.video.badImagePath': 'Invalid image path',
  'err.video.outsideData': 'Files outside the data folder are not allowed',
  'err.video.hintNotOpen':
    ' (this account has not activated the video model — open “Activation” in the Ark console and enable Seedance; note that 2.5 requires a balance of at least 200 CNY)',
  'err.video.hint401': ' (the API key is invalid or the model is not activated)',
  'err.video.hint403': ' (permission denied — check whether the video model is activated in the console)',
  'err.video.hint404': ' (the endpoint does not exist — check the Base URL)',
  'err.video.hint429': ' (rate limited — try again later)',
  'err.video.http': 'HTTP {status} {statusText}{hint}{detail}',
  'err.video.httpDetail': ': {detail}',
  'err.video.requestFailed':
    'Request to {url} failed: {reason} (check the network / proxy / VPN, or the Base URL)',
  'err.video.badJson': 'The endpoint {url} did not return valid JSON',
  'err.video.downloadFailed': 'Video download failed: {reason}',
  'err.video.downloadHttp': 'Video download failed: HTTP {status}',
  'err.video.noBaseUrl': 'The video slot has no Base URL configured',
  'err.video.noModel': 'The video slot has no model configured',
  'err.video.noKey': 'The video slot has no API key yet — save one in Model settings → Video generation',
  'err.video.emptyImage': 'The image is empty',
  'err.video.imageTooLarge': 'The image is too large (20MB max) — scale it down first',
  'err.video.needRef': 'Reference mode needs at least one reference image',
  'err.video.refTooLarge': 'A reference image is too large (20MB max)',
  'err.video.submitting': 'Submitting the generation task…',
  'err.video.noTaskId': 'The provider did not return a task id',
  'err.video.genFailed': 'Generation failed: {reason}',
  'err.video.noReason': 'the provider gave no reason',
  'err.video.cancelled': 'The task was cancelled',
  'err.video.expired': 'The task expired',
  'err.video.queued': 'Queued…',
  'err.video.generating': 'Generating…',
  'err.video.waiting': '{message} ({seconds}s elapsed)',
  'err.video.timeout':
    'Timed out after 20 minutes — the task may still be queued on the provider side; try again later',
  'err.video.downloading': 'Downloading the video…',
  'err.video.emptyDownload': 'The downloaded video is empty',
  'err.video.done': 'Generation finished and saved to the asset library',

  /* ---------- Local matting models ---------- */
  'model.birefnet.label': 'BiRefNet official · the model behind the website (fp32 973MB, most accurate)',
  'model.birefnet.hint':
    'birefnet.onnx ← https://hf-mirror.com/onnx-community/BiRefNet-ONNX/resolve/main/onnx/model.onnx',
  'model.u2net.label': 'U2Net · lightweight fallback (168MB, 320 input, very fast)',
  'model.u2net.hint':
    'u2net.onnx ← https://github.com/danielgatis/rembg/releases/download/v0.0.0/u2net.onnx (put it in data/models/, no renaming needed)',
  'model.lite.label': 'BiRefNet_lite-512 · fallback (182MB, 1.6s)',
  'model.lite.hint':
    'birefnet-lite-512.onnx ← https://hf-mirror.com/studioludens/birefnet-lite-512/resolve/main/onnx/model.onnx',
  'model.toonout.label': 'ToonOut · best on anime art (469MB, slow)',
  'model.toonout.hint':
    'birefnet-toonout.onnx ← https://hf-mirror.com/sprited/birefnet-toonout-onnx/resolve/main/birefnet-toonout-fp16.onnx',
  'model.anime.label': 'isnet-anime · tuned for anime (168MB, fast)',
  'model.anime.hint':
    'isnet-anime.onnx ← https://hf-mirror.com/skytnt/anime-seg/resolve/main/isnetis.onnx',
  'model.ben2.label': 'BEN2 · keeps the most of the subject (208MB, needs CPU fp16 support)',
  'model.ben2.hint':
    'ben2.onnx ← https://hf-mirror.com/onnx-community/BEN2-ONNX/resolve/main/onnx/model_fp16.onnx',
  'model.isnetGeneral.label': 'ISNet general-use · the high-quality rembg model (176MB)',
  'model.isnetGeneral.hint':
    'isnet-general-use.onnx ← https://github.com/danielgatis/rembg/releases/download/v0.0.0/isnet-general-use.onnx (put it in data/models/, no renaming needed)',
  'err.model.missing': 'Model {id} was not found. Put the weights in:\n{dir}\nDownload: {hint}',
  'err.model.decodeFailed': 'Could not decode the image',
  'err.model.bitmapIncomplete': 'Incomplete bitmap data',
  'err.model.emptyImage': 'The image is empty',
  'err.model.noOutput': 'The model produced no output',
  'err.model.emptyResult': 'The matte is empty',
  'err.model.noSubject':
    'The model found no subject (only {percent}% foreground), so the result would be a fully transparent image. Common causes: (1) the background is plain white or flat and this model is insensitive to it — try “isnet-anime” or “ToonOut”; (2) the image is already a cut-out PNG; (3) the subject is too small in frame.',

  /* ---------- Files / frame folders ---------- */
  'err.file.mattingDisabled': 'AI matting is disabled (re-enable it in shared/features.ts)',
  'err.file.badPath': 'Invalid file path',
  'err.file.emptyImagePath':
    'The image path is empty (pass a dataUrl for in-memory frame animation frames)',
  'err.file.noPyshim': 'pyshim/python.exe was not found (the project pyshim folder is missing)',
  'err.file.badFrameDir': 'Invalid frame folder',
  'err.file.badJobId': 'Invalid job id',
  'err.file.noFrames': 'No frame files in that folder',
  'err.file.colorPickFailed': 'Colour picking failed (the image is too small or cannot be decoded)',
  'err.file.needColor': 'At least one background colour is required',
  'err.file.badDirKind': 'Unknown folder type',
  'err.file.badFileName': 'Invalid file name',
  'err.file.badSaveArgs': 'Invalid save payload',
  'err.file.noSourcePath': 'The source image path is missing',
  'err.file.noImageData': 'The image data is missing',

  /* ---------- Frame sets / matte output folders ---------- */
  'err.frames.badData': 'Invalid frame data (a PNG dataURL is required)',
  'err.frames.empty': 'There are no frames to save',
  'err.frames.tooFew': 'At least 2 frames are needed for an animation (there is only 1)',
  'err.frames.nameExists': 'A folder named “{name}” already exists — pick another name',
  'err.frames.setMissing': 'Frame set “{id}” does not exist',
  'err.frames.emptyName': 'The name cannot be empty',
  'err.frames.noMeta': 'This set has no meta.json, so it cannot be renamed',
  'err.frames.nameExistsNoOverwrite':
    'A folder named “{name}” already exists; it will not be overwritten, so the rename failed',
  'err.frames.noFramesInSet': 'This set has no recognisable frames, so it cannot be renamed',
  'err.frames.outsideDir': 'Invalid project folder',
  'err.frames.notOutputDir':
    'Only matte output folders can be renamed (names ending in -matte / -key)',
  'err.frames.outputMissing': 'Matte output “{name}” does not exist',
  'err.frames.badFrameName': 'Invalid frame file name: {name}',
  'err.frames.badFramePath': 'Invalid frame path',

  /* ---------- Asset library ---------- */
  'err.kb.missing': 'The asset does not exist',
  'err.kb.emptyName': 'The file name cannot be empty',
  'err.kb.nameExists':
    'A file named “{name}” already exists; it will not be overwritten, so the rename failed',
  'err.kb.sourceGone': 'The original file is gone, so it cannot be renamed',
  'err.kb.badArgs': 'Invalid arguments',
  'err.kb.noId': 'Missing asset id',
  'err.kb.badNewName': 'Invalid new file name',
  'dialog.import.title': 'Import into the asset library (images / videos)',
  'dialog.import.media': 'Images and videos',
  'dialog.import.images': 'Images',
  'dialog.import.videos': 'Videos',
  'dialog.import.all': 'All files',

  /* ---------- Image generation ---------- */
  'err.image.hint401': ' (the API key is invalid or the model is not activated)',
  'err.image.hint403': ' (permission denied — check whether the model is activated in the console)',
  'err.image.hint404': ' (the endpoint does not exist — check the Base URL)',
  'err.image.hint429': ' (rate limited — try again later)',
  'err.image.http': 'HTTP {status} {statusText}{hint}{detail}',
  'err.image.httpDetail': ': {detail}',
  'err.image.callFailed': 'Call to {url} failed: {reason} (check the network / proxy / Base URL)',
  'err.image.badJson': 'The endpoint {url} did not return valid JSON',
  'err.image.noImageData': 'The provider returned an image with neither b64_json nor url',
  'err.image.downloadFailed': 'Could not download the result: {reason}',
  'err.image.downloadHttp': 'Could not download the result: HTTP {status}',
  'err.image.emptyPrompt': 'The prompt cannot be empty',
  'err.image.promptTooLong': 'The prompt is too long ({max} characters max)',
  'err.image.noBaseUrl': 'The image slot has no Base URL configured',
  'err.image.noModel': 'The image slot has no model configured',
  'err.image.noKey': 'The image slot has no API key yet — save one in Model settings → Image generation',
  'err.image.noImages': 'The endpoint returned no images',
  'err.image.genFailed': 'Generation failed: {reason}',
  'err.image.emptyResult':
    'The result is empty — the provider may have filtered it; try a different prompt',

  /* ---------- rembg local process ---------- */
  'err.rembg.ready': 'rembg is ready',
  'err.rembg.probeFailed': 'rembg probe failed (exit code {code})',
  'err.rembg.noPyshim':
    'pyshim/python.exe was not found. Put a portable Python under the project’s pyshim/ folder (or run npm run setup:rembg).',
  'err.rembg.badImageData': 'Malformed image data',
  'err.rembg.imageMissing': 'Image file does not exist: {path}',
  'err.rembg.spawnFailed': 'Could not start rembg: {error}',
  'err.rembg.exitCode': 'rembg exited with code {code}',
  'err.rembg.noOutput': 'rembg produced no output file',
  'err.rembg.noPyshimBatch': 'pyshim/python.exe was not found, so batch matting cannot run',
  'err.rembg.inputDirMissing': 'The input folder does not exist: {dir}',
  'err.rembg.memoryNote':
    'Only {free} GB of memory left — parallelism lowered from {requested} to {workers} to avoid a freeze',
  'err.rembg.unknownError': 'unknown error',
  'err.rembg.cancelled': 'Batch matting was stopped manually',
  'err.rembg.batchExitCode': 'rembg batch run exited with code {code}',

  /* ---------- Frame IPC / media files ---------- */
  'err.frames.badArgs': 'Invalid arguments',
  'err.frames.tooMany': 'At most 600 frames can be saved at once — extract fewer frames',
  'err.frames.badId': 'Invalid project id',
  'err.frames.badNewName': 'Invalid new name',
  'err.frames.badOutputName': 'Invalid output folder name',
  'err.frames.badFileName': 'Invalid frame file name',
  'err.file.outsideData': 'Files outside the data folder are not allowed',
  'err.file.missing': 'The file does not exist',
  'err.file.imageTooLarge30': 'The image is too large (30MB max)',
  'err.file.emptyEdit': 'The edit result is empty',
  'err.file.editTooLarge': 'The edit result is too large (30MB max)',
  'err.file.editedFrom': 'Edited from {name}',
  'err.file.assetMissing': 'The asset file does not exist',
  'err.video.badArgs': 'Invalid generation payload',
  'err.video.noImage': 'Pick an image first',
  'err.frames.dirMissing': 'The folder does not exist: {dir}',
  'err.frames.tooFewLoop': 'Too few frames (at least 3) to find a loop point',
  'err.frames.badFirstFrame': 'Frame 1 failed to decode',

  /* ---------- System prompts sent to the AI models (follow the UI language) ---------- */
  'prompt.assistant':
    'You are the built-in assistant of “Sprite Frame Editor”, serving artists and programmers who make 2D game sprite animations. ' +
    'The workflow is: image → looping video → 2D frame animation. ' +
    'Answer in English, concisely and actionably; when describing steps, say which page and which button to use. Never invent features this app does not have.',
  'prompt.bgColor': [
    'You are a game-art asset assistant that picks a “keying flat background” for AI image generation.',
    'Steps: 1) infer the dominant hue of the subject (character/object) from the description; 2) pick a highly saturated solid colour whose hue contrasts most with the subject.',
    'Hard requirements: the background must be a single flat colour with no gradient; do not pick white or black (edges get dirty); if the subject is greenish, do not pick a green screen.',
    'Output one line of JSON only, no explanation, in the form {"color":"#RRGGBB","reason":"reason in under 30 English words"}',
  ].join('\n'),
  'prompt.bgColor.user': 'Asset description: {text}',
  'prompt.optImage':
    'You are a game-art prompt engineer writing prompts for text-to-image jobs whose output will later be matted into frame-animation assets. ' +
    'Expand the user’s one-liner into a detailed prompt that must cover: ' +
    '(1) subject appearance, clothing material, pose, camera, lighting, art style, aspect ratio; ' +
    '(2) a background locked to one flat colour (state the colour explicitly, e.g. pure white, bright green #00FF00, deep blue), ' +
    'with no gradient, no texture, no ground shadow and no props or environment; ' +
    '(3) clean, sharp subject contours — no wispy hair edges, no translucency, no smoke or particle glow; ' +
    '(4) keep the corners and frame edges pure background colour, with the subject not touching the edges, so corner watermarks can be cropped later; ' +
    '(5) absolutely no watermark, logo, text, signature, border, platform mark or timestamp in the image. ' +
    'Do not change the user’s intent and do not invent content unrelated to the character. ' +
    'Output only the rewritten prompt, no explanation and no bullet points. Length: 60–120 words.',
  'prompt.optVideo':
    'You are a game animation director writing prompts for AI videos where the first and last frames match seamlessly and the result will later be matted. ' +
    'Rewrite the user’s motion description into a detailed prompt that must cover: ' +
    '(1) describe only the subject’s motion, rhythm and camera, with the camera locked off; ' +
    '(2) stress that the first and last poses are identical, the motion is moderate, no new objects appear and the subject never leaves the frame; ' +
    '(3) a background locked to one flat colour (state it explicitly, with strong contrast to the subject), ' +
    'unchanged for the whole clip, with no gradient, no ground shadow and no environment elements; ' +
    '(4) clean, sharp subject contours — no wispy hair edges, no translucency, no smoke, fire or particle glow; ' +
    '(5) keep the corners and frame edges pure background colour, with the subject not touching the edges, so corner watermarks can be cropped later; ' +
    '(6) absolutely no watermark, logo, text, signature, border, platform mark or timestamp in the image. ' +
    'Output only the rewritten prompt, no explanation and no bullet points. Length: 50–100 words.',
  'prompt.video.default':
    'The character breathes subtly, cloth and hair sway naturally, camera locked off, motion loops seamlessly from first frame to last',
  'prompt.video.bg':
    '[Background] Keep the original flat background exactly as-is: colour, brightness and evenness must not change. Do not add ground, props, light spots, smoke, shadows or gradients, and do not change the scene or the composition.',
  'prompt.video.ref':
    '[Reference] The reference images are only for motion rhythm and pose changes. Do not copy the reference character’s look, clothing, palette or art style — keep the original artwork’s style unchanged.',
};

const DICTS: Record<Lang, Dict> = { 'zh-CN': zhCN, 'zh-TW': zhTW, en };

/** 主进程侧的「当前界面语言」缓存：由 electron/core/ui.ts 同步过来 */
let currentLang: Lang = 'zh-CN';

export function setErrLang(lang: Lang): void {
  currentLang = lang;
}

/** 主进程侧取文案：缺 key 时回落简中，再不行把 key 原样返回 */
export function tErr(key: string, lang: Lang = currentLang, vars?: Record<string, string>): string {
  const text = DICTS[lang]?.[key] ?? zhCN[key] ?? key;
  if (!vars) return text;
  return text.replace(/\{(\w+)\}/g, (match, name: string) => vars[name] ?? match);
}
