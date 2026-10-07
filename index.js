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

// 英文的长度单位必须是「词」而不是「字符」：校验器（后续任务）按 3–12 词判，
// prompt 里若写 characters，按 prompt 生成的句子会被自己的校验器拒掉，英文路径永远回退默认句。
const TIP_SYSTEM_EN = 'You are a break-reminder assistant. '
  + 'At this moment, output only this one reminder sentence, with no explanation and no framing text. '
  + 'Keep it between 3 and 12 words, use no quotation marks, no emoji, no lecturing, '
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

/** 换行与制表符：一律直接删掉，不换成空格——中文句子被换行拆开时，换空格会多出一个空档。 */
const TIP_LINE_BREAK = /[\n\r\t\u2028\u2029]+/g

/** 英文换行补空格：仅当换行两侧都是 ASCII 词字符时，先把换行换成一个空格，再由 TIP_LINE_BREAK 删净。
 *  否则 `go grab\nsome water` 会粘成 `go grabsome water`，照样通过英文词数校验、把错字送进气泡。
 *  裁定的形式是 `(?<=[A-Za-z0-9_])\n(?=[A-Za-z0-9_])`；这里写成 `[\r\n]+`，把 CRLF 与连续空行当作
 *  同一个断口——判据没有变（两侧仍须是 ASCII 词字符），但 `go grab\r\nsome water`、
 *  `go grab\n\nsome water` 也不会再粘连。汉字不是 ASCII 词字符，所以 `水\n吧` 依旧变成 `水吧`。 */
const TIP_ASCII_LINE_BREAK = /(?<=[A-Za-z0-9_])[\r\n]+(?=[A-Za-z0-9_])/g

/** emoji：扩展象形字符，外加区域指示符（成对拼出国旗，单个不在象形范围内）。 */
const TIP_EMOJI = /[\p{Extended_Pictographic}\p{Regional_Indicator}]/u

/** 换行与制表符：清洗阶段已经删过，校验阶段再挡一次，防止调用方跳过清洗直接把原文递进来。
 *  制表符必须一起挡：它与换行同属 TIP_LINE_BREAK，漏掉它 `站\t起来走两步`（6 个汉字）会被判 true。 */
const TIP_NEWLINE_OR_TAB = /[\n\r\t\u2028\u2029]/

/** 汉字（CJK 统一表意文字）。中文字数只数它们：标点、空白、字母、数字都不计入。 */
const TIP_HAN = /[\u4e00-\u9fff]/

/** 气泡能装下的总码点上限，中英都叠这一条：只卡汉字数会漏掉「汉字 + 长英文尾巴」，
 *  实测 `站起来走两步 go walk around the block and back again` 有 46 个码点仍判 true，148px 装不下。
 *  30 让 prompt 合规的 25 码点样例照样通过，把 46 码点那种挡下。 */
const TIP_MAX_CODE_POINTS = 30

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
 * → 英文换行处补一个空格 → 删掉换行与制表符 → 再 trim。清得干净不等于可用，可用性由 validateTip 判。
 * @param {string} raw 模型拼出来的原文
 * @returns {string} 清洗后的文本（可能是空串）
 */
export function sanitizeTip(raw) {
  let text = stripWrappingQuotes(raw.trim())
  text = text.replace(TIP_POLITE_OPENER, '').trim()
  text = stripWrappingQuotes(text)
  text = text.replace(TIP_ASCII_LINE_BREAK, ' ')
  return text.replace(TIP_LINE_BREAK, '').trim()
}

/**
 * 校验一句话能不能进 148px 的气泡。
 * 长度界与 system 的约束一致（不一致会让生成即被自己拒掉、永远回退默认句）：
 *   - zh：6–24 个汉字，**标点与空白不计入**。prompt 要求「12 到 20 个汉字」，正落在界内；
 *     若把标点也算进 6–24，一句 20 汉字 + 5 标点（25 个字符）的好回答会被自己拒掉。
 *   - en：3–12 个词，按空白分词，与英文 system 的「3 and 12 words」一致。
 *   - 两种语言再叠一条总码点上限 30：汉字数或词数合规、但后面拖一条长尾巴的输出仍然装不下。
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
  if (TIP_NEWLINE_OR_TAB.test(trimmed)) return false
  // 码点数（不是 UTF-16 长度）：代理对只算一个，emoji 那种字符不会把上限翻倍。
  if ([...trimmed].length > TIP_MAX_CODE_POINTS) return false

  if (lang === 'en') {
    const words = trimmed.split(/\s+/).length
    return words >= 3 && words <= 12
  }
  const han = countHan(trimmed)
  return han >= 6 && han <= 24
}
