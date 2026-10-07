/**
 * Host half of the Pomodoro clock bundle.
 *
 * The clock itself runs entirely in the browser entry (`./client`): the
 * countdown, its settings, its persistence, and the floating widget it mounts
 * into the frame-wide `shell.overlay` layer. This half exists so the Loader row
 * is addressable — the plugin is listed, enable/disable-able, and disposable
 * through the ordinary profile composition — without adding Host services the
 * feature does not need.
 */
export function apply() {}

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
 *   phase 当前休息阶段；round 本轮第几个番茄；done 今天已完成几个；
 *   now 调用方算好的本地时间短串（如 '15:20'）——本函数不取时间，保持纯、可测；
 *   angle 本次角度（未知取值回退 TIP_ANGLES[0]）；lang 界面语言。
 * @returns {{ system: string, user: string }} 只有 lang 为 'en' 时取英文模板，其余（含缺陷值）按中文。
 */
export function buildTipPrompt(input) {
  const { phase, round, done, now, angle, lang } = input
  // 未知角度（客户端版本更新、query 被手改）不能抛：退回第一个角度，最坏只是轮换少一档。
  const safeAngle = TIP_ANGLES.includes(angle) ? angle : TIP_ANGLES[0]
  const safeRound = Number.isFinite(round) ? round : 1
  const safeDone = Number.isFinite(done) ? done : 0

  if (lang === 'en') {
    const phaseText = phase === 'long' ? 'long break' : 'short break'
    return {
      system: TIP_SYSTEM_EN,
      user: `State: ${phaseText}, pomodoro ${safeRound} of this cycle, ${safeDone} finished today,`
        + ` current time ${now}.`
        + ` Angle for this tip: ${TIP_CLAUSE_EN[safeAngle]}. Write the tip in English.`,
    }
  }

  const phaseText = phase === 'long' ? '长休息' : '短休息'
  return {
    system: TIP_SYSTEM_ZH,
    user: `状态：${phaseText}，本轮第 ${safeRound} 个番茄，今天已完成 ${safeDone} 个，当前时间 ${now}。`
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

/** 单次生成的输出预算（token）。正文就一句话，60 足够，同时封住最坏成本。 */
const TIP_MAX_TOKENS = 60

/**
 * 生成一句休息提醒。
 *
 * 失败矩阵（七条路径全部返回 null，任何一条都不抛）：服务缺席、模型抛错、空响应、
 * 校验不过（太短/太长/客套长句）、终止原因非 stop、外部取消、内部超时。
 * @param {{ llm?: { stream(o: object): AsyncIterable<object> }, provider: string, model: string, signal?: AbortSignal }} deps
 *   llm 是宿主上下文里的 llm 服务（`ctx.get('llm')`），缺席即第一道降级；
 *   provider / model 由调用方按用户当前选择传入，本函数不硬编码；
 *   signal 是外部取消（路由在客户端断开时 abort 它）。
 * @param {{ phase: 'short'|'long', round: number, done: number, now: string, angle: string, lang: 'zh'|'en' }} input
 *   与 buildTipPrompt 同形的状态输入，lang 同时决定校验用哪套长度界。
 * @returns {Promise<string | null>} 清洗 + 校验通过的一句话，或 null。
 */
export async function resolveTip(deps, input) {
  const llm = deps?.llm
  // 第一道降级：服务缺席时连超时都不建，直接回退（早于任何 I/O）。
  if (llm === undefined || llm === null) return null

  try {
    // 外部 signal 与内部超时必须**合并**：只取外部会让慢响应挂住请求；只取内部会让用户
    // 切走后模型调用继续跑并计费。deps.signal 缺席时退化为只用自己的超时。
    // （放进 try 里：传进来的 signal 若不是真的 AbortSignal，AbortSignal.any 会抛错，
    //   这里同样按「回退默认句」处理，不外泄。）
    const signal = deps.signal
      ? AbortSignal.any([deps.signal, AbortSignal.timeout(TIP_TIMEOUT_MS)])
      : AbortSignal.timeout(TIP_TIMEOUT_MS)
    if (signal.aborted) return null

    const { system, user } = buildTipPrompt(input)
    let text = ''
    let finished = false

    // 不传 reasoningEffort（让适配器用自己的默认，本机默认档很高，写一句话不该抬推理），
    // 不传 purpose（该字段只接受 compaction / session-title，没有给插件留位置）。
    const stream = llm.stream({
      provider: deps.provider,
      model: deps.model,
      system,
      messages: [{ role: 'user', content: [{ type: 'text', text: user }] }],
      maxTokens: TIP_MAX_TOKENS,
      signal,
    })

    for await (const chunk of stream) {
      // 用户切走 / 超时：已攒的内容一律丢弃，这句话已经没人要了。
      if (signal.aborted) return null
      // 只认 text-delta：reasoning-delta 是模型的思考过程，绝不能进气泡。
      if (chunk?.type === 'text-delta') {
        // text 不是字符串说明流本身坏了，攒出来的句子不可信 —— 宁可回退（sanitizeTip 对
        // 非字符串会显式抛错，不能让它把异常泄到调用方）。
        if (typeof chunk.text !== 'string') return null
        text += chunk.text
        continue
      }
      // 终止块：只有干净收尾（stop）才采纳已攒正文。error / aborted / max-tokens /
      // tool-calls 都意味着内容失败或被截断，正文必须整个丢掉。
      if (chunk?.type === 'finish') {
        if (chunk.reason?.kind !== 'stop') return null
        finished = true
      }
    }

    // 一次调用没有终止块 = 流被截断（适配器约定每次调用都以 finish 收尾），不采纳。
    if (!finished) return null

    // 清洗负责救回引号/换行/客套，校验只回答「能不能进气泡」。清得干净不等于可用。
    const clean = sanitizeTip(text)
    return validateTip(clean, input.lang) ? clean : null
  } catch {
    // 任何异常（含 sanitizeTip 对非字符串的显式抛错、buildTipPrompt 收到坏 input）
    // 都不外泄：调用方只认 null。
    return null
  }
}
