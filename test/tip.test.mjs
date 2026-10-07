// 休息提醒语的纯逻辑测试（宿主半 index.js 的具名导出）。
//
//   node test/tip.test.mjs
//
// 这里只测「构句」这类无副作用的纯函数：prompt 构造、清洗、长度校验。
// HTTP 路由与模型调用是薄适配层，不进这里。做法与 test/model.test.mjs 一致：
// 一个 check() 帮手 + 末尾按失败数决定退出码，方便后续任务顺序追加。
import assert from 'node:assert/strict'

import { buildTipPrompt, TIP_ANGLES } from '../index.js'

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

  // 断言 2：中文请求的 system 里必须含"只输出"和字数约束，user 里必须含状态数字
  const zh = buildTipPrompt({ phase: 'short', round: 3, done: 7, angle: 'water', lang: 'zh' })
  assert.ok(zh.system.includes('只输出'))
  assert.ok(zh.user.includes('3') && zh.user.includes('7'))
  assert.ok(zh.user.includes('水'))          // water 角度映射到"喝水"
  check(true, '中文 system 约束输出形状，user 带状态数字与角度子句',
    `${zh.system.length} 字约束 / ${zh.user}`)

  // 断言 3：英文请求的 user 不含中文字符
  const en = buildTipPrompt({ phase: 'long', round: 4, done: 7, angle: 'distance', lang: 'en' })
  assert.ok(!/[\u4e00-\u9fff]/.test(en.user))
  assert.ok(en.user.toLowerCase().includes('distance'))
  check(true, '英文 user 全英文且含 distance 子句', en.user)

  // 断言 4：五个角度都能映射出非空子句，且互不相同
  const clauses = TIP_ANGLES.map((a) => buildTipPrompt({ phase: 'short', round: 1, done: 1, angle: a, lang: 'zh' }).user)
  assert.equal(new Set(clauses).size, TIP_ANGLES.length)
  check(true, '五个角度映射出五条互不相同的子句', `${clauses.length} 条`)

  // 断言 5：未知角度不抛异常，退到第一个角度
  assert.doesNotThrow(() => buildTipPrompt({ phase: 'short', round: 1, done: 1, angle: 'nope', lang: 'zh' }))
  check(true, '未知角度不抛异常，退到 TIP_ANGLES[0]')
}

// ---------------------------------------------------------------- 汇总

console.log(`\n${failures === 0 ? '全部通过' : '存在失败'}：${checks - failures}/${checks} 项通过`)
process.exit(failures === 0 ? 0 : 1)
