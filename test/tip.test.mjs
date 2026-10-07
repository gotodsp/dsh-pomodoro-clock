// 休息提醒语的纯逻辑测试（宿主半 index.js 的具名导出）。
//
//   node test/tip.test.mjs
//
// 这里测纯函数（prompt 构造、输出清洗与长度校验、同源判定），以及注入了假 llm 的生成编排：
// 以上都无网络、无副作用。HTTP 路由本体的状态/响应头映射**也在这里**（最后一组用假 ctx 装载
// 真实的 apply/handleTip、驱动真实 handler）：200 + {"text"} + no-store、五条 204 出口、以及
// handler 未预料异常的 204 + 留痕。这一层原先只靠仓库外的两个临时 harness（其中一个还断言着
// 修复前的 prompt 文本与「请求里没有 reasoningEffort」），于是重写 handleTip 可以带着全绿的
// node --run test 把整个功能改坏——整支评审的 Finding 1。
// 做法与 test/model.test.mjs 一致：一个 check() 帮手 + 末尾按失败数决定退出码，方便后续任务顺序追加。
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { apply, buildTipPrompt, isSameOrigin, resolveTip, sanitizeTip, TIP_ANGLES, validateTip } from '../index.js'
// 宿主那份角度表的显式别名。下面「客户端角度轮换」一组里的 TIP_ANGLES 是**从 client.js
// 按标记切片求值出来的那一份**（浏览器包 import 不了宿主半，两份是各自独立的副本），
// 漂移检查必须把两边分开命名，否则比的就是同一份。
import { TIP_ANGLES as HOST_ANGLES } from '../index.js'

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

/**
 * 等一个**只能靠 AbortSignal.timeout 才会结束**的 promise。
 *
 * Node 给 `AbortSignal.timeout()` 的计时器是 **unref** 的：测试进程若只剩它在等，事件循环空转、
 * 进程直接退出，症状是 `Detected unsettled top-level await`（看起来像挂了，其实是「没东西可跑」）。
 * 这个帮手在等待期间挂一个 ref 的 interval 把循环撑住，拿到结果就清掉——被测逻辑一点没改。
 */
async function awaitWithRef(promise) {
  const timer = setInterval(() => {}, 10)
  try {
    return await promise
  } finally {
    clearInterval(timer)
  }
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

  // 断言 6（修复轮 1）：done 是**累计**数（只有「清除统计」才归零），prompt 不许把它说成"今天"。
  // 中英两条模板都要钉住 —— 只改一条，另一半照样把假前提递给模型。
  assert.ok(!zh.user.includes('今天') && zh.user.includes('累计'), zh.user)
  assert.ok(!/today/i.test(en.user) && /total/i.test(en.user), en.user)
  check(true, 'done 说成"累计"而不是"今天"（中英模板都钉住，跨天不清零时不会递给模型假前提）',
    `zh：${zh.user}`)
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

  // 修复轮 6（Finding 7）：中文的 30 码点上限原先**只在校验器里**，system 一个字没提，而注释
  // 却在说「每一条长度界都要写进 prompt」——注释替代码吹了牛，中文路径还留着「按 prompt 生成
  // 的句子被自己的校验器拒掉」这个缺陷类的最后一点残渣（汉字数合规、标点一多就超 30）。
  // 补的是 system，不是放宽校验器。照样从 system 里抠数字，再拿它当界线翻两面：
  // 恰好 30 码点必须过，31 必须拒——抠出来的数字与校验器的判决在同一条线上。
  const zhCharBound = zhSystem.match(/(\d+) 个字符/)
  assert.ok(zhCharBound, '中文 system 必须写出码点上限（不说出来，注释里那句不变量就是假的）')
  const zhCap = Number(zhCharBound[1])
  const atCap = '一'.repeat(20) + '，'.repeat(zhCap - 20)
  const overCap = '一'.repeat(20) + '，'.repeat(zhCap - 20 + 1)
  assert.equal([...atCap].length, zhCap)
  assert.equal(validateTip(atCap, 'zh'), true)
  assert.equal(validateTip(overCap, 'zh'), false)
  check(true, `中文 system 也写出码点上限，且界处判决一致（${zhCap} 码点 → true，${zhCap + 1} → false）`,
    zhCharBound[0])
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

  // 生成中途用户切走：正文已攒全、finish 也是 stop，但 signal 已 abort → 仍然丢弃。
  // 顺带钉住**分类**（Finding 2）：读 chunk 时发现 abort，短码必须是 client-abort，
  // 不能混成 timeout（用户切走与我们自己的期限是两条不同的排查线索）。
  const acMid = new AbortController()
  const midReasons = []
  const midway = {
    stream: async function* () {
      yield { type: 'text-delta', text: '去接一杯水吧' }
      acMid.abort()
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
  }
  assert.equal(await resolveTip(deps(midway, { signal: acMid.signal, onFailure: (r) => midReasons.push(r) }), input), null)
  assert.deepEqual(midReasons, ['client-abort'])
  check(true, '生成中途 abort → 正文再合规也不采纳，且短码是 client-abort', 'chunk 之间 abort')

  // 不真等 3 秒测内部超时（那会让整个用例慢 3 秒，真实超时由 Task 4 实机验证覆盖）。
  // 这里能观测的是两件事，合起来足以排除两种单取一边的实现：
  //   (a) 传进模型的 signal 不是外部那个对象本身 —— 「只用外部 signal」的实现会把 deps.signal
  //       原样传下去，过不了；
  //   (b) 外部 abort 后它立刻跟着 abort —— 「只用内部超时」的实现过不了。
  // 「内部期限确实也在合并里」这另一半原先说「要真等 3 秒、测不了」，所以只由实机覆盖——
  // 那个借口在本轮失效了：deps.timeoutMs 是给测试留的接缝（生产不传，仍是 3000），
  // 下面几条把它按 50ms 跑一遍（含「适配器用 reject 兑现 signal」这个 Finding 2 的现场）。
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

  // ---- 内部期限可注入 + abort 引起的失败按 signal 归类（Finding 1 的接缝 / Finding 2）----
  //
  // 一个「挂住直到 signal abort」的适配器：它**用 reject 兑现 signal**——这是合理契约，也是
  // 实机那次 3016ms 超时的等价物。修复前这类失败走 catch 分支记 iteration-threw，README 的
  // 失败矩阵却写着 timeout，读排查指引的人会去查一个并不存在的网络故障。
  const hangUntilAbort = {
    stream: (o) => (async function* () {
      await new Promise((resolve, reject) => {
        if (o.signal.aborted) reject(new Error('aborted'))
        else o.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
      })
    })(),
  }

  // (1) 内部期限真的会砍掉慢调用：50ms 的期限、挂住的适配器 → null + 短码 timeout，且确实等到了期限。
  const slowReasons = []
  const slowStart = Date.now()
  const slowVerdict = await awaitWithRef(resolveTip(deps(hangUntilAbort, { timeoutMs: 50, onFailure: (r) => slowReasons.push(r) }), input))
  assert.equal(slowVerdict, null)
  const slowElapsed = Date.now() - slowStart
  assert.deepEqual(slowReasons, ['timeout'])
  assert.ok(slowElapsed >= 45, `不该早于期限就回退（实测 ${slowElapsed}ms）`)
  assert.ok(slowElapsed < 1500, `不该真等 3 秒（实测 ${slowElapsed}ms）`)
  check(true, '内部期限可注入：timeoutMs=50 真的砍掉挂住的调用 → null + 短码 timeout',
    `实测 ${slowElapsed}ms，短码 ${slowReasons.join('/')}`)

  // (2) 同一条 catch 分支里，外部 abort 引起的 reject 必须记 client-abort（不是 timeout、
  //     更不是 iteration-threw）：两种取消共用合并 signal，靠 clientSignal 区分。
  const acSlow = new AbortController()
  const clientReasons = []
  const pendingClient = resolveTip(
    deps(hangUntilAbort, { signal: acSlow.signal, timeoutMs: 3000, onFailure: (r) => clientReasons.push(r) }),
    input,
  )
  setTimeout(() => acSlow.abort(), 20)
  assert.equal(await pendingClient, null)
  assert.deepEqual(clientReasons, ['client-abort'])
  check(true, '适配器用 reject 兑现外部取消 → 短码 client-abort（不是 iteration-threw / timeout）',
    '20ms 后 abort，实测短码 ' + clientReasons.join('/'))

  // (3) 另一条 abort 出口：流因 abort 干净结束、但没有 finish 块。修复前这里记 no-finish，
  //     读日志的人会以为是「流被截断」——其实真实原因是期限到了。
  const endOnAbort = {
    stream: (o) => (async function* () {
      await new Promise((resolve) => o.signal.addEventListener('abort', resolve, { once: true }))
      // 干净结束，一个 chunk 都不吐：没有 finish，也没有抛错
    })(),
  }
  const tailReasons = []
  const tailVerdict = await awaitWithRef(resolveTip(deps(endOnAbort, { timeoutMs: 50, onFailure: (r) => tailReasons.push(r) }), input))
  assert.equal(tailVerdict, null)
  assert.deepEqual(tailReasons, ['timeout'])
  check(true, 'abort 让流提前干净结束（无 finish）→ 短码 timeout，不是 no-finish', tailReasons.join('/'))

  // (4) 生产默认必须还是 3000ms：不传 timeoutMs 时同一个挂住的适配器不会在 100ms 内回退
  //     （接缝只给测试用，没人把它接到生产上）；随后用外部 signal 收尾，否则它会挂满 3 秒。
  const acDefault = new AbortController()
  const defaultReasons = []
  const pendingDefault = resolveTip(
    deps(hangUntilAbort, { signal: acDefault.signal, onFailure: (r) => defaultReasons.push(r) }),
    input,
  )
  const raced = await Promise.race([
    pendingDefault.then(() => 'settled'),
    new Promise((resolve) => setTimeout(() => resolve('still-pending'), 100)),
  ])
  assert.equal(raced, 'still-pending')
  acDefault.abort()
  assert.equal(await pendingDefault, null)
  assert.deepEqual(defaultReasons, ['client-abort'])
  // 源码级钉住那个数字：改它必须是有意识的（客户端 3.5 秒预算与 README 失败矩阵都引用了它）。
  // 「生产路径没有把接缝接出去」由下面路由组那条 100ms 不回退的断言覆盖（行为级，比 grep 可靠）。
  const hostSource = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'index.js'), 'utf8')
  assert.match(hostSource, /const TIP_TIMEOUT_MS = 3000\b/, '生产默认必须是 3000ms')
  check(true, '生产默认仍是 3000ms：不传 timeoutMs 时 100ms 内不回退（接缝只给测试用）',
    `100ms 时 ${raced}`)

  // 请求体的形状：provider / model / system / messages / reasoningEffort / maxTokens=60 / signal 齐全，
  // 且**不得**出现 purpose（该字段只接受 compaction / session-title，没有给插件留位置）。
  // messages 里的 content 是 ContentBlock[]（真实 llm 服务的请求消息按块数组解析），
  // 只带一个 text 块，内容正是 buildTipPrompt 的 user 串（发给模型的是数字与时间：状态计数、
  // HH:MM 与角度——原注释只写「状态数字与角度」，漏了时间，见 index.js 文件头那处同批修正）。
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

  // 重试有上限：两次都因「不认 reasoningEffort」收尾就到此为止，且采纳标准一点没松——
  // 第二次也必须 stop 才算数。
  let unsupportedCalls = 0
  const alwaysUnsupported = {
    stream: () => {
      unsupportedCalls += 1
      return (async function* () {
        yield { type: 'finish', reason: { kind: 'error', failure: { message: 'x', code: 'UNSUPPORTED_REASONING_EFFORT' } } }
      })()
    },
  }
  assert.equal(await resolveTip(deps(alwaysUnsupported), input), null)
  assert.equal(unsupportedCalls, 2)
  check(true, '两次都以 UNSUPPORTED_REASONING_EFFORT 收尾 → null，且只发两次调用（重试上限两次）',
    `stream 被调用 ${unsupportedCalls} 次`)

  // Finding 5：重试条件收窄成**显式白名单**，不再「任何 error 都重试」。表外的终止性失败
  // 一次都不重试——auth / 额度 / 限流失败换一份请求体照样失败，第二枪只是再发一次**真实且计费**
  // 的请求。修复前这里是 `attempt.errorCode !== undefined`，上面那个 BOOM 就会打第二枪。
  // 逐条钉住：每个码都只发一次调用（这也是本轮唯一能证明「收窄了」的断言）。
  const nonRetryable = ['ACCOUNT_SIGN_IN_REQUIRED', 'RATE_LIMIT', 'QUOTA_EXCEEDED', 'NO_ADAPTER', 'BOOM']
  const nonRetryCalls = []
  for (const code of nonRetryable) {
    let calls = 0
    const failing = {
      stream: () => {
        calls += 1
        return (async function* () {
          yield { type: 'finish', reason: { kind: 'error', failure: { message: 'x', code } } }
        })()
      },
    }
    assert.equal(await resolveTip(deps(failing), input), null)
    nonRetryCalls.push(calls)
  }
  assert.deepEqual(nonRetryCalls, nonRetryable.map(() => 1))
  check(true, '表外的 error 一律不重试（auth / 额度 / 限流 / 无适配器各只发一次调用，不白烧第二次请求）',
    nonRetryable.join(' / '))

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
  assert.equal(await resolveTip(noting(alwaysUnsupported), input), null)
  // 重试的两次尝试**只记最后那一条**：一次请求一行日志，不是一次尝试一行
  assert.deepEqual(reasons, ['error:UNSUPPORTED_REASONING_EFFORT'])
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

// ------------------------------------------------------------ 宿主路由契约（Finding 1）

group('宿主路由契约：200 + no-store、五条 204 出口、handler-threw 留痕')
{
  // 这一组为什么必须存在：`/pomodoro/tip` 是本功能**唯一对外可见**的表面，它的契约表就写在
  // README 的「失败矩阵」里。在这之前，状态码与响应头映射只有**仓库外**的两个临时 harness
  // 覆盖，其中一个还断言着修复前的 prompt 文本与「请求里没有 reasoningEffort」——也就是说
  // handleTip 被重写、整个功能坏掉，`node --run test` 照样全绿。
  //
  // 这里用假 ctx / 假 req / 假 res 装载**真实的** apply 与 handleTip（同一个加载器沿用了
  // 修复轮 5 那两条留痕断言）。覆盖不到的部分说清楚：假 res 只记录 writeHead 的状态与响应头、
  // end 的正文；真实 socket 的行为（客户端中途断开、res 已 destroy 后再写 204）仍靠实机验证。
  function loadTipRoute(get, { loggerThrows = false } = {}) {
    const routes = []
    const logs = []
    const child = {
      get,
      logger: {
        warn(message) {
          if (loggerThrows) throw new Error('logger broken')
          logs.push(message)
        },
      },
      effect: (fn) => fn(),
      webServer: { register: (route) => { routes.push(route); return () => {} } },
    }
    // 语义与真 cordis 对齐：inject 的回调拿到的就是注入了服务的 child ctx。
    apply({ inject: (_deps, callback) => callback(child) })
    return { route: routes.at(-1), logs }
  }

  /** 假 llm：数得清调用次数，默认吐一句能过校验的正文并以 stop 收尾。 */
  function fakeLlm(chunks = [{ type: 'text-delta', text: '去接一杯水吧' }, { type: 'finish', reason: { kind: 'stop' } }]) {
    const calls = []
    return {
      calls,
      stream(request) {
        calls.push(request)
        return (async function* () { for (const chunk of chunks) yield chunk })()
      },
    }
  }

  /** 一份标准假 ctx.get：llm 与 agentDefaultModel 都在；overrides 里显式给 undefined 就是缺席。 */
  function services(overrides = {}) {
    const table = {
      llm: fakeLlm(),
      agentDefaultModel: { currentSelection: () => ({ provider: 'p', model: 'm' }) },
      ...overrides,
    }
    // 返回的 llm 是**生效的那个**（overrides 换掉它时也要跟着换），调用次数断言才落在真身上。
    return { llm: table.llm, get: (name) => table[name] }
  }

  const GOOD_QUERY = 'phase=short&round=3&done=7&angle=water&lang=zh'
  const makeReq = (search, headers = {}) => ({
    headers: { host: 'localhost:52341', ...headers },
    url: `/pomodoro/tip?${search}`,
    on() {},
  })

  /** 假 res：writeHead 的状态与响应头、end 的正文都记下来；body 为 undefined 即「空体」。 */
  function fakeRes() {
    const res = {
      status: null,
      headers: null,
      headersSent: false,
      body: undefined,
      writeHead(status, headers) { res.status = status; res.headers = headers ?? null; res.headersSent = true },
      end(body) { res.body = body },
    }
    return res
  }
  async function call(route, req) {
    const res = fakeRes()
    await route.handler(req, res)
    return res
  }

  const realWarn = console.warn
  const warned = []
  // console.warn 是 logTipFailure 在本 profile 里唯一确认有落点的出口；测它就要接管它，
  // 免得测试输出里混进一行看起来像失败的 warn。末尾 finally 还原。
  console.warn = (message) => warned.push(message)
  try {
    // ---- 1. 正常路径：200 + {"text":…} + cache-control: no-store ----
    const ok = services()
    const okRoute = loadTipRoute(ok.get)
    assert.equal(okRoute.route.path, '/pomodoro/tip')
    assert.equal(okRoute.route.kind, 'exact')
    const res200 = await call(okRoute.route, makeReq(GOOD_QUERY))
    assert.equal(res200.status, 200)
    assert.equal(typeof res200.body, 'string')
    assert.deepEqual(JSON.parse(res200.body), { text: '去接一杯水吧' })
    assert.equal(res200.headers['cache-control'], 'no-store')
    assert.equal(res200.headers['content-type'], 'application/json; charset=utf-8')
    assert.equal(ok.llm.calls.length, 1)
    assert.equal(okRoute.logs.length, 0)
    assert.equal(warned.length, 0)
    check(true, '正常路径：200 + {"text":…} + cache-control: no-store，且不写日志（本功能唯一的对外成功面）',
      `${res200.status} ${res200.body} / ${res200.headers['cache-control']}`)

    // ---- 2. 204 出口之一：跨站 Origin（连 query 都不看、更不碰模型）----
    const cross = services()
    const crossRoute = loadTipRoute(cross.get)
    const resCross = await call(crossRoute.route, makeReq(GOOD_QUERY, { origin: 'http://evil.example' }))
    assert.equal(resCross.status, 204)
    assert.equal(resCross.body, undefined)
    assert.equal(resCross.headers['cache-control'], 'no-store')
    assert.equal(resCross.headers['content-type'], undefined)
    assert.equal(cross.llm.calls.length, 0)
    assert.equal(crossRoute.logs.length, 0)
    check(true, '跨站 Origin → 204 空体 + no-store，不碰模型、不写日志（调用方自己的问题）',
      `${resCross.status} / 模型调用 ${cross.llm.calls.length} 次`)

    // ---- 3. 204 出口之二：非法 query（round / done 缺席、空串、非数字、非整数、负数）----
    //         Finding 4 的两条（1.5 / -3）与溢出（Infinity）都在这里，逐条都是 204 + 空体，
    //         而且**一次模型调用都不该发生**——这是「不替调用方圆场」的严格策略的本体。
    const badQueries = [
      ['round=abc&done=7', 'round 非数字'],
      ['round=abc', 'round 非数字且缺 done'],
      ['round=3', '缺 done'],
      ['round=3&done=', 'done 空串'],
      ['round=3&done=abc', 'done 非数字'],
      ['round=1.5&done=7', 'round 小数（Finding 4）'],
      ['round=-3&done=7', 'round 负数（Finding 4）'],
      ['round=3&done=-1', 'done 负数（Finding 4）'],
      ['round=3&done=1e999', 'done 溢出成 Infinity'],
      ['round=3&done=99999999999999999999', 'done 超出安全整数范围'],
    ]
    const badVerdicts = []
    for (const [search] of badQueries) {
      const s = services()
      const res = await call(loadTipRoute(s.get).route, makeReq(search))
      assert.equal(res.status, 204)
      assert.equal(res.body, undefined)
      assert.equal(res.headers['cache-control'], 'no-store')
      assert.equal(s.llm.calls.length, 0)
      badVerdicts.push(res.status)
    }
    check(true, '非法 query（缺席 / 空串 / 非数字 / 小数 / 负数 / 溢出）→ 每个都是 204 空体，一次模型调用都不发生',
      badQueries.map(([q, why]) => `${q}（${why}）`).join('；'))

    // ---- 4. 204 出口之三：拿不到 llm 服务（第一道降级，早于任何超时与 I/O）----
    const noLlm = services({ llm: undefined })
    const noLlmRoute = loadTipRoute(noLlm.get)
    const resNoLlm = await call(noLlmRoute.route, makeReq(GOOD_QUERY))
    assert.equal(resNoLlm.status, 204)
    assert.equal(resNoLlm.body, undefined)
    assert.equal(resNoLlm.headers['cache-control'], 'no-store')
    assert.equal(noLlmRoute.logs.length, 1)
    assert.ok(noLlmRoute.logs[0].includes('no-service:llm'))
    assert.equal(noLlmRoute.logs[0], warned.at(-1))
    check(true, 'llm 服务缺席 → 204 空体 + 日志 no-service:llm（两个日志出口同一行）', noLlmRoute.logs[0])

    // ---- 5. 204 出口之四：没配默认模型（服务缺席，或 currentSelection() 返回 null）----
    for (const [label, overrides] of [
      ['agentDefaultModel 缺席', { agentDefaultModel: undefined }],
      ['currentSelection() 返回 null', { agentDefaultModel: { currentSelection: () => null } }],
    ]) {
      const s = services(overrides)
      const route = loadTipRoute(s.get)
      const res = await call(route.route, makeReq(GOOD_QUERY))
      assert.equal(res.status, 204)
      assert.equal(res.body, undefined)
      assert.equal(route.logs.length, 1)
      assert.ok(route.logs[0].includes('no-service:agentDefaultModel'))
      assert.equal(s.llm.calls.length, 0)
    }
    check(true, '默认模型缺席（服务 undefined 或 currentSelection() 为 null）→ 204 + no-service:agentDefaultModel，不碰模型',
      'profile 没配默认模型是最可能的静默失败，这条留痕就是为它写的')

    // ---- 6. 204 出口之五：resolveTip → null（输入合法，句子没生成出来）----
    //         这里挑「流没有终止块」当代表；resolveTip 的其余失败出口已在上一组逐条覆盖。
    //         状态码与日志短码必须在**同一条**路径上对得上。
    const broken = services({ llm: fakeLlm([]) })
    const brokenRoute = loadTipRoute(broken.get)
    const resBroken = await call(brokenRoute.route, makeReq(GOOD_QUERY))
    assert.equal(resBroken.status, 204)
    assert.equal(resBroken.body, undefined)
    assert.equal(resBroken.headers['cache-control'], 'no-store')
    assert.equal(broken.llm.calls.length, 1)
    assert.equal(brokenRoute.logs.length, 1)
    assert.ok(brokenRoute.logs[0].includes('no-finish'))
    check(true, 'resolveTip 返回 null（流没有终止块）→ 204 空体 + 日志 no-finish（200 之外的唯一出口）',
      brokenRoute.logs[0])

    // ---- 8. 真实 handler 的期限与「客户端断开」接线 ----
    //     llm 挂住直到 signal abort（适配器用 reject 兑现 signal，见 Finding 2 的现场）。
    //     两件事一起钉：① 生产路径没把 timeoutMs 接缝接出去——真实 handler 100ms 内绝不回退；
    //     ② req 的 'close' 真的接到了 controller 上——断开后立刻 204 + client-abort，而不是挂满 3 秒。
    const hangCalls = []
    const hangLlm = {
      stream(request) {
        hangCalls.push(request)
        return (async function* () {
          await new Promise((resolve, reject) => {
            if (request.signal.aborted) reject(new Error('aborted'))
            else request.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
          })
        })()
      },
    }
    let closeHandler = null
    const hangReq = {
      headers: { host: 'localhost:52341' },
      url: `/pomodoro/tip?${GOOD_QUERY}`,
      on(event, listener) { if (event === 'close') closeHandler = listener },
    }
    const hangSvc = services({ llm: hangLlm })
    const hangRoute = loadTipRoute(hangSvc.get)
    const hangRes = fakeRes()
    const pendingRoute = hangRoute.route.handler(hangReq, hangRes)
    const stillPending = await Promise.race([
      pendingRoute.then(() => 'settled'),
      new Promise((resolve) => setTimeout(() => resolve('still-pending'), 100)),
    ])
    assert.equal(stillPending, 'still-pending')
    assert.equal(typeof closeHandler, 'function')
    assert.equal(hangCalls.length, 1)
    closeHandler() // 客户端断开（切走 / 关页面）
    await pendingRoute
    assert.equal(hangRes.status, 204)
    assert.equal(hangRes.body, undefined)
    assert.equal(hangRoute.logs.length, 1)
    assert.ok(hangRoute.logs[0].includes('client-abort'))
    check(true, '真实 handler：100ms 内不回退（生产不接 timeoutMs 接缝），req close 后立刻 204 + client-abort',
      `100ms 时 ${stillPending}；断开后 ${hangRoute.logs[0]}`)

    // ---- 9. handler-threw：resolveTip 之外的未预料异常也必须有痕 ----
    //     本路由对外只有 200 与 204 两种结果，**204 与「插件坏了 / 路由没注册」完全同形**，
    //     唯一的分辨手段就是日志里那一行短码。修复前的 catch 是 `if (!res.headersSent)
    //     noContent(res)`：抛错的 ctx.get / currentSelection()、将来在 writeHead 之前引入的
    //     回归，全都静默 204，读文件头那句排查指引的人只会去查「路由是不是没注册」。
    const boomGet = loadTipRoute(() => { throw new Error('ctx.get 炸了') })
    assert.equal(boomGet.route.path, '/pomodoro/tip')
    const resThrow = await call(boomGet.route, makeReq(GOOD_QUERY))
    assert.equal(resThrow.status, 204)
    assert.equal(resThrow.body, undefined)
    assert.equal(boomGet.logs.length, 1)
    assert.ok(boomGet.logs[0].includes('handler-threw'))
    assert.equal(boomGet.logs[0], warned.at(-1))
    check(true, 'handler 在 resolveTip 之外抛错 → 204 空体 + 一行短码（修复前完全静默）', boomGet.logs[0])

    // 换一个抛点（currentSelection()），并让两个日志出口同时坏掉 → 出口仍是 204 空体。
    // 留痕只能「加一行」，不许改变状态决定，也不许把异常泄成 500。
    const badSelection = loadTipRoute(
      (name) => (name === 'llm' ? {} : { currentSelection() { throw new Error('selection 炸了') } }),
      { loggerThrows: true },
    )
    console.warn = () => { throw new Error('console.warn broken') }
    const resBrokenLog = await call(badSelection.route, makeReq(GOOD_QUERY))
    assert.equal(resBrokenLog.status, 204)
    assert.equal(resBrokenLog.body, undefined)
    assert.equal(badSelection.logs.length, 0)
    check(true, 'currentSelection() 抛错且两个日志出口都坏掉 → 仍然 204 空体（留痕不参与状态决定）',
      'logger.warn 与 console.warn 都抛')
  } finally {
    console.warn = realWarn
  }
}

// ------------------------------------------------------------ 客户端角度轮换（Task 5）

// client.js 是浏览器 bundle（`window.__ModuleLoader__.load(...)`）、不能 import，
// 所以沿用 test/model.test.mjs 的**标记切片法**：把 `// --- tip-angle:start ---` 与
// `// --- tip-angle:end ---` 之间的源码切出来求值。切片里必须同时含**客户端自己的角度列表**
// 与 nextAngle —— 少了列表，nextAngle 跑起来会抛 ReferenceError。宿主那份拿不到，也不该拿。
const clientSource = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'client.js'), 'utf8')

function loadClientTipAngle() {
  const start = clientSource.indexOf('// --- tip-angle:start ---')
  const end = clientSource.indexOf('// --- tip-angle:end ---', start)
  if (start < 0 || end < 0) throw new Error('切片失败: // --- tip-angle:start --- .. // --- tip-angle:end ---')
  const slice = clientSource.slice(start, end)
  return new Function(`${slice}\nreturn { TIP_ANGLES, nextAngle }`)()
}

group('客户端角度轮换 nextAngle（标记切片，与宿主那份互不依赖）')
{
  // 这里的 TIP_ANGLES 是 client.js 里那一份；HOST_ANGLES 才是从 index.js 导入的宿主副本。
  const { TIP_ANGLES, nextAngle } = loadClientTipAngle()

  // 轮换一圈回到起点，且每次都变
  let a = TIP_ANGLES[0]
  const seen = [a]
  for (let i = 0; i < TIP_ANGLES.length - 1; i += 1) { a = nextAngle(a); seen.push(a) }
  assert.equal(new Set(seen).size, TIP_ANGLES.length)
  assert.equal(nextAngle(TIP_ANGLES[TIP_ANGLES.length - 1]), TIP_ANGLES[0])
  check(true, '轮换一圈恰好走遍每个角度并回到起点', `${seen.join(' → ')} → ${TIP_ANGLES[0]}`)

  // 未知值不抛，退到第一个。null 是「本地还没存过角度」的取值（readAngle 的返回值），
  // 所以首次休息也从 TIP_ANGLES[0] 起轮。
  assert.equal(nextAngle('nope'), TIP_ANGLES[0])
  assert.equal(nextAngle(null), TIP_ANGLES[0])
  check(true, '未知值与空值都不抛，退到第一个角度（首次休息即从它起轮）',
    `'nope' / null → ${TIP_ANGLES[0]}`)

  // 客户端副本必须与宿主半那份一致（漂移会让新角度永远不被使用）
  assert.deepEqual(TIP_ANGLES, HOST_ANGLES)
  check(true, '客户端副本与宿主 TIP_ANGLES 逐项一致（漂移会让新角度永远不被使用）',
    TIP_ANGLES.join(' / '))
}

// ------------------------------------------------------------ 迷你圆盘的按键归属（修复轮 1）

// 折叠态根节点是 role="button"，小圆点（也是真实 button）嵌在它里面：Enter/空格在小圆点上按下时
// 会冒泡到根节点的 onKeyDown。那里不加区分地 preventDefault()，被取消的正是小圆点**原生的点击**
// —— 键盘用户按 Enter 想展开气泡，结果展开的是整个面板，气泡反而回不来（鼠标路径因为
// onPointerDown 截住了冒泡而幸免）。判定已提成 miniRootKeyDown，这里用同一套标记切片法钉住它。
//
// 覆盖范围要说清楚：这里钉的是**判定本身**（什么情况下接手这次按键），不是组件里"把哪个回调
// 传进去"的接线 —— 后者需要真实渲染，仓库里的切片法到不了，由未入库的临时冒烟测试覆盖
// （路径与结果记在 task-5-report.md 的修复轮 1 一节）。
function loadClientMiniRootKeyDown() {
  const start = clientSource.indexOf('// --- tip-key:start ---')
  const end = clientSource.indexOf('// --- tip-key:end ---', start)
  if (start < 0 || end < 0) throw new Error('切片失败: // --- tip-key:start --- .. // --- tip-key:end ---')
  const slice = clientSource.slice(start, end)
  return new Function(`${slice}\nreturn { miniRootKeyDown }`)()
}

group('迷你圆盘的按键归属 miniRootKeyDown（标记切片）')
{
  const { miniRootKeyDown } = loadClientMiniRootKeyDown()
  const root = { role: 'button' }
  const dot = { role: 'button' }
  const makeEvent = (target, key) => ({
    target,
    currentTarget: root,
    key,
    defaultPrevented: false,
    preventDefault() { this.defaultPrevented = true },
  })

  // 1) 按键落在根节点本身：展开面板并 preventDefault —— 原来就是这条路径，行为不变。
  let expanded = 0
  const onRoot = makeEvent(root, 'Enter')
  assert.equal(miniRootKeyDown(onRoot, () => { expanded += 1 }), true)
  assert.equal(onRoot.defaultPrevented, true)
  assert.equal(expanded, 1)
  check(true, '焦点在根节点本身时 Enter 展开面板（原行为不变）',
    `expanded=${expanded}，preventDefault=${onRoot.defaultPrevented}`)

  // 2) 按键落在小圆点（target 是子节点）：一律放行 —— 不 preventDefault、不展开面板，
  //    好让小圆点自己的原生点击（→ 展开气泡）照常发生。修复前这里会把面板展开。
  for (const key of ['Enter', ' ']) {
    let calls = 0
    const onDot = makeEvent(dot, key)
    assert.equal(miniRootKeyDown(onDot, () => { calls += 1 }), false)
    assert.equal(onDot.defaultPrevented, false)
    assert.equal(calls, 0)
  }
  check(true, '焦点在小圆点上时 Enter/空格一律放行（不再抢走它的原生点击、不再展开面板）',
    'target=小圆点 / currentTarget=根节点 → 返回 false 且 preventDefault 未被调用')

  // 3) 其它按键一概不管（哪怕落在根节点上）：不 preventDefault、不展开。
  const onOther = makeEvent(root, 'a')
  assert.equal(miniRootKeyDown(onOther, () => { throw new Error('不该被调用') }), false)
  assert.equal(onOther.defaultPrevented, false)
  check(true, '其它按键一概不管（不 preventDefault、不展开）', "key='a'")
}

// ------------------------------------------------------------ ✕ 的键盘激活判定（修复轮 6 / Finding 6）

// 键盘激活 ✕ 收成小圆点后，被激活的按钮随气泡一起卸载，焦点掉回 document.body；剩下唯一的控件
// 是那个 30px 小圆点，键盘用户得从文档开头重新 Tab 一整圈——在一个 README 明说「键盘可达」的
// 插件里这是退步。修复只在**键盘激活**时把焦点交给小圆点（鼠标点击不动焦点，与「不抢输入焦点」
// 一致），判定提成 tipCloseFromKeyboard 用同一套标记切片法钉住。
//
// 覆盖范围：同 miniRootKeyDown，这里钉的是**判定本身**（detail === 0 才算键盘），不是组件里
// 「谁调它、把 ref 接到哪个节点」的接线——后者要真实渲染，由未入库的临时冒烟脚本覆盖（见 README
// 「验证状态」；本轮把那个脚本的 ✕ 用例也补上了键盘路径，结果记在 final-fix-report.md）。
function loadClientTipFocus() {
  const start = clientSource.indexOf('// --- tip-focus:start ---')
  const end = clientSource.indexOf('// --- tip-focus:end ---', start)
  if (start < 0 || end < 0) throw new Error('切片失败: // --- tip-focus:start --- .. // --- tip-focus:end ---')
  const slice = clientSource.slice(start, end)
  return new Function(`${slice}\nreturn { tipCloseFromKeyboard }`)()
}

group('气泡 ✕ 的键盘激活判定 tipCloseFromKeyboard（标记切片）')
{
  const { tipCloseFromKeyboard } = loadClientTipFocus()

  // 键盘（Enter / 空格）与辅助技术合成的 click：detail === 0 → 收起后把焦点交给小圆点
  assert.equal(tipCloseFromKeyboard({ detail: 0 }), true)
  check(true, '键盘激活的 click（detail === 0）→ 收起后把焦点交给小圆点',
    'Enter / 空格在 button 上的 click 都是 detail 0')

  // 真实指针点击：detail 是点击计数（≥1）→ 不动焦点，焦点留在用户原来编辑的地方
  assert.equal(tipCloseFromKeyboard({ detail: 1 }), false)
  assert.equal(tipCloseFromKeyboard({ detail: 2 }), false)
  check(true, '鼠标点击（detail ≥ 1）→ 不动焦点（「不抢输入焦点」在这一侧继续成立）',
    'detail 1 / 2 → false')

  // 拿不准就不动焦点：没有 detail 字段的合成事件按「不是键盘」处理，宁可少一次搬运，也不误抢
  assert.equal(tipCloseFromKeyboard({}), false)
  assert.equal(tipCloseFromKeyboard(undefined), false)
  check(true, 'detail 缺失 / 事件对象缺失 → 不动焦点（不猜）', '{} / undefined → false')
}

// ------------------------------------------------------------ round 参数：0 钳成 1（修复轮 6 / Finding 3）

// cycleFocus 为 0 的四种状态（开机、长休息结束回到专注、长休息中途切到专注、清除统计之后）
// 都能靠**点一下「短休息」胶囊**到达。宿主接受 0（0 是合法整数，不会 204），于是 prompt 会真写出
// 「本轮第 0 个番茄」——假前提。宿主那边的严格策略有意不放松（见 index.js 的 parseCount），
// 所以钳制在客户端：tipRoundParam。这里钉住钳制函数本身，并反向钉住「为什么必须在客户端钳」。
function loadClientTipRound() {
  const start = clientSource.indexOf('// --- tip-round:start ---')
  const end = clientSource.indexOf('// --- tip-round:end ---', start)
  if (start < 0 || end < 0) throw new Error('切片失败: // --- tip-round:start --- .. // --- tip-round:end ---')
  const slice = clientSource.slice(start, end)
  return new Function(`${slice}\nreturn { tipRoundParam }`)()
}

group('客户端 round 参数 tipRoundParam：0 钳成 1（标记切片）')
{
  const { tipRoundParam } = loadClientTipRound()

  // 四种 0 状态都走同一个函数，所以一条断言就够：0 → '1'
  assert.equal(tipRoundParam(0), '1')
  check(true, 'cycleFocus=0（开机 / 长休息结束回专注 / 长休息中途切专注 / 清除统计后）→ round=1',
    '0 → "1"（修复前发的是 "0"）')

  // 非 0 的取值原样透传（修复不许把正常的轮次也改了）
  assert.equal(tipRoundParam(1), '1')
  assert.equal(tipRoundParam(2), '2')
  assert.equal(tipRoundParam(4), '4')
  check(true, '正常的周期位置原样透传（1 / 2 / 4 → "1" / "2" / "4"）', '只有 0 被钳')

  // 反向钉住「为什么必须在客户端钳」：宿主对 0 是接受的，prompt 会照写「本轮第 0 个番茄」。
  // 也就是说宿主不会替客户端圆场 —— 这两条断言一起构成「协商好的分工」。
  const zero = buildTipPrompt({ phase: 'short', round: 0, done: 0, now: '09:00', angle: 'water', lang: 'zh' })
  const clamped = buildTipPrompt({ phase: 'short', round: Number(tipRoundParam(0)), done: 0, now: '09:00', angle: 'water', lang: 'zh' })
  assert.ok(zero.user.includes('本轮第 0 个番茄'), zero.user)
  assert.ok(clamped.user.includes('本轮第 1 个番茄'), clamped.user)
  check(true, '宿主不替客户端圆场：round=0 会真写进 prompt（「本轮第 0 个番茄」），钳成 1 才是对的',
    'zero → ' + zero.user.slice(0, 22) + '…')
}

// ---------------------------------------------------------------- 汇总

console.log(`\n${failures === 0 ? '全部通过' : '存在失败'}：${checks - failures}/${checks} 项通过`)
process.exit(failures === 0 ? 0 : 1)
