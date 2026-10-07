/**
 * 番茄钟插件的宿主半。
 *
 * 时钟本身完全跑在浏览器入口（`./client`）里：倒计时、它的设置、它的持久化，以及它挂进整帧
 * `shell.overlay` 层的悬浮控件。宿主半只负责休息气泡需要的那一块：`apply` 注册无状态的只读
 * 路由 `/pomodoro/tip`，客户端在休息开始时拉一次（`client.js` 里 BreakTip 那个 effect），
 * 拿到的句子替换气泡里的默认句。所有失败路径都回 204，气泡保留默认句。
 * **对外 204 与「插件坏了」完全同形**，所以失败时 handler 会往宿主日志写一行短码（见
 * logTipFailure）：既包括生成失败，也包括 handler 自己在 resolveTip 之外抛出的未预料异常。
 * 排查「AI 句一直不出现」先看那一行，别先怀疑路由没注册。
 *
 * 本模块**每个宿主进程只求值一次**（Node 的 ESM 按解析后的 URL 缓存模块）。DSH 的 HMR 在本
 * profile 里 `root: []`，即不监听模块文件；插件管理器的 disable/enable（以及 bundle 的开关）
 * 只是重新组合 loader entry，`Entry.init()` 的 import 命中缓存、不会重新求值本文件。所以改完
 * 宿主半**必须重启宿主进程**，否则跑的还是旧模块——症状很隐蔽：entry 是 `active`、没有任何报错，
 * 而 `/pomodoro/tip` 一直 404（旧版 host half 的 `apply` 是空函数）。这条不是推测：在插件的
 * disable→enable 之间往本文件加一条模块级副作用，副作用没有触发、路由依旧 404（见 Task 4 修复报告）。
 */
export function apply(ctx) {
  // 用 ctx.inject 等 webServer 到位，而不是在这里 ctx.get 一次：加载器把同一层的 entry **并发**激活
  // （cordis-plugin-loader 的 EntryGroup.update → Promise.all），而 ctx.get 默认 strict——只认
  // 「fiber 已激活」的服务。开机竞态里 get 拿到 undefined 的话，这条路由会**永久**不注册，
  // 从外面只能看到「AI 句永远不出现」，没有任何线索。inject 的语义正是「服务缺席就什么都不做」，
  // 与计划里的「webServer 缺席则整体不注册」一致，但不受激活顺序影响。
  ctx.inject(['webServer'], (child) => {
    // 注册挂在 effect 上：插件卸载 / 热重载时路由跟着一起撤掉。
    child.effect(() => child.webServer.register({
      kind: 'exact',
      path: '/pomodoro/tip',
      handler: (req, res) => handleTip(child, req, res),
    }), 'pomodoro: tip route')
  })
}

// ------------------------------------------------------------ 休息提醒：构句
//
// 纯逻辑（构句、清洗、校验）以具名导出放这里，路由与模型调用是薄适配层。
// 发给模型的只有状态数字与角度，不含任何对话内容、文件内容或工作区路径。

/** 提醒角度的轮换顺序。客户端切片里自留一份同样的列表（浏览器包无法 import 本文件），
 *  两边顺序必须一致；消费方对本表之外的取值一律回退到第一个角度。 */
export const TIP_ANGLES = ['water', 'distance', 'walk', 'stretch', 'breathe']

const TIP_SYSTEM_ZH = '你是休息提醒助手。'
  + '只输出一句提醒，字数严格控制在 12 到 20 个汉字之间，不加任何解释或前后缀。'
  + '不要用引号，不要用 emoji，不要说教，不要用「好的」「建议你」这类客套开头。'

// 英文的长度界有两条，prompt 必须把两条都说出来：词数 3–8（校验器按空白分词），以及整句 ≤ 60 字符
// （校验器按码点数）。只说词数是不够的——一句 7 词、63 码点的回答按词数完全合规，却被 60 码点上限拒掉，
// 英文路径永远回退默认句；这正是「prompt 说的范围必须落在校验器范围内」当初被写假的原因。
// 上界 8 而不是 12：12 个词约 60+ 码点，148px 的气泡装不下。
const TIP_SYSTEM_EN = 'You are a break-reminder assistant. '
  + 'At this moment, output only this one reminder sentence, with no explanation and no framing text. '
  + 'Keep it between 3 and 8 words, keep the whole reminder within 60 characters, '
  + 'use no quotation marks, no emoji, no lecturing, '
  + 'and no polite opener such as "Sure" or "I suggest".'

// 角度 → 子句：中英各一张表，键必须是 TIP_ANGLES 里的 id。
const TIP_CLAUSE_ZH = {
  water: '喝几口水，杯子见底就去接满',
  distance: '抬头看远处，把眼睛从近距离里松开',
  walk: '站起来走几步，让腿脚重新活络一下',
  stretch: '伸展肩颈和后背，把缩着的姿势打开',
  breathe: '慢慢深呼吸几次，让呼吸沉下来',
}

const TIP_CLAUSE_EN = {
  water: 'drink a few mouthfuls of water',
  distance: 'look far into the distance to rest your eyes',
  walk: 'stand up and walk a few steps',
  stretch: 'stretch your shoulders, neck and back',
  breathe: 'take a few slow deep breaths',
}

/**
 * 构造一次提醒句生成的 prompt。
 * @param {{ phase: 'short'|'long', round: number, done: number, now: string, angle: string, lang: 'zh'|'en' }} input
 *   phase 当前休息阶段；round 本轮第几个番茄；done 已完成几个（**累计**，只有「清除统计」才归零）；
 *   now 调用方算好的本地时间短串（如 '15:20'）——本函数不取时间，保持纯、可测；
 *   angle 本次角度（未知取值回退 TIP_ANGLES[0]）；lang 界面语言。
 * @returns {{ system: string, user: string }} 只有 lang 为 'en' 时取英文模板，其余（含缺陷值）按中文。
 */
export function buildTipPrompt(input) {
  const { phase, round, done, now, angle, lang } = input
  // 未知角度（客户端版本更新、query 被手改）不能抛：退回第一个角度，最坏只是轮换少一档。
  const safeAngle = TIP_ANGLES.includes(angle) ? angle : TIP_ANGLES[0]
  const safeRound = Number.isFinite(round) ? round : 1
  // done 是**累计**数（客户端发的 completedFocus 只在「清除统计」时归零），没有按天的维度。
  // 所以 prompt 只能写「累计」，不许写「今天」：跨天不清零时"今天已完成 12 个"是递给模型的
  // 假前提，它会顺着这个前提编。按天计数是另一个任务，这里不做，也不假装有。
  const safeDone = Number.isFinite(done) ? done : 0

  if (lang === 'en') {
    const phaseText = phase === 'long' ? 'long break' : 'short break'
    return {
      system: TIP_SYSTEM_EN,
      user: `State: ${phaseText}, pomodoro ${safeRound} of this cycle, ${safeDone} completed in total,`
        + ` current time ${now}.`
        + ` Angle for this tip: ${TIP_CLAUSE_EN[safeAngle]}. Write the tip in English.`,
    }
  }

  const phaseText = phase === 'long' ? '长休息' : '短休息'
  return {
    system: TIP_SYSTEM_ZH,
    user: `状态：${phaseText}，本轮第 ${safeRound} 个番茄，已完成 ${safeDone} 个（累计），当前时间 ${now}。`
      + `这句话的角度：${TIP_CLAUSE_ZH[safeAngle]}。用中文写这句话。`,
  }
}

// ------------------------------------------------------------ 清洗与校验
//
// 生成出来的句子先清洗、再校验，两步都是纯函数：清洗尽量把一句话救回来（包裹引号、换行、
// 客套前缀），校验只回答「能不能进气泡」。校验的长度界必须与上面 system 里写的界一致：
// 不一致的后果是「按 prompt 生成的句子被自己的校验器拒掉」，路径永远回退默认句，而且在
// 任何地方都看不出原因——Task 1 的英文长度单位就在这上面栽过一次，改这里时连着 system 一起看。
// 长度界不止一条（词数/汉字数 + 码点上限），**每一条都要写进 prompt**：宽度兜底那条不说出来，
// 按 prompt 生成的长句照样会被它拒（英文 7 词 63 码点就是这么暴露的），不变量就成了假的。

/** 成对包裹的引号：中文直角引号、弯引号与英文直引号。键是开引号，值是配对的闭引号。 */
const TIP_QUOTE_PAIRS = [
  ['「', '」'],
  ['『', '』'],
  ['“', '”'],
  ['‘', '’'],
  ['"', '"'],
  ["'", "'"],
]

/** 开头的客套话术。**必须跟着标点**才算数，可连续出现多次。
 *  分隔符里不能含空白：只跟空格的话，`Sure thing, stretch your legs` 会被削成
 *  `thing, stretch your legs`——正文缺了主语，而校验器完全看不出这种损坏。 */
const TIP_POLITE_OPENER = /^(?:(?:好的|好呀|好嘞|没问题|当然|可以|明白|收到|OK|Okay|Sure|Alright|Of course)[,，、:：!！.。]+)+/iu

/** 断口字符：换行、回车、制表符、U+2028 行分隔符、U+2029 段分隔符。清洗阶段一律直接删掉，
 *  不换成空格——中文句子被换行拆开时，换空格会多出一个空档。校验阶段由 TIP_ANY_BREAK 挡同一集合。 */
const TIP_BREAK_CHARS = /[\n\r\t\u2028\u2029]+/g

/** 断口两侧都是 ASCII 词字符时，先把整个断口换成一个空格，再由 TIP_BREAK_CHARS 删净。
 *  漏掉任何一类断口都会粘词：`go grab\tsome water` 会粘成 `go grabsome water`（3 个词，照样通过
 *  英文词数校验、把错字送进气泡），`\r\n`、U+2028、U+2029 同理。所以这里的字符类必须与
 *  TIP_BREAK_CHARS 同集合（上一轮裁定给的形式只点了 `\n`；`+` 顺带把 CRLF 与连续空行算作同一个断口）。
 *  汉字不是 ASCII 词字符，所以 `水\n吧`、`水\t吧` 依旧变成 `水吧`。 */
const TIP_ASCII_BREAK_JOIN = /(?<=[A-Za-z0-9_])[\r\n\t\u2028\u2029]+(?=[A-Za-z0-9_])/g

/** emoji：扩展象形字符，外加区域指示符（成对拼出国旗，单个不在象形范围内）。 */
const TIP_EMOJI = /[\p{Extended_Pictographic}\p{Regional_Indicator}]/u

/** 断口字符（与 TIP_BREAK_CHARS 同集合，只少一个 `+` 与 `g`）：清洗阶段已经删过，校验阶段再挡一次，
 *  防止调用方跳过清洗直接把原文递进来。五类都要挡：漏掉制表符，`站\t起来走两步`（6 个汉字）会判 true；
 *  漏掉 U+2028 / U+2029，`站\u2028起来走两步` 同理。 */
const TIP_ANY_BREAK = /[\n\r\t\u2028\u2029]/

/** 汉字（CJK 统一表意文字）。中文字数只数它们：标点、空白、字母、数字都不计入。 */
const TIP_HAN = /[\u4e00-\u9fff]/

/** 气泡能装下的总码点上限，**按语言宽度分别定**：汉字约为拉丁字符两倍宽，同一个气泡宽度
 *  对应 zh ≤ 30 码点 / en ≤ 60 码点。中英共用一条 30 是错的——12 个词的英文句约 60+ 码点，
 *  会被自己的上限拒掉，英文路径永远回退默认句（与 Task 1 的长度单位栽的是同一个坑）。
 *  中文这条堵住「汉字数合规 + 长英文尾巴」：实测 `站起来走两步 go walk around the block and back again`
 *  有 46 个码点仍判 true，148px 装不下；30 又让 prompt 合规的 25 码点样例照样通过。 */
const TIP_MAX_CODE_POINTS_ZH = 30

/** 英文上限：8 个常见长度的词约 40–50 码点，60 留出余量，同时仍能挡下塞满长词的长句。 */
const TIP_MAX_CODE_POINTS_EN = 60

/** 脱掉最外层成对的引号，可嵌套（「"…"」）。落单的引号不猜着删。 */
function stripWrappingQuotes(text) {
  let out = text
  for (;;) {
    const pair = TIP_QUOTE_PAIRS.find(([open, close]) => out.length > 1 && out.startsWith(open) && out.endsWith(close))
    if (!pair) return out
    out = out.slice(pair[0].length, out.length - pair[1].length).trim()
  }
}

/** 数汉字个数：按码点遍历，代理对不会被拆成两半。 */
function countHan(text) {
  let count = 0
  for (const ch of text) if (TIP_HAN.test(ch)) count += 1
  return count
}

/**
 * 清洗模型返回的一句话。
 * 顺序：首尾空白 → 脱包裹引号 → 削开头客套 → 再脱一次引号（客套削掉后才露出来的那些）
 * → 英文词间的断口处补一个空格 → 删掉其余断口字符 → 再 trim。清得干净不等于可用，可用性由 validateTip 判。
 * @param {string} raw 模型拼出来的原文
 * @returns {string} 清洗后的文本（可能是空串）
 */
export function sanitizeTip(raw) {
  let text = stripWrappingQuotes(raw.trim())
  text = text.replace(TIP_POLITE_OPENER, '').trim()
  text = stripWrappingQuotes(text)
  text = text.replace(TIP_ASCII_BREAK_JOIN, ' ')
  return text.replace(TIP_BREAK_CHARS, '').trim()
}

/**
 * 校验一句话能不能进 148px 的气泡。
 * 长度界与 system 的约束一致（不一致会让生成即被自己拒掉、永远回退默认句）：
 *   - zh：6–24 个汉字，**标点与空白不计入**，再叠 ≤ 30 码点。prompt 要求「12 到 20 个汉字」，
 *     正落在界内；若把标点也算进 6–24，一句 20 汉字 + 5 标点（25 个字符）的好回答会被自己拒掉。
 *   - en：3–8 个词，按空白分词，再叠 ≤ 60 码点。两条界都写进了英文 system
 *     （「3 and 8 words」与「within 60 characters」），所以按 prompt 生成的句子不会落在界外；
 *     只说词数时，一句 7 词、63 码点的回答按 prompt 合规却被上限拒——不变量就成了假的。
 *   - 码点上限按语言宽度分别定：汉字约为拉丁字符两倍宽，同一个气泡宽度对应 zh 30 / en 60。
 *     中英共用一条 30 会把 7–8 词的合规英文句拒掉（12 个 'walk' 就是 59 码点），
 *     英文路径因此永远回退默认句——正是本文件开头警告的那类故障。
 * lang 只认 'en'，其余取值（含缺陷值）一律按中文校验，与 buildTipPrompt 的取值约定相同。
 * @param {string} text 待校验文本（通常是 sanitizeTip 的结果）
 * @param {'zh'|'en'} lang 界面语言
 * @returns {boolean} true 表示可以进气泡
 */
export function validateTip(text, lang) {
  // 判定器对任何输入都给出布尔答案；sanitizeTip 相反——它的入参是必填字符串，
  // 调用方传错就让它显式抛错，而不是被静默吞成一句空话（与 buildTipPrompt 不做静默兜底一致）。
  if (typeof text !== 'string') return false
  const trimmed = text.trim()
  if (trimmed === '') return false
  if (TIP_EMOJI.test(trimmed)) return false
  if (TIP_ANY_BREAK.test(trimmed)) return false
  // 码点数（不是 UTF-16 长度）：代理对只算一个，emoji 那种字符不会把上限翻倍。
  // 上限按语言宽度分，所以放在语言分支里判。
  if (lang === 'en') {
    if ([...trimmed].length > TIP_MAX_CODE_POINTS_EN) return false
    const words = trimmed.split(/\s+/).length
    return words >= 3 && words <= 8
  }
  if ([...trimmed].length > TIP_MAX_CODE_POINTS_ZH) return false
  const han = countHan(trimmed)
  return han >= 6 && han <= 24
}

// ------------------------------------------------------------ 生成编排
//
// resolveTip 是纯逻辑与真实模型调用之间唯一的接缝：llm 服务从参数注入，所以这一层能在
// 不碰网络的前提下把失败矩阵全部走一遍（见 test/tip.test.mjs 的「生成编排」一组）。
// 它的契约只有一条：**要么返回一句能进气泡的话，要么返回 null**——绝不抛，绝不返回半句话。
// 调用方把 null 映射成 204，气泡保留默认句。

/** 单次生成的内部超时（毫秒）。慢响应宁可回退默认句，也不让 HTTP 请求挂着。 */
const TIP_TIMEOUT_MS = 3000

/** 单次生成的输出预算（token）。正文就一句话，60 足够，同时封住最坏成本。
 *  **这个预算只在模型不把 token 花在思考上时才成立**——见下面的 TIP_REASONING_EFFORT。 */
const TIP_MAX_TOKENS = 60

/** 生成时关掉推理（适配器侧就是 thinking: disabled）。
 *
 *  不传这个字段**不等于**「不抬推理」：不传就是走适配器默认，而本机默认档是 high。实机抓到的
 *  原始 chunk（deepseek-account / deepseek-flash）：模型先吐满整整 60 个 token 的 reasoning-delta
 *  ——把 maxTokens 全部吃掉，内容还是把 system 复述了一遍——随后以 finish{kind:'max-tokens'}
 *  收尾，**一个 text-delta 都没有**；请求 1.2s 返回 204，从外面看和「插件坏了」完全同形。
 *  60 token 的预算与 high 档的推理是互斥的，而写一句 12–20 字的提醒不需要推理：
 *  llm-deepseek 给 session-title 这类单行生成用的也是 off。
 *
 *  万一当前默认模型不认这个档：llm 服务的能力校验跑在**派发之前**，会以终止性
 *  finish{kind:'error'} + failure.code = UNSUPPORTED_REASONING_EFFORT 结束，不发真实请求；
 *  resolveTip 据此去掉该字段重试一次（见那里），别让「换了个不支持推理的默认模型」变成永久 204。 */
const TIP_REASONING_EFFORT = 'off'

/**
 * 把「为什么回退默认句」这一个短码交给调用方的日志钩子。纯逻辑不依赖它：钩子缺席、抛错都无影响。
 * 只传短码与数字，**不传模型正文**——生成内容不进宿主日志。
 * @param {object} deps resolveTip 的依赖对象
 * @param {string} reason 短码，如 'timeout' / 'error:ACCOUNT_SIGN_IN_REQUIRED'
 */
function reportTipFailure(deps, reason) {
  try {
    deps?.onFailure?.(reason)
  } catch {
    // 日志钩子自己坏了不影响生成本身的结论
  }
}

/**
 * 跑一次生成尝试：建流并消费到终止块（或流结束），返回这次尝试的结局。**不抛。**
 * 与 llm 服务的协议：每次调用都以一个终止 `finish` 块收尾；`llm.stream()` 与流的迭代都可能抛错，
 * 两条都收敛成「失败」，异常不外泄。
 * @param {{ stream(o: object): AsyncIterable<object> }} llm llm 服务
 * @param {object} request 请求体（provider/model/system/messages/reasoningEffort/maxTokens/signal）
 * @param {AbortSignal | undefined} clientSignal 调用方的 signal（路由在客户端断开时 abort 它）
 * @param {AbortSignal} signal 合并后的 signal（外部取消 + 内部超时），判断取消原因用
 * @returns {Promise<{ text: string, stopped: boolean, errorCode?: string, reason: string }>}
 *   stopped 只表示「以 finish{kind:'stop'} 干净收尾」，text 才可采纳；
 *   errorCode 只在适配器以终止性 finish{kind:'error'} 失败时出现（调用方据此决定要不要重试）；
 *   reason 是给宿主日志的短码，同时也是这条路径的失败分类。
 */
async function runTipAttempt(llm, request, clientSignal, signal) {
  let stream
  try {
    stream = llm.stream(request)
  } catch {
    // 适配器在派发前同步抛错
    return { text: '', stopped: false, reason: 'stream-threw' }
  }

  let text = ''
  let stopped = false
  try {
    for await (const chunk of stream) {
      // 用户切走 / 超时：已攒的内容一律丢弃，这句话已经没人要了。
      // 两者共用同一个合并 signal，靠 clientSignal 区分是哪一种（写进日志的原因不同）。
      if (signal.aborted) {
        return { text: '', stopped: false, reason: clientSignal?.aborted ? 'client-abort' : 'timeout' }
      }
      // 只认 text-delta：reasoning-delta 是模型的思考过程，绝不能进气泡。
      if (chunk?.type === 'text-delta') {
        // text 不是字符串说明流本身坏了，攒出来的句子不可信 —— 宁可回退（sanitizeTip 对
        // 非字符串会显式抛错，不能让它把异常泄到调用方）。
        if (typeof chunk.text !== 'string') return { text: '', stopped: false, reason: 'bad-delta' }
        text += chunk.text
        continue
      }
      // 终止块：只有干净收尾（stop）才采纳已攒正文。error / aborted / max-tokens /
      // tool-calls 都意味着内容失败或被截断，正文必须整个丢掉。
      if (chunk?.type === 'finish') {
        const kind = chunk.reason?.kind
        if (kind === 'stop') {
          stopped = true
          // 与旧行为一致：终止块之后继续把流读完，最后再看 stopped。
          continue
        }
        // 适配器的失败码（dsh-llm 的 adapterFailureChunk 一定带 failure.code）。
        const code = typeof chunk.reason?.failure?.code === 'string' ? chunk.reason.failure.code : undefined
        return {
          text,
          stopped: false,
          ...kind === 'error' ? { errorCode: code ?? 'error' } : {},
          reason: code === undefined ? `finish:${kind ?? 'none'}` : `${String(kind)}:${code}`,
        }
      }
    }
  } catch {
    // 迭代中抛错（网络断等）：异常不外泄
    return { text: '', stopped: false, reason: 'iteration-threw' }
  }

  // 一次调用没有终止块 = 流被截断（适配器约定每次调用都以 finish 收尾），不采纳。
  if (!stopped) return { text, stopped: false, reason: 'no-finish' }
  return { text, stopped: true, reason: 'stop' }
}

/**
 * 生成一句休息提醒。
 *
 * 失败矩阵（全部返回 null，任何一条都不抛）：服务缺席、模型抛错、空响应、校验不过
 * （太短/太长/客套长句）、终止原因非 stop、外部取消、内部超时。
 * 「适配器以 error 收尾」这一条会去掉 reasoningEffort 再试一次（见下），两次都失败仍返回 null。
 * @param {{ llm?: { stream(o: object): AsyncIterable<object> }, provider: string, model: string, signal?: AbortSignal, onFailure?: (reason: string) => void }} deps
 *   llm 是宿主上下文里的 llm 服务（`ctx.get('llm')`），缺席即第一道降级；
 *   provider / model 由调用方按用户当前选择传入，本函数不硬编码；
 *   signal 是外部取消（路由在客户端断开时 abort 它）；
 *   onFailure 可选：回退默认句时回调一个短码，宿主路由拿它写日志（HTTP 上 204 与「插件坏了」同形）。
 * @param {{ phase: 'short'|'long', round: number, done: number, now: string, angle: string, lang: 'zh'|'en' }} input
 *   与 buildTipPrompt 同形的状态输入，lang 同时决定校验用哪套长度界。
 * @returns {Promise<string | null>} 清洗 + 校验通过的一句话，或 null。
 */
export async function resolveTip(deps, input) {
  const llm = deps?.llm
  // 第一道降级：服务缺席时连超时都不建，直接回退（早于任何 I/O）。
  if (llm === undefined || llm === null) {
    reportTipFailure(deps, 'no-llm')
    return null
  }

  try {
    // 外部 signal 与内部超时必须**合并**：只取外部会让慢响应挂住请求；只取内部会让用户
    // 切走后模型调用继续跑并计费。deps.signal 缺席时退化为只用自己的超时。
    // （放进 try 里：传进来的 signal 若不是真的 AbortSignal，AbortSignal.any 会抛错，
    //   这里同样按「回退默认句」处理，不外泄。）
    // 两次尝试共用这一个 signal：3 秒的内部期限覆盖**整次生成**，重试不会把它翻倍。
    const signal = deps.signal
      ? AbortSignal.any([deps.signal, AbortSignal.timeout(TIP_TIMEOUT_MS)])
      : AbortSignal.timeout(TIP_TIMEOUT_MS)
    if (signal.aborted) {
      reportTipFailure(deps, deps.signal?.aborted ? 'client-abort' : 'timeout')
      return null
    }

    const { system, user } = buildTipPrompt(input)
    // 不传 purpose（该字段只接受 compaction / session-title，没有给插件留位置）。
    const requestWith = (reasoningEffort) => ({
      provider: deps.provider,
      model: deps.model,
      system,
      messages: [{ role: 'user', content: [{ type: 'text', text: user }] }],
      ...reasoningEffort === undefined ? {} : { reasoningEffort },
      maxTokens: TIP_MAX_TOKENS,
      signal,
    })

    let attempt = await runTipAttempt(llm, requestWith(TIP_REASONING_EFFORT), deps.signal, signal)

    // 第一次以终止性 error 失败时，去掉 reasoningEffort 再试一次：这个字段是**我们**加的，
    // 而 provider 不认它（能力校验失败，没发真实请求）会让整条路径永久 204。重试只是换一份
    // 请求体，**采纳标准一点没松**——第二次同样必须拿到 finish{kind:'stop'} 才返回正文。
    // 三种情况不重试：已经拿到干净收尾、signal 已 abort（重试必然也失败）、失败不是 error
    // （max-tokens / 没有终止块等，去掉字段只会让推理回来、更糟）。
    if (attempt.errorCode !== undefined && !signal.aborted) {
      attempt = await runTipAttempt(llm, requestWith(undefined), deps.signal, signal)
    }

    if (!attempt.stopped) {
      reportTipFailure(deps, attempt.reason)
      return null
    }

    // 清洗负责救回引号/换行/客套，校验只回答「能不能进气泡」。清得干净不等于可用。
    const clean = sanitizeTip(attempt.text)
    if (!validateTip(clean, input.lang)) {
      // 带上码点数与汉字数：长度界的两个方向（太短 / 太长）一眼可辨（界是 6–24 汉字且 ≤30 码点）
      reportTipFailure(deps, `rejected:${[...clean].length}cp/${countHan(clean)}han`)
      return null
    }
    return clean
  } catch {
    // 任何异常（含 sanitizeTip 对非字符串的显式抛错、buildTipPrompt 收到坏 input）
    // 都不外泄：调用方只认 null。
    reportTipFailure(deps, 'threw')
    return null
  }
}

// ------------------------------------------------------------ 宿主路由（HTTP 适配层）
//
// 这是纯逻辑与 HTTP 之间唯一的接缝：解析 query → resolveTip → 状态码映射。失败矩阵全部
// 收敛到 204 空体（客户端保持默认句，气泡永不变空、永不报错）。
//
// 访问控制（已对着 dsh-host-webserver / dsh-host-frontend-static 的源码确认）：这条路由**不经过**
// DSH 的浏览器鉴权。webServer 的 handle() 先查具名路由表，命中就直接调 handler；只有未命中的请求
// 才落到 fallback。`GET /` 那个 401 正是 fallback（frontend-static）在渲染 index 之前调
// connection.authorizeIndex 发出的，非 index 的静态资源本来就是公开的（实测 `/nope.js` 是 404 不是 401）。
// 所以 isSameOrigin 是这条路由**唯一的**访问控制，不是第二层，不能因为「反正外面有 401」而放松。
// （connection 另有 requestRejection：Host 白名单 + 浏览器鉴权，可复用到别的 Web 路由；本任务按计划
// 不引入该依赖——它的失败出口是 401/403，而本路由的契约是失败一律 204。）

/**
 * 同源检查。
 *
 * Origin 缺席（或空串）放行：同源的 GET 一般不带 Origin——浏览器只在跨站请求与非 GET/HEAD
 * 上带它，把它当跨站会把正常请求全部误杀。跨站的 fetch 一定会带 Origin，所以这条仍拦得住跨站。
 *
 * 解析不出 host 的 Origin（含沙箱 iframe 与 file:// 页面发出的字符串 "null"）一律按跨站处理：
 * 这条路由没有别的访问控制，宁可拒。非浏览器客户端（curl、本机进程）不带 Origin，会放行——
 * 它们本来也不需要 cookie（具名路由先于 fallback 分发，见本节开头）。
 * @param {string | undefined} origin 请求头 Origin 原文
 * @param {string | undefined} host 请求头 Host 原文（含端口）
 * @returns {boolean} true 表示继续处理
 */
export function isSameOrigin(origin, host) {
  if (origin === undefined || origin === '') return true
  let originHost
  try {
    originHost = new URL(origin).host
  } catch {
    return false
  }
  // host 由 URL 解析器归一（大小写、默认端口不写出来），与浏览器发出的 Host 写法一致。
  return originHost !== '' && originHost === host
}

/** 204 空体：所有失败路径的唯一出口。同样 no-store——状态码本身也不该被缓存。 */
function noContent(res) {
  res.writeHead(204, { 'cache-control': 'no-store' })
  res.end()
}

/**
 * 把「为什么这次没有 AI 句」写成一行宿主日志。
 *
 * 这条路由对外只有两种可见结果：200 带正文，或 204 空体。**生成失败与插件坏掉在 HTTP 上完全同形**
 * （都是 204），所以失败必须留一行痕，否则「AI 句一直不出现」无从查起。
 * 只记短码，不记模型正文（日志不落用户内容）；两条触发路径：
 *   - 输入合法、但句子没生成出来（resolveTip 的每条失败出口，短码见各调用点）；
 *   - handler 里任何未预料的异常（短码 `handler-threw`；成因必是内部故障，见 handleTip 的 catch）。
 * 跨站 Origin 与非法 query 是客户端自己的问题，不记。
 *
 * 两个出口都写，因为**它们各自都可能是空的**（2026-10-07 实机分别验过）：
 *   - `ctx.logger.warn`：DSH 自己的约定（dsh-host-webserver 的 handler 出错时也这么记）。
 *     实机确认该服务存在、`warn` 是可调用的函数、调用成功——但 **web profile 里没有任何
 *     exporter**（cordis 的 Logger 只把消息发给注册过的 exporter），所以消息哪儿都不出现。
 *   - `console.warn`：同一次实验里它直接出现在宿主进程的输出里，所以它是本 profile 唯一
 *     有落点的通道；宿主（含桌面端）把它接到哪里由启动方式决定。
 * 两个都写 → 「回退有痕」这件事不依赖 profile 的日志配置。各自独立 try，任一坏掉都不影响响应。
 * @param {object} ctx 插件上下文
 * @param {string} reason 短码
 */
function logTipFailure(ctx, reason) {
  const message = `pomodoro: 休息提醒生成失败，本次回退默认句（${reason}）`
  try {
    ctx?.logger?.warn?.(message)
  } catch {
    // 日志失败不影响响应
  }
  try {
    console.warn(message)
  } catch {
    // 同上
  }
}

/** 本地时间的 HH:MM（补零）。时间由 handler 取，buildTipPrompt 保持纯函数、可测。 */
function localHhMm() {
  const at = new Date()
  return `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`
}

/**
 * query 里的计数（round / done）。
 * Number(null) 与 Number('') 都是 0：缺席或空串如果直接放过去，prompt 会拿到「本轮第 0 个
 * 番茄」，比 buildTipPrompt 的兜底（1 / 0）更糟，而且同样从外面看不出错。所以非数字串、
 * 空串、缺席一律返回 undefined，由调用方映射成 204。
 * @param {string | null} raw searchParams.get 的原文
 * @returns {number | undefined} 能安全使用的数字，或 undefined
 */
function parseCount(raw) {
  if (raw === null || raw.trim() === '') return undefined
  const value = Number(raw)
  return Number.isFinite(value) ? value : undefined
}

/**
 * 路由 handler。webServer 把 node:http 的 req/res 原样交给具名路由的 handler（WebServer.init 里
 * `route.handler(req, res)` 拿到的就是 createServer 回调的那一对），所以这里按 Node 语义写；
 * inspect 把第二参数解析成 DSH 自己的 ServerResponse 是类型名撞车。
 * @param {object} ctx 插件上下文；`llm` 每次请求现取（注册时取一次会被开机竞态永久钉死，见 apply）
 * @param {import('node:http').IncomingMessage} req 请求
 * @param {import('node:http').ServerResponse} res 响应
 * @returns {Promise<void>} 响应在函数返回前发完
 */
async function handleTip(ctx, req, res) {
  try {
    // 1. 同源：跨站一律 204，连 query 都不解析，更不碰模型。
    if (!isSameOrigin(req.headers.origin, req.headers.host)) {
      noContent(res)
      return
    }

    // 2. query：round / done 到这里是字符串，必须在进 resolveTip 前转成数字并验明有限；
    //    phase / angle / lang 原样传下去，取值合法性由 buildTipPrompt 兜底（未知角度回退第一档）。
    const params = new URL(req.url ?? '/', 'http://dsh.invalid').searchParams
    const round = parseCount(params.get('round'))
    const done = parseCount(params.get('done'))
    if (round === undefined || done === undefined) {
      noContent(res)
      return
    }

    // 3. 服务与模型选择：任一缺席都当 llm 缺席处理（第一道降级，早于任何超时与 I/O）。
    //    llm 每次请求现取：注册时取一次会让开机竞态里的 undefined 变成永久降级（见 apply）。
    const llm = ctx.get('llm')
    const selection = ctx.get('agentDefaultModel')?.currentSelection()
    if (llm === undefined || llm === null || selection === undefined || selection === null) {
      // 这一条是实机最可能的静默失败（profile 没配默认模型时，每次休息都静默回退默认句），
      // 所以在服务这一层就记一行，别等到 204 出去以后无从查起。
      logTipFailure(ctx, `no-service:${llm === undefined || llm === null ? 'llm' : 'agentDefaultModel'}`)
      noContent(res)
      return
    }

    // 4. 客户端断开（切走 / 关页面）→ abort 进行中的生成，别让它在后台跑完并计费。
    //    Node 24 实测：正常请求的 req 'close' 要等响应发完才触发（那时 abort 一个已返回的调用无害），
    //    客户端中途断开则立刻触发；两种情况下对已 destroy 的 res 写 204 都不会抛错。
    const controller = new AbortController()
    req.on('close', () => controller.abort())

    const text = await resolveTip(
      {
        llm,
        provider: selection.provider,
        model: selection.model,
        signal: controller.signal,
        // 失败原因写进宿主日志：没有它，204 与「插件坏了」无法区分（见 logTipFailure）。
        onFailure: (reason) => logTipFailure(ctx, reason),
      },
      {
        phase: params.get('phase'),
        round,
        done,
        now: localHhMm(),
        angle: params.get('angle'),
        lang: params.get('lang'),
      },
    )

    // 5. null 是 resolveTip 唯一的失败出口（服务缺席 / 超时 / 取消 / finish 非 stop / 校验不过）。
    if (text === null) {
      noContent(res)
      return
    }

    res.writeHead(200, { 'cache-control': 'no-store', 'content-type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify({ text }))
  } catch {
    // 任何未预料的异常（ctx.get / currentSelection() 抛错、将来在 writeHead 之前引入的回归）
    // 都不许泄成 500：还没发响应就按失败路径回 204。**并且必须先留一行痕再回**——204 与
    // 「插件坏了 / 路由没注册」在 HTTP 上完全同形，不记的话文件头那句排查指引会把人引向错结论
    // （去查路由表，而不是查这份 handler），这正是本修复轮要消灭的失败类。
    // 这条也不会被客户端输入触发：webServer 分发前已经用同一句
    // `new URL(req.url ?? '/', 'http://x').pathname` 解析过请求目标（见 dsh-host-webserver 的
    // handle()），能命中本路由的目标一定解析得开，所以走到这里的只可能是内部故障。
    // logTipFailure 的两个出口各自有 try（见其注释），所以这一行既不会抛、也不参与状态决定。
    logTipFailure(ctx, 'handler-threw')
    if (!res.headersSent) noContent(res)
  }
}
