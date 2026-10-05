// 番茄时钟的状态机测试。
//
//   node test/model.test.mjs
//
// 做法：把「纯计时模型」从 client.js 里按标记切出来——常量 + 纯函数 + 提示音 +
// createModel，**不含任何组件、React 或 DOM 代码**——注入可控时钟和内存版
// localStorage，然后像真实使用那样驱动它：开始、走时、切换阶段、跳过、刷新。
//
// 覆盖两类语义，它们都是踩过坑的地方：
//   1. 各阶段的续跑点（stash）：切走再切回要续上，且六个清理出口一个都不能少；
//   2. 长休息周期：统计计数（completedFocus）与周期位置（cycleFocus）必须解耦，
//      否则跳过和补算会把周期冻住，长休息永远不可达。
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const source = readFileSync(join(here, '..', 'client.js'), 'utf8')

function slice(from, to) {
  const start = source.indexOf(from)
  const end = source.indexOf(to, start)
  if (start < 0 || end < 0) throw new Error(`切片失败: ${from} .. ${to}`)
  return source.slice(start, end)
}

const constants = slice("const NS = 'pomodoro'", 'const EN = {')
const helpers = slice('const clamp = (value, min, max)', '// ---- 部件位置状态')
const audioBlock = slice('// ---- 阶段结束提示音', '// ---- 计时模型')
const modelBlock = slice('function createModel()', '// ---- 图标')

// 切出来的必须是纯逻辑：混进渲染代码说明标记变了，测试会测到错的东西。
for (const forbidden of ['React', 'document', 'createElement', 'CLASS.']) {
  for (const [name, text] of [['constants', constants], ['helpers', helpers], ['modelBlock', modelBlock]]) {
    if (text.includes(forbidden)) throw new Error(`切片 ${name} 里混入了渲染代码: ${forbidden}`)
  }
}

const bundle = `${constants}\n${helpers}\n${audioBlock}\n${modelBlock}
return { createModel, DEFAULT_SETTINGS, PHASES }`

// 可控时钟（Date 作为参数注入以遮蔽全局）与内存版 localStorage。
let clock = 1_700_000_000_000
const store = new Map()
const api = new Function('window', 'console', 'Date', bundle)(
  {
    localStorage: {
      getItem: (key) => (store.has(key) ? store.get(key) : null),
      setItem: (key, value) => store.set(key, value),
      removeItem: (key) => store.delete(key),
    },
  },
  console,
  { now: () => clock },
)

const MIN = 60000
const ZH = { focus: '专注', short: '短休息', long: '长休息' }
const zh = (phase) => ZH[phase]
const advance = (ms) => { clock += ms }
const fresh = () => { store.clear(); return api.createModel() }

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

// ---------------------------------------------------------------- 基础

group('基础')
{
  const m = fresh()
  const s = m.getSnapshot()
  check(s.phase === 'focus' && s.text === '25:00' && !s.running, '初始为 25:00 的专注且未运行', `${zh(s.phase)} ${s.text}`)
  check(s.nextPhase === 'short', '初始预告下一个阶段为短休息', String(s.nextPhase))
}

// ------------------------------------------------- 切换阶段与续跑点（stash）

group('切走再切回：进度必须续上')
{
  const m = fresh()
  m.toggle()
  advance(12.5 * MIN)
  m.tick()
  check(m.getSnapshot().text === '12:30', '专注已走到 12:30', m.getSnapshot().text)

  m.switchPhase('short')
  check(m.getSnapshot().phase === 'short' && m.getSnapshot().text === '05:00', '切到短休息显示完整 5 分钟', m.getSnapshot().text)
  check(!m.getSnapshot().running, '切过去是暂停态，没有自动开跑')

  m.switchPhase('focus')
  check(m.getSnapshot().text === '12:30', '续上了 12:30 而不是从 25:00 重来', m.getSnapshot().text)
  check(!m.getSnapshot().running, '续上后仍是暂停态，需要按「开始」')

  m.toggle()
  advance(30 * 1000)
  m.tick()
  check(m.getSnapshot().text === '12:00', '从 12:30 继续走（半分钟后 12:00）', m.getSnapshot().text)
}

group('续跑点的六个清理出口')
{
  const m = fresh()
  m.switchPhase('short')
  m.switchPhase('focus')
  check(m.getSnapshot().text === '25:00', '完整未动的阶段不留续跑点', m.getSnapshot().text)
}
{
  const m = fresh()
  m.toggle(); advance(6 * MIN); m.tick()
  m.switchPhase('short'); m.switchPhase('focus')
  check(m.getSnapshot().text === '19:00', '走过一部分的阶段留下续跑点', m.getSnapshot().text)
  m.toggle(); advance(19 * MIN); m.tick()
  check(m.getSnapshot().phase === 'short', '专注走完，自动进入短休息', zh(m.getSnapshot().phase))
  m.switchPhase('focus')
  check(m.getSnapshot().text === '25:00', '【出口 1/2】走完的阶段与其后继都不再留续跑点', m.getSnapshot().text)
}
{
  const m = fresh()
  m.switchPhase('short'); m.toggle(); advance(2 * MIN); m.tick()
  m.switchPhase('focus'); m.switchPhase('short')
  check(m.getSnapshot().text === '03:00', '短休息续上了 3:00', m.getSnapshot().text)
  m.toggle(); advance(3 * MIN); m.tick()
  m.switchPhase('short')
  check(m.getSnapshot().text === '05:00', '休息跑完后再次进入是完整 5:00，不是残留的 3:00', m.getSnapshot().text)
}
{
  const m = fresh()
  m.toggle(); advance(5 * MIN); m.tick()
  m.switchPhase('short'); m.switchPhase('focus')
  check(m.getSnapshot().text === '20:00', '续跑点为 20:00', m.getSnapshot().text)
  m.reset()
  check(m.getSnapshot().text === '25:00', '【出口 3】重开后是完整 25:00', m.getSnapshot().text)
  m.switchPhase('short'); m.switchPhase('focus')
  check(m.getSnapshot().text === '25:00', '重开已清掉旧续跑点', m.getSnapshot().text)
}
{
  const m = fresh()
  m.toggle(); advance(4 * MIN); m.tick()
  m.switchPhase('short')
  m.resetAll()
  check(m.getSnapshot().phase === 'focus' && m.getSnapshot().text === '25:00', '【出口 4】清除统计后回到全新专注', m.getSnapshot().text)
  m.switchPhase('short'); m.switchPhase('focus')
  check(m.getSnapshot().text === '25:00', '清除统计作废全部续跑点', m.getSnapshot().text)
}
{
  const m = fresh()
  m.toggle(); advance(20 * MIN); m.tick()
  m.switchPhase('short')
  m.updateSettings({ focusMinutes: 3 })
  m.switchPhase('focus')
  check(m.getSnapshot().text === '03:00', '【出口 5】时长改短后续跑点被夹到新上限', m.getSnapshot().text)
}

group('续跑点随刷新恢复')
{
  const m = fresh()
  m.toggle(); advance(7 * MIN); m.tick()
  m.switchPhase('short')
  const revived = api.createModel()
  check(revived.getSnapshot().phase === 'short', '刷新后仍在短休息阶段', zh(revived.getSnapshot().phase))
  revived.switchPhase('focus')
  check(revived.getSnapshot().text === '18:00', '刷新后续跑点还在：18:00', revived.getSnapshot().text)
}

// ------------------------------------------------------- 跳过与长休息周期

group('跳过遵循长休息周期')
{
  const m = fresh()
  m.updateSettings({ longEvery: 1 })
  m.skip()
  check(m.getSnapshot().phase === 'long', 'longEvery=1 时跳过专注 → 长休息', zh(m.getSnapshot().phase))
}
{
  const m = fresh()
  const trail = []
  for (let i = 0; i < 8; i += 1) { m.skip(); trail.push(zh(m.getSnapshot().phase)) }
  check(trail.includes('长休息'), '默认设置下连续跳过也能到达长休息', trail.join(' → '))
  check(trail.indexOf('长休息') === 6, '第 4 个专注结束（第 7 次跳过）进入长休息', `第 ${trail.indexOf('长休息') + 1} 次`)
}
{
  const m = fresh()
  for (let i = 0; i < 7; i += 1) m.skip()
  check(m.getSnapshot().completedFocus === 0, '跳过不虚报番茄数（completedFocus 仍为 0）', String(m.getSnapshot().completedFocus))
  check(m.getSnapshot().cycleFocus === 0, '长休息后周期位置归零', String(m.getSnapshot().cycleFocus))
}
{
  const m = fresh()
  m.toggle(); advance(25 * MIN); m.tick()
  check(m.getSnapshot().phase === 'short' && m.getSnapshot().completedFocus === 1, '自然走完仍计数并遵循周期', `${zh(m.getSnapshot().phase)} / ${m.getSnapshot().completedFocus}`)
  for (let i = 0; i < 3; i += 1) {
    m.skip(); m.toggle(); advance(25 * MIN); m.tick()
  }
  check(m.getSnapshot().phase === 'long', '第 4 个专注自然走完 → 长休息', zh(m.getSnapshot().phase))
  check(m.getSnapshot().completedFocus === 4, 'completedFocus = 4', String(m.getSnapshot().completedFocus))
}

group('补算（页面关闭期间走完的阶段）')
{
  const m = fresh()
  m.updateSettings({ longEvery: 1 })
  m.toggle()
  advance(26 * MIN)
  const revived = api.createModel()
  check(revived.getSnapshot().phase === 'long', '补算也推进周期，进入长休息', zh(revived.getSnapshot().phase))
  check(revived.getSnapshot().completedFocus === 0, '补算不计入番茄数（用户当时不在）', String(revived.getSnapshot().completedFocus))
}

// --------------------------------------------- 「跳到…」按钮的预告一致性

group('按钮文案不可能说谎：nextPhase 必须等于 skip() 的真实结果')
{
  let mismatches = 0
  let steps = 0
  for (const every of [1, 2, 3, 4, 6]) {
    for (let seed = 0; seed < 40; seed += 1) {
      const m = fresh()
      m.updateSettings({ longEvery: every })
      for (let i = 0; i < 12; i += 1) {
        const predicted = m.getSnapshot().nextPhase
        m.skip()
        const actual = m.getSnapshot().phase
        steps += 1
        if (predicted !== actual) mismatches += 1
      }
    }
  }
  check(mismatches === 0, `比对 ${steps} 步，预告与实际完全一致`, `不一致 ${mismatches} 次`)
}
{
  const m = fresh()
  m.switchPhase('short')
  check(m.getSnapshot().nextPhase === 'focus', '在短休息时预告为专注', String(m.getSnapshot().nextPhase))
  m.switchPhase('long')
  check(m.getSnapshot().nextPhase === 'focus', '在长休息时预告为专注', String(m.getSnapshot().nextPhase))
}

group('周期位置随刷新持久化')
{
  store.clear()
  const m = api.createModel()
  m.skip()
  const revived = api.createModel()
  check(revived.getSnapshot().cycleFocus === 1, '刷新后周期位置仍为 1', String(revived.getSnapshot().cycleFocus))
  revived.switchPhase('focus')
  check(revived.getSnapshot().nextPhase === 'short', '回到专注后预告为短休息（本轮 1/4，还没到长休）', String(revived.getSnapshot().nextPhase))
}

// ---------------------------------------------------------------- 汇总

console.log(`\n${failures === 0 ? '全部通过' : '存在失败'}：${checks - failures}/${checks} 项通过`)
process.exit(failures === 0 ? 0 : 1)
