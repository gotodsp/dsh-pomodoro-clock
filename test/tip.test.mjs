// 休息提醒语的纯逻辑测试（宿主半 index.js 的具名导出）。
//
//   node test/tip.test.mjs
//
// 这里测纯函数（prompt 构造、输出清洗与长度校验、同源判定），以及注入了假 llm 的生成编排：
// 以上都无网络、无副作用。HTTP 路由本体是薄适配层，不进这里（它靠 Task 4 的实机验证）。
// 做法与 test/model.test.mjs 一致：一个 check() 帮手 + 末尾按失败数决定退出码，
// 方便后续任务顺序追加。
import assert from 'node:assert/strict'

import { buildTipPrompt, isSameOrigin, resolveTip, sanitizeTip, TIP_ANGLES, validateTip } from '../index.js'

let checks = 0
let failures = 0
function check(ok, label, detail = '') {
  checks += 1
  if (!ok) failures += 1
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? '  — ' + detail : ''}`)
}
function group(title) {
  console.log(`\n=== ${title} ===`)
}

// ------------------------------------------------------------ prompt 构造

group('角度表与 prompt 构造')
{
  // 断言 1：角度表是固定的五个，顺序即轮换顺序
  assert.deepEqual(TIP_ANGLES, ['water', 'distance', 'walk', 'stretch', 'breathe'])
  check(true, '角度表固定为五个且顺序即轮换顺序', TIP_ANGLES.join(' → '))

  // 断言 2：中文请求的 system 里必须含"只输出"和字数约束，user 里必须含状态数字与时间
  const zh = buildTipPrompt({ phase: 'short', round: 3, done: 7, now: '15:20', angle: 'water', lang: 'zh' })
  assert.ok(zh.system.includes('只输出'))
  assert.ok(zh.system.includes('12') && zh.system.includes('20'))   // 字数约束的上下界都在
  assert.ok(zh.user.includes('3') && zh.user.includes('7'))
  assert.ok(zh.user.includes('15:20'))                              // spec 要求把当前时间喂给模型
  assert.ok(zh.user.includes('水'))          // water 角度映射到"喝水"
  check(true, '中文 system 约束输出形状，user 带状态数字、时间与角度子句',
    `${zh.system} / ${zh.user}`)

  // 断言 3：英文请求的 user 不含中文字符，且英文的长度约束用"词"而非"字符"
  const en = buildTipPrompt({ phase: 'long', round: 4, done: 7, now: '15:20', angle: 'distance', lang: 'en' })
  assert.ok(!/[\u4e00-\u9fff]/.test(en.user))
  assert.ok(en.user.toLowerCase().includes('distance'))
  // 英文长度界有两条，prompt 必须都说出来：词数 3–8，以及字符预算 60（码点上限是宽度兜底）。
  // 只说词数时，一句 7 词、63 码点的回答按 prompt 合规、却被上限拒——那正是第 3 轮修掉的不变量缺口。
  assert.ok(/words/i.test(en.system) && /characters/i.test(en.system))
  check(true, '英文 user 全英文且含 distance 子句，system 同时用"词数"与"字符预算"约束长度', en.user)

  // 断言 4：五个角度都能映射出非空子句，且互不相同
  const clauses = TIP_ANGLES.map((a) => buildTipPrompt({ phase: 'short', round: 1, done: 1, now: '09:00', angle: a, lang: 'zh' }).user)
  assert.equal(new Set(clauses).size, TIP_ANGLES.length)
  check(true, '五个角度映射出五条互不相同的子句', `${clauses.length} 条`)

  // 断言 5：未知角度不抛异常，且**确实**退到第一个角度（不只是"没抛"）
  const fallbackUser = buildTipPrompt({ phase: 'short', round: 1, done: 1, now: '09:00', angle: 'nope', lang: 'zh' }).user
  const firstUser = buildTipPrompt({ phase: 'short', round: 1, done: 1, now: '09:00', angle: TIP_ANGLES[0], lang: 'zh' }).user
  assert.equal(fallbackUser, firstUser)
  check(true, '未知角度不抛异常，且确实退到 TIP_ANGLES[0]', fallbackUser)
}

// ------------------------------------------------------------ 清洗与校验

group('输出清洗 sanitizeTip')
{
  // 去首尾空白 + 成对的中文引号
  assert.equal(sanitizeTip('  「去接杯水吧」  '), '去接杯水吧')
  check(true, '去首尾空白，并脱掉成对的中文引号「」', sanitizeTip('  「去接杯水吧」  '))

  // 去掉开头的客套前缀
  assert.equal(sanitizeTip('好的，站起来走两步'), '站起来走两步')
  check(true, '去掉开头的客套「好的，」', sanitizeTip('好的，站起来走两步'))

  // 换行是删掉，不是换成空格（断言值里这几个字是连着的）
  assert.equal(sanitizeTip('去接杯水\n吧'), '去接杯水吧')
  check(true, '换行直接删掉，不留空格', JSON.stringify(sanitizeTip('去接杯水\n吧')))

  // 制表符同理
  assert.equal(sanitizeTip('去接杯水\t吧'), '去接杯水吧')
  check(true, '制表符也直接删掉', JSON.stringify(sanitizeTip('去接杯水\t吧')))

  // 成对的英文直引号
  assert.equal(sanitizeTip('"去接杯水吧"'), '去接杯水吧')
  check(true, '脱掉成对的英文直引号', sanitizeTip('"去接杯水吧"'))

  // Review Focus 3：客套与包裹引号叠加。削掉客套后才露出里层的引号，得再脱一次
  assert.equal(sanitizeTip('好的，"站起来走两步"'), '站起来走两步')
  check(true, '客套前缀与包裹引号叠加时一并清掉', sanitizeTip('好的，"站起来走两步"'))

  // 客套前缀后面紧跟换行：前缀的分隔符也得跨过换行（换行是在削前缀之后才删的）
  assert.equal(sanitizeTip('没问题，\n站起来走两步'), '站起来走两步')
  check(true, '客套前缀跟着换行时也能削掉', JSON.stringify(sanitizeTip('没问题，\n站起来走两步')))

  // 英文客套前缀：英文 system 明确禁止 "Sure" / "I suggest" 这类开头
  assert.equal(sanitizeTip('OK, go grab some water'), 'go grab some water')
  check(true, '英文客套前缀「OK, 」也削掉', sanitizeTip('OK, go grab some water'))

  // 不在首尾的引号不是包裹，别猜着删
  assert.equal(sanitizeTip('他说「站起来走两步」了'), '他说「站起来走两步」了')
  check(true, '不成对的引号留在正文里，不猜着删', sanitizeTip('他说「站起来走两步」了'))

  // 纯空白清洗成空串：清得干净不等于可用，可用性归 validateTip 判
  assert.equal(sanitizeTip('   '), '')
  check(true, '纯空白清洗成空串（可用性交给 validateTip）', JSON.stringify(sanitizeTip('   ')))
}

group('输出校验 validateTip')
{
  // 中文 6–24 字（本任务裁定：只数汉字，标点不计，见下一组）
  assert.equal(validateTip('站起来走两步', 'zh'), true)      // 6 字
  assert.equal(validateTip('好', 'zh'), false)               // 太短
  assert.equal(validateTip('一'.repeat(25), 'zh'), false)    // 太长
  assert.equal(validateTip('   ', 'zh'), false)              // 纯空白
  assert.equal(validateTip('去接杯水吧🙂', 'zh'), false)      // emoji
  assert.equal(validateTip('去接\n杯水吧', 'zh'), false)      // 换行
  check(true, '中文：6 字过；太短 / 太长 / 纯空白 / emoji / 换行都拒', '6 → true，其余 → false')

  // 英文按词数：3–8 词
  assert.equal(validateTip('go grab some water', 'en'), true)
  assert.equal(validateTip('go', 'en'), false)
  assert.equal(validateTip(Array.from({ length: 13 }, () => 'walk').join(' '), 'en'), false)
  check(true, '英文：4 词过；1 词与 13 词都拒', '按空白分词')

  // Review Focus 2：客套长句必须被挡下，回退默认句
  const long = '好的，我建议你站起来走动一下，顺便去接一杯水，然后看看远处的风景，让眼睛休息一下'
  assert.equal(validateTip(sanitizeTip(long), 'zh'), false)
  check(true, 'Review Focus 2：客套长句清洗后仍超界，被挡下',
    `清洗掉「好的，」后 ${sanitizeTip(long).length} 字符`)
}

group('中文长度只数汉字，标点不计入（本任务的边界裁定）')
{
  // 裁定理由：prompt 要求「12 到 20 个汉字」。若标点也计入 6–24，
  // 一句 20 汉字 + 5 标点的好回答是 25 个字符，会被自己的校验器拒掉 —— 生成即回退。
  const twenty = '站起来走两步，去接水，抬头看远处，深呼吸，伸懒腰。'
  assert.equal([...twenty].filter((c) => /[\u4e00-\u9fff]/.test(c)).length, 20)   // 20 个汉字
  assert.equal([...twenty].length, 25)                                            // 25 个字符
  assert.equal(validateTip(twenty, 'zh'), true)
  check(true, '20 个汉字 + 5 个标点 = 25 字符，仍通过（标点不计入）', twenty)

  // 上下界都由汉字数决定，标点改变不了判决
  assert.equal(validateTip('一'.repeat(25) + '。', 'zh'), false)
  check(true, '25 个汉字即使只带 1 个标点也拒（上界是汉字数）', '25 汉字 + 。')

  assert.equal(validateTip('站起来走两，。！？', 'zh'), false)
  check(true, '5 个汉字 + 4 个标点仍然太短（下界也是汉字数）', '5 汉字 + 4 标点')

  assert.equal(validateTip('，。！？；：', 'zh'), false)
  check(true, '纯标点 = 0 个汉字，拒', '，。！？；：')

  // 这条规则的直接好处：中文路径不会把英文句子塞进中文气泡
  assert.equal(validateTip('go grab some water', 'zh'), false)
  check(true, '中文路径下 0 个汉字的英文回复被拒（回退中文默认句）', 'go grab some water')

  // 与 buildTipPrompt 的取值约定一致：只有 'en' 走英文规则，其余（含缺陷值）按中文
  assert.equal(validateTip('站起来走两步', undefined), true)
  assert.equal(validateTip('go', undefined), false)
  check(true, 'lang 非 en（含 undefined）一律按中文规则校验', 'lang = undefined')

  // Review Focus 3 的「中英混排」：校验器不做语言检查，只数汉字——
  // 语言由 system 约束，不由校验器约束；短混排（6 个汉字 + 一句英文括注）照常通过
  assert.equal(validateTip('站起来走两步 (go walk)', 'zh'), true)
  check(true, '中英混排不做语言检查，短句按汉字数通过', '站起来走两步 (go walk)')

  // 真实答案通常带句号：下界处的 6 个汉字 + 句号仍然通过
  assert.equal(validateTip('站起来走两步。', 'zh'), true)
  check(true, '下界处的真实答案：6 个汉字带句号通过', '站起来走两步。')
}

group('英文按词数 3–8')
{
  // 边界两侧各钉一个：3 词与 8 词通过，2 词与 9 词拒绝。
  // 词长都压在上限之内，这样钉住的确实是词数界本身，而不是码点上限。
  assert.equal(validateTip('go drink water', 'en'), true)
  assert.equal(validateTip(Array.from({ length: 8 }, () => 'a').join(' '), 'en'), true)
  assert.equal(validateTip('go walk', 'en'), false)
  assert.equal(validateTip(Array.from({ length: 9 }, () => 'a').join(' '), 'en'), false)
  check(true, '英文边界：3 词与 8 词过，2 词与 9 词拒（词长在上限内）', '3 / 8 → true，2 / 9 → false')

  // 形状检查在长度之前，且不分语言
  assert.equal(validateTip('go grab some water 🙂', 'en'), false)
  assert.equal(validateTip('go grab\nsome water', 'en'), false)
  assert.equal(validateTip('   ', 'en'), false)
  check(true, '英文同样拒 emoji、换行与纯空白（词数本身是够的）', 'emoji / 换行 / 纯空白')

  // 空串：两种语言都拒
  assert.equal(validateTip('', 'zh'), false)
  assert.equal(validateTip('', 'en'), false)
  check(true, '空串对中英都拒（非空是第一道）', '空串')
}

// ------------------------------------------------------------ 评审修复轮

group('修复轮：总码点上限、英文换行补空格、客套必须跟标点、校验器挡制表符')
{
  // 中文码点上限 30（叠在汉字数界之上）：6 个汉字 + 40 个 ASCII = 46 码点，148px 的气泡装不下
  const longTail = '站起来走两步 go walk around the block and back again'
  assert.equal([...longTail].length, 46)
  assert.equal(validateTip(longTail, 'zh'), false)
  check(true, '汉字数合规但 46 码点的长尾巴被中文上限 30 挡下', `${[...longTail].length} 码点 → false`)

  // 上限不能把 prompt 合规的好答案一起拒掉：25 码点的样例仍在界内
  const ok25 = '站起来走两步，去接水，抬头看远处，深呼吸，伸懒腰。'
  assert.equal([...ok25].length, 25)
  assert.equal(validateTip(ok25, 'zh'), true)
  check(true, '中文上限 30 不误杀 25 码点的合规样例', `${[...ok25].length} 码点 → true`)

  // 上限的边界两侧：24 个汉字（汉字上界）恰好只留 6 个 ASCII 位
  assert.equal(validateTip('一'.repeat(24) + 'x'.repeat(6), 'zh'), true)
  assert.equal(validateTip('一'.repeat(24) + 'x'.repeat(7), 'zh'), false)
  check(true, '中文码点边界：30 过、31 拒（汉字数同为 24）', '30 → true，31 → false')

  // 上一轮英文词数界还是 3–12，12 个 'walk'（59 码点）词数合规、由 30 码点上限挡下。
  // 本轮词数上界收到 8、英文上限放宽到 60，这条改由词数界拒 —— 判决不变，理由变了。
  const twelveWalk = Array.from({ length: 12 }, () => 'walk').join(' ')
  assert.equal([...twelveWalk].length, 59)
  assert.equal(validateTip(twelveWalk, 'en'), false)
  check(true, '12 个 walk（59 码点）仍拒：本轮由英文词数上界 8 挡下', `${[...twelveWalk].length} 码点 / 12 词 → false`)

  // 英文换行必须先补一个空格再删，否则粘成一个词「grabsome」，还能通过词数校验进气泡
  assert.equal(sanitizeTip('go grab\nsome water'), 'go grab some water')
  check(true, '英文换行补空格：不再粘成「grabsome」', JSON.stringify(sanitizeTip('go grab\nsome water')))

  // 反面：判据是「两侧都是 ASCII 词字符」，汉字不是，中文换行仍直接删掉
  assert.equal(sanitizeTip('去接杯水\n吧'), '去接杯水吧')
  check(true, '汉字之间的换行仍直接删掉，不补空格', JSON.stringify(sanitizeTip('去接杯水\n吧')))

  // 客套前缀必须跟着标点：只跟空格的合法正文不能被削（削掉后校验器看不出损坏）
  assert.equal(sanitizeTip('Sure thing, stretch your legs'), 'Sure thing, stretch your legs')
  check(true, '只跟空格的 Sure 不算客套，正文不被削掉', sanitizeTip('Sure thing, stretch your legs'))

  // 调用方跳过 sanitizeTip 时，校验器自己也要挡下制表符（站/起/来/走/两/步 = 6 个汉字，本来会过）
  assert.equal(validateTip('站\t起来走两步', 'zh'), false)
  check(true, '校验器直接挡下制表符（6 个汉字也不放行）', JSON.stringify('站\t起来走两步'))
}

// ------------------------------------------------------------ 修复轮 2

group('修复轮 2：码点上限按语言宽度分（zh 30 / en 60），英文词数上界收到 8')
{
  // 上一轮把 30 码点总上限中英共用，压住了英文的词数界：12 个 'walk' 是 59 码点，
  // 一句 7–12 词的合规英文回答会被自己的上限拒掉 —— 又一次「按 prompt 生成却被自己拒」。
  // 汉字约拉丁字符两倍宽，所以同一个气泡宽度对应 zh ≤ 30 码点 / en ≤ 60 码点。

  // 合规的英文回答必须过：8 个 'walk' 是 8 词、39 码点，旧的中英共用 30 上限会误杀
  const enOk = Array.from({ length: 8 }, () => 'walk').join(' ')
  assert.equal(enOk.split(/\s+/).length, 8)
  assert.equal([...enOk].length, 39)
  assert.equal(validateTip(enOk, 'en'), true)
  check(true, '英文：8 词、39 码点的合规句通过（旧的共用 30 上限会拒）', `${[...enOk].length} 码点 → true`)

  // 英文上限的边界两侧：60 过、61 拒，词数同为 8（钉住的确实是英文那条上限）
  const en60 = ['aaaaaaa', 'bbbbbbb', 'ccccccc', 'ddddddd', 'eeeeeee', 'fffffff', 'ggggggg', 'hhhh'].join(' ')
  const en61 = ['aaaaaaa', 'bbbbbbb', 'ccccccc', 'ddddddd', 'eeeeeee', 'fffffff', 'ggggggg', 'hhhhh'].join(' ')
  assert.equal(en60.split(/\s+/).length, 8)
  assert.equal(en61.split(/\s+/).length, 8)
  assert.equal([...en60].length, 60)
  assert.equal([...en61].length, 61)
  assert.equal(validateTip(en60, 'en'), true)
  assert.equal(validateTip(en61, 'en'), false)
  check(true, '英文码点边界：60 过、61 拒（词数同为 8）', '60 → true，61 → false')

  // 词数合规但尾巴过长，仍由英文上限挡下
  const enLong = Array.from({ length: 8 }, (_, i) => String.fromCharCode(97 + i).repeat(9)).join(' ')
  assert.equal(enLong.split(/\s+/).length, 8)
  assert.equal([...enLong].length, 79)
  assert.equal(validateTip(enLong, 'en'), false)
  check(true, '英文：词数合规（8 词）但 79 码点，被 60 上限挡下', `${[...enLong].length} 码点 → false`)

  // 中文上限仍是 30：合规句过，超宽句拒
  const zhOk = '站起来走两步，去接水，抬头看远处，深呼吸，伸懒腰。'
  assert.equal([...zhOk].length, 25)
  assert.equal(validateTip(zhOk, 'zh'), true)
  assert.equal(validateTip('一'.repeat(24) + 'x'.repeat(7), 'zh'), false)
  check(true, '中文上限仍是 30：25 码点合规句过、31 码点拒', '25 → true，31 → false')

  // 钉住「上一轮定下的判决不变」：25 码点的中文合规样例过，46 码点的中英混排拒
  const longTail = '站起来走两步 go walk around the block and back again'
  assert.equal([...longTail].length, 46)
  assert.equal(validateTip(longTail, 'zh'), false)
  check(true, '上轮两条钉样判决不变：25 码点 → true，46 码点 → false', '回归钉')

  // prompt 说的范围必须落在校验器范围内：直接拿 system 里写的数字去翻边界
  const enSystem = buildTipPrompt({ phase: 'short', round: 1, done: 1, now: '09:00', angle: 'water', lang: 'en' }).system
  const enBound = enSystem.match(/(\d+) and (\d+) words/)
  assert.deepEqual([Number(enBound[1]), Number(enBound[2])], [3, 8])
  assert.equal(validateTip(Array.from({ length: 3 }, () => 'a').join(' '), 'en'), true)
  assert.equal(validateTip(Array.from({ length: 8 }, () => 'a').join(' '), 'en'), true)
  assert.equal(validateTip(Array.from({ length: 9 }, () => 'a').join(' '), 'en'), false)
  check(true, '英文 system 写的 3–8 词 = 校验器的 3–8 词（词数界处判决一致）', enBound[0])

  // 修复轮 3（Finding 1）：码点上限是宽度兜底，prompt 也必须把它说出来。原来的 system 只有词数，
  // 一句 7 词、63 码点的回答按 prompt 合规却被 60 上限拒掉——「prompt 的范围落在校验器内」当时是假的不变量。
  // 照样从 system 里抠数字，不在测试里重述字符串：抠出的预算必须正是界线上那句（en60）的码点数。
  const enCharBound = enSystem.match(/(\d+) characters/)
  assert.ok(enCharBound, '英文 system 必须写出字符预算（不说出来，按 prompt 生成的长句照样被上限拒）')
  assert.equal(Number(enCharBound[1]), [...en60].length)
  check(true, '英文 system 也写出字符预算，且与 60 码点上限同值（界处判决见前两条）', enCharBound[0])

  const zhSystem = buildTipPrompt({ phase: 'short', round: 1, done: 1, now: '09:00', angle: 'water', lang: 'zh' }).system
  const zhBound = zhSystem.match(/(\d+) 到 (\d+) 个汉字/)
  assert.deepEqual([Number(zhBound[1]), Number(zhBound[2])], [12, 20])
  assert.equal(validateTip('一'.repeat(12), 'zh'), true)
  assert.equal(validateTip('一'.repeat(20), 'zh'), true)
  check(true, '中文 system 写的 12–20 个汉字落在校验器的 6–24 内（两端都过）', zhBound[0])
}

// ------------------------------------------------------------ 修复轮 3

group('修复轮 3：英文断口（含制表符与 U+2028/U+2029）与换行同等补空格')
{
  // 上一轮的补空格常量（当时叫 TIP_ASCII_LINE_BREAK，本轮已改名 TIP_ASCII_BREAK_JOIN）只覆盖 [\r\n]，
  // \t 与 U+2028/U+2029 仍旧走「直接删」那条路：`go grab\tsome water` 粘成 `go grabsome water`
  // （3 个词，照样过词数校验、进气泡）——与已经修过的换行粘连是同一类损坏，只是落在修复刚碰过的那条路径上。

  // 五个断口字符逐个翻一遍，两个方向都钉住：英文补空格，中文直接删
  const breaks = [['LF', '\n'], ['CR', '\r'], ['TAB', '\t'], ['U+2028', '\u2028'], ['U+2029', '\u2029']]
  assert.deepEqual(breaks.map(([, ch]) => sanitizeTip(`go grab${ch}some water`)), breaks.map(() => 'go grab some water'))
  assert.deepEqual(breaks.map(([, ch]) => sanitizeTip(`水${ch}吧`)), breaks.map(() => '水吧'))
  check(true, '五种断口字符：英文一律补空格、中文一律直接删', breaks.map(([name]) => name).join(' / '))

  // 裁定点名的两条
  assert.equal(sanitizeTip('go grab\tsome water'), 'go grab some water')
  check(true, '制表符不再粘词：go grab\\tsome water → go grab some water', JSON.stringify(sanitizeTip('go grab\tsome water')))

  assert.equal(sanitizeTip('水\t吧'), '水吧')
  check(true, '汉字之间的制表符仍直接删掉：水\\t吧 → 水吧', JSON.stringify(sanitizeTip('水\t吧')))

  // 粘连后的文本本身是 3 个词、能过校验：校验器拦不住，只能在清洗阶段修好
  assert.equal(validateTip('go grabsome water', 'en'), true)
  const joined = sanitizeTip('go grab\tsome water')
  assert.equal(joined.split(/\s+/).length, 4)
  assert.equal(validateTip(joined, 'en'), true)
  check(true, '粘连文本「go grabsome water」是 3 词、能过校验，必须靠清洗修', 'grabsome → grab some')

  // 连续与混排断口算同一个断口：只补一个空格，不多出空档
  assert.equal(sanitizeTip('go grab\t\n\nsome water'), 'go grab some water')
  check(true, '连续与混排断口只补一个空格', JSON.stringify(sanitizeTip('go grab\t\n\nsome water')))
}

// ------------------------------------------------------------ 生成编排（依赖注入）

group('生成编排 resolveTip：注入假 llm，覆盖全部失败路径')
{
  // 假 llm 让「模型调用」这一层完全不碰网络：只要求 stream() 返回 AsyncIterable。
  // 正文样例用「去接一杯水吧」（6 个汉字）而不是计划里的「去接杯水吧」：后者只有 5 个汉字，
  // 过不了 validateTip 的 6–24 下界（该下界已由本文件前面的断言钉住），拿它当「正常路径」
  // 的样例等于让样例自己违约 —— 正常路径的样例必须是 prompt 合规、校验也能过的句子。
  const input = { phase: 'short', round: 1, done: 1, now: '15:20', angle: 'water', lang: 'zh' }
  const okLlm = (chunks) => ({ stream: async function* () { for (const c of chunks) yield c } })
  const textChunks = (s) => [{ type: 'text-delta', text: s }, { type: 'finish', reason: { kind: 'stop' } }]
  const deps = (llm, extra = {}) => ({ llm, provider: 'p', model: 'm', ...extra })

  // 正常路径：攒 text-delta，清洗 + 校验后返回
  assert.equal(await resolveTip(deps(okLlm(textChunks('去接一杯水吧'))), input), '去接一杯水吧')
  check(true, '正常：攒 text-delta，返回校验通过的句子', '去接一杯水吧')

  // 返回的是清洗后的句子：客套前缀与包裹引号不该出现在气泡里
  assert.equal(await resolveTip(deps(okLlm(textChunks('好的，「站起来走两步」'))), input), '站起来走两步')
  check(true, '返回值确实经过 sanitizeTip（客套前缀 + 包裹引号都清掉）', '站起来走两步')

  // 英文走同一条链路，按 en 的长度界校验
  assert.equal(await resolveTip(deps(okLlm(textChunks('go grab some water'))), { ...input, lang: 'en' }), 'go grab some water')
  check(true, '英文路径：按 en 规则校验并返回', 'go grab some water')

  // 只认 text-delta：reasoning-delta 是模型的思考过程（本机默认推理档很高，它一定会来），
  // 一旦被并进正文，气泡里就会出现「让我想想去接一杯水吧」这种话。
  const withReasoning = [
    { type: 'reasoning-delta', text: '让我想想' },
    { type: 'text-delta', text: '去接一杯水吧' },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
  assert.equal(await resolveTip(deps(okLlm(withReasoning)), input), '去接一杯水吧')
  check(true, 'reasoning-delta 不进正文，只有 text-delta 参与构句', '让我想想 + 去接一杯水吧 → 去接一杯水吧')

  // 第一道降级：服务缺席 → 立即 null，不建超时、不碰模型、不抛
  assert.equal(await resolveTip({ llm: undefined, provider: 'p', model: 'm' }, input), null)
  check(true, 'llm 服务缺席 → null（第一道降级，早于任何 I/O）', 'llm: undefined')

  // 调用方把参数传坏（deps 整个缺席 / input 缺席 / signal 不是真的 AbortSignal）也不许抛：
  // 契约只有「返回 null」一种出口
  assert.equal(await resolveTip(undefined, input), null)
  assert.equal(await resolveTip(deps(okLlm(textChunks('去接一杯水吧'))), undefined), null)
  assert.equal(await resolveTip({ ...deps(okLlm(textChunks('去接一杯水吧'))), signal: {} }, input), null)
  check(true, '坏参数（deps 缺席 / input 缺席 / signal 不是 AbortSignal）→ null，不抛', '坏参数走同一条出口')

  // 迭代中抛错（网络断）：异常不外泄
  const boom = { stream: async function* () { throw new Error('network') } }
  assert.equal(await resolveTip(deps(boom), input), null)
  check(true, '模型抛错 → null，异常不外泄', 'throw new Error("network")')

  // 先吐正文再抛错：已攒内容必须丢弃，不能把半句话送进气泡
  const half = { stream: async function* () { yield { type: 'text-delta', text: '去接一杯水吧' }; throw new Error('network') } }
  assert.equal(await resolveTip(deps(half), input), null)
  check(true, '先吐正文再抛错 → 半句话也丢弃，返回 null', 'text-delta 之后 throw')

  // stream() 本身同步抛错（适配器坏掉）：同样只返回 null
  const syncBoom = { stream: () => { throw new Error('bad adapter') } }
  assert.equal(await resolveTip(deps(syncBoom), input), null)
  check(true, 'stream() 同步抛错 → null', 'sync throw')

  // 流不守约：text 不是字符串（这里是数组）时不能靠字符串拼接「碰巧」拼出一句合规的话，
  // 也不能让 sanitizeTip 对非字符串的显式抛错泄出去；stream() 返回的不是 AsyncIterable
  // 同样只走 null 出口。
  const badText = { stream: async function* () { yield { type: 'text-delta', text: ['去接一杯水吧'] }; yield { type: 'finish', reason: { kind: 'stop' } } } }
  assert.equal(await resolveTip(deps(badText), input), null)
  const notIterable = { stream: () => undefined }
  assert.equal(await resolveTip(deps(notIterable), input), null)
  check(true, '流不守约（text 非字符串 / stream 返回非可迭代）→ null，异常不外泄', '协议坏掉就回退')

  // 校验不过 → null（空响应）
  assert.equal(await resolveTip(deps(okLlm(textChunks(''))), input), null)
  check(true, '空响应 → 校验不过 → null', 'text-delta ""')

  // 校验不过 → null（客套长句）
  const long = '好的，我建议你站起来走动一下，顺便去接一杯水，然后看看远处的风景，让眼睛休息一下'
  assert.equal(await resolveTip(deps(okLlm(textChunks(long))), input), null)
  check(true, '客套长句 → 校验不过 → null', `清洗后仍 ${sanitizeTip(long).length} 字符`)

  // 一个 chunk 都没有的空流 → null（不是异常，是「什么都没生成」）
  assert.equal(await resolveTip(deps(okLlm([])), input), null)
  check(true, '空流（一个 chunk 都没有）→ null', 'chunks: []')

  // 只有正文、没有终止块：流被截断，不能当成生成成功
  assert.equal(await resolveTip(deps(okLlm([{ type: 'text-delta', text: '去接一杯水吧' }])), input), null)
  check(true, '没有 finish 终止块（流被截断）→ null', '只有 text-delta')

  // finish 非 stop：已攒正文全部丢弃。error / aborted 是模型失败与取消，max-tokens 是
  // 60 token 上限处被截断，tool-calls 是模型跑偏去调工具 —— 四种都不能当作完整句子。
  const badKinds = ['error', 'aborted', 'max-tokens', 'tool-calls']
  const badVerdicts = []
  for (const kind of badKinds) {
    const chunks = [{ type: 'text-delta', text: '去接一杯水吧' }, { type: 'finish', reason: { kind } }]
    badVerdicts.push(await resolveTip(deps(okLlm(chunks)), input))
  }
  assert.deepEqual(badVerdicts, badKinds.map(() => null))
  check(true, 'finish 非 stop（error / aborted / max-tokens / tool-calls）→ 已攒内容全部丢弃', badKinds.join(' / '))

  // 外部 signal 已 abort（路由在客户端断开时会这样调）→ null，且不该再发起模型调用
  const ac = new AbortController()
  ac.abort()
  let called = false
  const spyCalled = { stream: async function* () { called = true; for (const c of textChunks('去接一杯水吧')) yield c } }
  assert.equal(await resolveTip(deps(spyCalled, { signal: ac.signal }), input), null)
  assert.equal(called, false)
  check(true, '外部 signal 已 abort → null，且一次模型调用都不发起', `stream 被调用：${called}`)

  // 生成中途用户切走：正文已攒全、finish 也是 stop，但 signal 已 abort → 仍然丢弃
  const acMid = new AbortController()
  const midway = {
    stream: async function* () {
      yield { type: 'text-delta', text: '去接一杯水吧' }
      acMid.abort()
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
  }
  assert.equal(await resolveTip(deps(midway, { signal: acMid.signal }), input), null)
  check(true, '生成中途 abort → 正文再合规也不采纳（用户切走后不再替换气泡）', 'chunk 之间 abort')

  // 不真等 3 秒测内部超时（那会让整个用例慢 3 秒，真实超时由 Task 4 实机验证覆盖）。
  // 这里能观测的是两件事，合起来足以排除两种单取一边的实现：
  //   (a) 传进模型的 signal 不是外部那个对象本身 —— 「只用外部 signal」的实现会把 deps.signal
  //       原样传下去，过不了；
  //   (b) 外部 abort 后它立刻跟着 abort —— 「只用内部超时」的实现过不了。
  // 剩下「内部 3 秒超时确实也在合并里」这一半无法在单测里便宜地观测（要真等 3 秒），
  // 由 Task 4 的实机验证覆盖。
  const acAny = new AbortController()
  let seen = null
  const captor = {
    stream: (o) => {
      seen = o
      return (async function* () { for (const c of textChunks('去接一杯水吧')) yield c })()
    },
  }
  assert.equal(await resolveTip(deps(captor, { signal: acAny.signal }), input), '去接一杯水吧')
  assert.ok(seen.signal instanceof AbortSignal)
  assert.notEqual(seen.signal, acAny.signal)
  const abortedBefore = seen.signal.aborted
  acAny.abort()
  assert.equal(abortedBefore, false)
  assert.equal(seen.signal.aborted, true)
  check(true, 'deps.signal 与内部超时合并（AbortSignal.any）：传给模型的不是外部 signal 本身，且随外部 abort',
    `同一对象 ${seen.signal === acAny.signal}，abort 前 ${abortedBefore} → abort 后 ${seen.signal.aborted}`)

  // 请求体的形状：provider / model / system / messages / reasoningEffort / maxTokens=60 / signal 齐全，
  // 且**不得**出现 purpose（该字段只接受 compaction / session-title，没有给插件留位置）。
  // messages 里的 content 是 ContentBlock[]（真实 llm 服务的请求消息按块数组解析），
  // 只带一个 text 块，内容正是 buildTipPrompt 的 user 串（发给模型的只有状态数字与角度）。
  //
  // reasoningEffort: 'off' 是修复轮 4 加的，**这条断言就是当时的 bug**：修复前这里断言的是
  // 「请求里没有 reasoningEffort」，理由是「不传就是让适配器用自己的默认、不抬推理」。实机证伪了
  // 这个理由——不传 = 走适配器默认 = high 档。见下面「关掉推理」那一段。
  const prompt = buildTipPrompt(input)
  let opts = null
  const spyOpts = {
    stream: (o) => {
      opts = o
      return (async function* () { for (const c of textChunks('去接一杯水吧')) yield c })()
    },
  }
  assert.equal(await resolveTip(deps(spyOpts), input), '去接一杯水吧')
  assert.equal(opts.provider, 'p')
  assert.equal(opts.model, 'm')
  assert.equal(opts.system, prompt.system)
  assert.deepEqual(opts.messages, [{ role: 'user', content: [{ type: 'text', text: prompt.user }] }])
  assert.equal(opts.reasoningEffort, 'off')
  assert.equal(opts.maxTokens, 60)
  assert.ok(opts.signal instanceof AbortSignal)
  assert.equal('purpose' in opts, false)
  check(true, '请求体：provider/model/system/messages/reasoningEffort=off/maxTokens=60/signal 齐全，无 purpose',
    'maxTokens 60，reasoningEffort off，content 为 ContentBlock[]')

  // ---- 关掉推理（修复轮 4）----
  //
  // 实机（宿主进程里抓到的原始 chunk）证明：请求里不带 reasoningEffort 时，模型先把 60 token 的
  // maxTokens 全花在 reasoning-delta 上（内容是把 system 复述一遍），再以 finish{kind:'max-tokens'}
  // 收尾，**一个 text-delta 都没有** → 204。60 token 的预算与 high 档的推理互斥，所以必须显式关掉。
  // 上面那条断言钉住「带上了 off」；下面钉住它带来的两个后果：重试的条件与上限。

  // 第一次以 error 收尾（当前 provider 不认这个档：能力校验跑在派发之前，不发真实请求）→
  // 去掉该字段重试一次。第二次的请求体除 reasoningEffort 外逐字段与第一次相同，结果照常过校验。
  const attempts = []
  const retryLlm = {
    stream: (o) => {
      attempts.push(o)
      return attempts.length === 1
        ? (async function* () {
            yield { type: 'finish', reason: { kind: 'error', failure: { message: 'unsupported effort', code: 'UNSUPPORTED_REASONING_EFFORT' } } }
          })()
        : (async function* () { for (const c of textChunks('去接一杯水吧')) yield c })()
    },
  }
  const retried = await resolveTip(deps(retryLlm), input)
  assert.equal(retried, '去接一杯水吧')
  assert.equal(attempts.length, 2)
  assert.equal(attempts[0].reasoningEffort, 'off')
  assert.equal('reasoningEffort' in attempts[1], false)
  const { reasoningEffort: droppedEffort, ...firstWithoutEffort } = attempts[0]
  assert.deepEqual(attempts[1], firstWithoutEffort)
  assert.equal(droppedEffort, 'off')
  check(true, '适配器以 error 收尾（不认 reasoningEffort）→ 去掉该字段重试一次，其余字段逐字相同',
    `两次调用，第二次无 reasoningEffort，结果 ${JSON.stringify(retried)}`)

  // 重试有上限：两次都 error 就到此为止，且采纳标准一点没松——第二次也必须 stop 才算数
  let bothCalls = 0
  const alwaysError = {
    stream: () => {
      bothCalls += 1
      return (async function* () {
        yield { type: 'finish', reason: { kind: 'error', failure: { message: 'x', code: 'BOOM' } } }
      })()
    },
  }
  assert.equal(await resolveTip(deps(alwaysError), input), null)
  assert.equal(bothCalls, 2)
  check(true, '两次都以 error 收尾 → null，且只发两次调用（重试有上限，不无限重试）',
    `stream 被调用 ${bothCalls} 次`)

  // max-tokens / aborted 不触发重试：去掉 reasoningEffort 只会让推理回来（更糟），取消则重试无意义
  for (const kind of ['max-tokens', 'aborted']) {
    let calls = 0
    const oneKind = {
      stream: () => {
        calls += 1
        return (async function* () { yield { type: 'finish', reason: { kind } } })()
      },
    }
    assert.equal(await resolveTip(deps(oneKind), input), null)
    assert.equal(calls, 1)
  }
  check(true, 'max-tokens / aborted 不触发重试（各只发一次调用）', 'max-tokens / aborted')

  // onFailure：回退默认句时把「为什么」交给宿主日志（HTTP 上 204 与「插件坏了」同形，
  // 这一行短码是唯一的区分手段）。它必须覆盖每一条失败出口，且自己抛错不影响结论。
  const reasons = []
  const noting = (llm, extra = {}) => deps(llm, { onFailure: (r) => reasons.push(r), ...extra })
  assert.equal(await resolveTip(noting(undefined), input), null) // llm 缺席
  assert.equal(await resolveTip(noting(okLlm(textChunks(''))), input), null) // 校验不过
  assert.equal(await resolveTip(noting(okLlm([])), input), null) // 没有终止块
  const acReason = new AbortController()
  acReason.abort()
  assert.equal(await resolveTip(noting(okLlm(textChunks('去接一杯水吧')), { signal: acReason.signal }), input), null)
  assert.deepEqual(reasons, ['no-llm', 'rejected:0cp/0han', 'no-finish', 'client-abort'])
  reasons.length = 0
  assert.equal(await resolveTip(noting(alwaysError), input), null)
  // 重试的两次尝试**只记最后那一条**：一次请求一行日志，不是一次尝试一行
  assert.deepEqual(reasons, ['error:BOOM'])
  assert.equal(await resolveTip(noting(okLlm([]), { onFailure: () => { throw new Error('log broken') } }), input), null)
  check(true, 'onFailure 覆盖每条失败出口（短码含适配器失败码），钩子抛错也不影响返回 null',
    reasons.concat('log broken → 仍 null').join(' / '))
}

// ------------------------------------------------------------ 同源检查（Task 4）

group('同源检查 isSameOrigin')
{
  // Origin 缺席 → 放行（同源 GET 通常不带 Origin；把它当跨站会把正常请求全部误杀）
  assert.equal(isSameOrigin(undefined, 'localhost:52341'), true)

  // 同源 → 放行
  assert.equal(isSameOrigin('http://localhost:52341', 'localhost:52341'), true)

  // 跨站 → 拒绝
  assert.equal(isSameOrigin('http://evil.example', 'localhost:52341'), false)
  check(true, 'Origin 缺席放行、同源放行、跨站拒绝（brief 点名的三条）', 'undefined / 同源 / evil.example')

  // 空 Origin 等同于缺席（brief：undefined/空 → true）；
  // host 比较交给 URL 解析器归一：大小写不敏感、默认端口不写出来，与浏览器发出的 Host 写法一致
  assert.equal(isSameOrigin('', 'localhost:52341'), true)
  assert.equal(isSameOrigin('http://LOCALHOST:52341', 'localhost:52341'), true)
  assert.equal(isSameOrigin('https://localhost', 'localhost'), true)
  check(true, '空 Origin 放行；Host 比较走 URL 归一（大小写、默认端口）', '"" / LOCALHOST / https://localhost')

  // 端口不同、回环别名不同（127.0.0.1 ≠ localhost）、请求 Host 缺席：都不是同源
  assert.equal(isSameOrigin('http://localhost:52342', 'localhost:52341'), false)
  assert.equal(isSameOrigin('http://127.0.0.1:52341', 'localhost:52341'), false)
  assert.equal(isSameOrigin('http://localhost:52341', undefined), false)
  check(true, '端口不同 / 回环别名不同 / 请求 Host 缺席 → 拒绝', '52342 / 127.0.0.1 / undefined')

  // 解析不了的 Origin 按跨站处理，且不许抛：沙箱 iframe 与 file:// 页面发的正是字符串 "null"。
  // 这条路由没有别的访问控制（401 只挡 fallback 的 index 响应），所以这里宁可拒。
  assert.equal(isSameOrigin('null', 'localhost:52341'), false)
  assert.equal(isSameOrigin('://', 'localhost:52341'), false)
  assert.equal(isSameOrigin('localhost:52341', 'localhost:52341'), false)
  check(true, '无法解析的 Origin（含 "null"、缺 scheme）拒绝且不抛异常', 'null / :// / localhost:52341')
}

// ---------------------------------------------------------------- 汇总

console.log(`\n${failures === 0 ? '全部通过' : '存在失败'}：${checks - failures}/${checks} 项通过`)
process.exit(failures === 0 ? 0 : 1)
