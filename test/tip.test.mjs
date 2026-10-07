// 休息提醒语的纯逻辑测试（宿主半 index.js 的具名导出）。
//
//   node test/tip.test.mjs
//
// 这里只测这类无副作用的纯函数：prompt 构造、输出清洗与长度校验。
// HTTP 路由与模型调用是薄适配层，不进这里。
// 做法与 test/model.test.mjs 一致：一个 check() 帮手 + 末尾按失败数决定退出码，
// 方便后续任务顺序追加。
import assert from 'node:assert/strict'

import { buildTipPrompt, sanitizeTip, TIP_ANGLES, validateTip } from '../index.js'

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
  // 英文用词数：必须与 Task 2 校验器的 3–12 词一致，否则生成的句子会被自己的校验器拒掉
  assert.ok(/words/i.test(en.system) && !/characters/i.test(en.system))
  check(true, '英文 user 全英文且含 distance 子句，system 用"词"约束长度', en.user)

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

  // 英文按词数：3–12 词
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

group('英文按词数 3–12')
{
  // 边界两侧各钉一个：3 词与 12 词通过，2 词与 13 词拒绝
  assert.equal(validateTip('go drink water', 'en'), true)
  assert.equal(validateTip(Array.from({ length: 12 }, () => 'walk').join(' '), 'en'), true)
  assert.equal(validateTip('go walk', 'en'), false)
  assert.equal(validateTip(Array.from({ length: 13 }, () => 'walk').join(' '), 'en'), false)
  check(true, '英文边界：3 词与 12 词过，2 词与 13 词拒', '3 / 12 → true，2 / 13 → false')

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

// ---------------------------------------------------------------- 汇总

console.log(`\n${failures === 0 ? '全部通过' : '存在失败'}：${checks - failures}/${checks} 项通过`)
process.exit(failures === 0 ? 0 : 1)
