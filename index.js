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

const TIP_SYSTEM_EN = 'You are a break-reminder assistant. '
  + 'At this moment, output only this one reminder sentence, with no explanation and no framing text. '
  + 'Keep it between 12 and 20 characters, use no quotation marks, no emoji, no lecturing, '
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
 * @param {{ phase: 'short'|'long', round: number, done: number, angle: string, lang: 'zh'|'en' }} input
 *   phase 当前休息阶段；round 本轮第几个番茄；done 今天已完成几个；
 *   angle 本次角度（未知取值回退 TIP_ANGLES[0]）；lang 界面语言。
 * @returns {{ system: string, user: string }} 只有 lang 为 'en' 时取英文模板，其余（含缺陷值）按中文。
 */
export function buildTipPrompt(input) {
  const { phase, round, done, angle, lang } = input
  // 未知角度（客户端版本更新、query 被手改）不能抛：退回第一个角度，最坏只是轮换少一档。
  const safeAngle = TIP_ANGLES.includes(angle) ? angle : TIP_ANGLES[0]
  const safeRound = Number.isFinite(round) ? round : 1
  const safeDone = Number.isFinite(done) ? done : 0

  if (lang === 'en') {
    const phaseText = phase === 'long' ? 'long break' : 'short break'
    return {
      system: TIP_SYSTEM_EN,
      user: `State: ${phaseText}, pomodoro ${safeRound} of this cycle, ${safeDone} finished today.`
        + ` Angle for this tip: ${TIP_CLAUSE_EN[safeAngle]}. Write the tip in English.`,
    }
  }

  const phaseText = phase === 'long' ? '长休息' : '短休息'
  return {
    system: TIP_SYSTEM_ZH,
    user: `状态：${phaseText}，本轮第 ${safeRound} 个番茄，今天已完成 ${safeDone} 个。`
      + `这句话的角度：${TIP_CLAUSE_ZH[safeAngle]}。用中文写这句话。`,
  }
}
