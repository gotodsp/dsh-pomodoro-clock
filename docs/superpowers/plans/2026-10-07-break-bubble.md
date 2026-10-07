# 休息气泡 + AI 提醒语 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development (recommended) or executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 番茄钟进入短休息 / 长休息时，在 DSH 窗口内浮出一个圆形气泡并持续整个休息时长；气泡里的提醒句由模型现场生成、带当下状态与轮换角度，生成失败则回退到默认句。

**Architecture:** 插件目前是纯客户端的，宿主半是空 `apply(){}`。本计划给它加上第一块宿主侧子系统：宿主注册一个无状态的只读 HTTP 路由 `/pomodoro/tip`，客户端在休息开始时拉一次。纯逻辑（prompt 构造、清洗、校验）与副作用（HTTP、模型调用）分开：前者是 `index.js` 的具名导出、可被测试直接 `import`，后者是一层薄适配。

**Tech Stack:** 纯 ESM JavaScript（无构建步骤、无新增依赖）；测试用 Node 内置 `node:test` 风格的断言脚本，与现有 `test/model.test.mjs` 一致。

**Spec:** `docs/superpowers/specs/2026-10-07-break-bubble-design.md`

## Global Constraints

- **不新增任何运行时依赖。** 宿主与客户端都只用平台自带能力。
- **所有代码注释用中文。** 与现有两个文件一致。
- **模型调用不得传 `reasoningEffort`**，并且**不得传 `purpose`**（该字段只接受 `compaction | session-title`，没有给插件留位置）。
- **`maxTokens: 60`**，宿主超时 **3000ms**，客户端 fetch 超时 **3500ms**。
- **句子长度界（必须同时满足 prompt 口径与校验器口径，否则"生成即被自己拒"）**：zh 为 **12–20 汉字**（prompt）/ **汉字 6–24 且总码点 ≤ 30**（校验器）；en 为 **3–8 words 且整句不超过 60 个字符**（prompt）/ **3–8 词且总码点 ≤ 60**（校验器）。
  **不变量要写准**：词数/汉字数的范围必须落在校验器的同单位界内；**码点上限是宽度兜底，prompt 也必须显式说出来**——只写词数范围会让"7 词但 63 码点"这种 prompt 合规句被上限拒掉（re-review 实测），那样这条不变量就是假的。
- **发给模型的只有数字与时间**：阶段、第几个番茄、今天已完成几个、**当前时间（`HH:MM` 短串）**、角度、语言。不含任何对话内容、文件内容或工作区路径。
- **回退句必须是 i18n 文案**（键 `tip.fallback`），中英各一条。不得在代码里写死中文。
- **气泡尺寸 148px 圆形**；点掉后缩为 **30px 小圆点**；位置**中上方**。
- 任何失败路径都返回 **HTTP 204**，客户端保持默认句——**气泡永不变空、永不报错**。
- `package.json` 的 `files` 白名单已包含 `index.js` / `client.js` / `locale/*.json` / `test/*.mjs`，本计划不新增文件类型，白名单不需要改。

## Review Focus

以下五类是 spec 隐含、但没有被任何任务的测试覆盖、且最容易在使用时咬人的输入或情形。每一条都在所属任务的测试步骤里钉住。

1. **同源 GET 不带 `Origin` 头。** 浏览器对同源简单请求通常不发送 `Origin`；若把"缺席"当跨站拒绝，整个功能会**完全不可用**而看不出原因。期望：缺席时放行。
2. **模型返回客套长句**（"好的，我建议你站起来走动一下，顺便……"）。期望：被清洗与长度校验挡下，回退默认句，而不是把一整段塞进 148px 的气泡。
3. **模型返回带引号 / 换行 / emoji / 中英混排。** 期望：引号换行被清掉，emoji 与超界长度导致回退。
4. **迟到的响应写进已经消失的气泡。** 用户在生成期间切到专注（或休息结束），此时到达的响应不得让已经散掉的气泡重新出现或报错。期望：abort + 一个"当前是否仍在休息"的守卫。
5. **点掉气泡后剩余时间仍要更新。** 小圆点上的数字必须跟着秒级 tick 走，不能停在点掉那一刻。期望：小圆点读同一个 snapshot 的剩余时间。

---

### Task 1: prompt 构造（纯函数）

**Files:**
- Modify: `index.js`（当前内容为 `export function apply() {}`）
- Test: `test/tip.test.mjs`（新建）

**Interfaces:**
- Consumes: 无
- Produces:
  - `export const TIP_ANGLES` — `['water','distance','walk','stretch','breathe']`，顺序固定，客户端按同一顺序轮换
  - `export function buildTipPrompt(input: { phase: 'short'|'long', round: number, done: number, now: string, angle: string, lang: 'zh'|'en' }): { system: string, user: string }`

`now` 是调用方算好的本地时间短串（`'15:20'`）。**宿主半不自己取时间**，这样函数保持纯、可测。

- [ ] **Step 1: 写失败测试**

在 `test/tip.test.mjs` 里：

```js
import { buildTipPrompt, TIP_ANGLES } from '../index.js'

// 断言 1：角度表是固定的五个，顺序即轮换顺序
assert.deepEqual(TIP_ANGLES, ['water', 'distance', 'walk', 'stretch', 'breathe'])

// 断言 2：中文请求的 system 里必须含"只输出"和字数约束，user 里必须含状态数字与时间
const zh = buildTipPrompt({ phase: 'short', round: 3, done: 7, now: '15:20', angle: 'water', lang: 'zh' })
assert.ok(zh.system.includes('只输出'))
assert.ok(zh.system.includes('12') && zh.system.includes('20'))   // 字数约束的上下界都在
assert.ok(zh.user.includes('3') && zh.user.includes('7'))
assert.ok(zh.user.includes('15:20'))                              // spec 要求把当前时间喂给模型
assert.ok(zh.user.includes('水'))          // water 角度映射到"喝水"

// 断言 3：英文请求的 user 不含中文字符，且英文的长度约束用"词"而非"字符"
const en = buildTipPrompt({ phase: 'long', round: 4, done: 7, now: '15:20', angle: 'distance', lang: 'en' })
assert.ok(!/[\u4e00-\u9fff]/.test(en.user))
assert.ok(en.user.toLowerCase().includes('distance'))
// 英文用词数：必须与 Task 2 校验器的 3–8 词一致，否则生成的句子会被自己的校验器拒掉
assert.ok(/words/i.test(en.system) && !/characters/i.test(en.system))

// 断言 4：五个角度都能映射出非空子句，且互不相同
const clauses = TIP_ANGLES.map((a) => buildTipPrompt({ phase: 'short', round: 1, done: 1, now: '09:00', angle: a, lang: 'zh' }).user)
assert.equal(new Set(clauses).size, TIP_ANGLES.length)

// 断言 5：未知角度不抛异常，且**确实**退到第一个角度（不只是"没抛"）
const fallbackUser = buildTipPrompt({ phase: 'short', round: 1, done: 1, now: '09:00', angle: 'nope', lang: 'zh' }).user
const firstUser = buildTipPrompt({ phase: 'short', round: 1, done: 1, now: '09:00', angle: TIP_ANGLES[0], lang: 'zh' }).user
assert.equal(fallbackUser, firstUser)
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node test/tip.test.mjs`
Expected: FAIL —— `buildTipPrompt` 未导出 / 不是函数

- [ ] **Step 3: 实现 `TIP_ANGLES` 与 `buildTipPrompt`**

system 约束输出形状（一句话、12–20 字、不要引号、不要 emoji、不要说教、不要客套开头）；user 给状态与角度。中英各一套模板，角度 → 子句的映射用两张表。未知角度取 `TIP_ANGLES[0]`。

- [ ] **Step 4: 运行测试确认通过**

Run: `node test/tip.test.mjs`
Expected: PASS，退出码 0

- [ ] **Step 5: 提交**

`package.json` 的 `scripts.test` 改为同时跑两个测试文件（`node test/model.test.mjs && node test/tip.test.mjs`）。**不改的话新测试永远不进 CI，而后续任务的"跑全部测试"会静默只跑旧测试。**

```
git add index.js test/tip.test.mjs package.json
git commit -m "休息提醒：prompt 构造（纯函数 + 测试）"
```

---

### Task 2: 输出清洗与校验（纯函数）

**Files:**
- Modify: `index.js`
- Test: `test/tip.test.mjs`（追加）

**Interfaces:**
- Consumes: 无
- Produces:
  - `export function sanitizeTip(raw: string): string`
  - `export function validateTip(text: string, lang: 'zh'|'en'): boolean`

- [ ] **Step 1: 写失败测试（追加，覆盖 Review Focus 2 与 3）**

```js
// sanitizeTip：去首尾空白、去成对引号、压掉换行、去掉开头的客套
assert.equal(sanitizeTip('  「去接杯水吧」  '), '去接杯水吧')
assert.equal(sanitizeTip('好的，站起来走两步'), '站起来走两步')
assert.equal(sanitizeTip('去接杯水\n吧'), '去接杯水吧')
assert.equal(sanitizeTip('"去接杯水吧"'), '去接杯水吧')

// validateTip：中文按汉字数 6–24（不含标点），英文按词数 3–8
assert.equal(validateTip('站起来走两步', 'zh'), true)      // 6 字
assert.equal(validateTip('好', 'zh'), false)               // 太短
assert.equal(validateTip('一'.repeat(25), 'zh'), false)    // 太长
assert.equal(validateTip('   ', 'zh'), false)              // 纯空白
assert.equal(validateTip('去接杯水吧🙂', 'zh'), false)      // emoji
assert.equal(validateTip('去接\n杯水吧', 'zh'), false)      // 换行

// 英文按词数：3–8 词
assert.equal(validateTip('go grab some water', 'en'), true)
assert.equal(validateTip('go', 'en'), false)
assert.equal(validateTip(Array.from({ length: 13 }, () => 'walk').join(' '), 'en'), false)

// Review Focus 2：客套长句必须被挡下
const long = '好的，我建议你站起来走动一下，顺便去接一杯水，然后看看远处的风景，让眼睛休息一下'
assert.equal(validateTip(sanitizeTip(long), 'zh'), false)
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node test/tip.test.mjs`
Expected: FAIL —— `sanitizeTip` / `validateTip` 未定义

- [ ] **Step 3: 实现 `sanitizeTip` 与 `validateTip`**

`sanitizeTip`：trim → 去掉包裹的引号（中英文引号各一对）→ 去掉开头客套前缀（**前缀必须后跟标点**，如 `好的，` / `好的,` / `没问题，` / `OK,`；只后跟空格不算，否则 `Sure thing, stretch your legs` 会被削成 `thing, stretch your legs`）→ 删除换行与制表符（**英文换行要先补一个空格**：在 `/(?<=[A-Za-z0-9_])\n(?=[A-Za-z0-9_])/` 处插入空格再删，否则 `go grab\nsome water` 会粘成 `go grabsome water` 并通过校验；中日韩字符之间不补，`水\n吧` 仍须变成 `水吧`）→ 再次 trim。

`validateTip`：非空 → 不含 emoji（用 Unicode 扩展象形范围判断）→ 不含换行与制表符 → 长度在界内。**长度界（已裁定）**：

- **zh：汉字数 6–24**（不是字符数——prompt 要求的是「12 到 20 个汉字」，按字符数会把「20 汉字 + 5 个标点」这种完全合规的句子拒掉，导致生成即被自己拒、永远回退默认句）
- **en：空白分词 3–8 词**（不是 12——12 词约 60+ 码点，一个 148px 的气泡装不下，而且 prompt 说的范围必须落在校验器范围内，否则又是"生成即被自己拒"）
- **再按语言的字符宽度各叠一条总码点上限**：汉字约为拉丁字符两倍宽，所以同一个气泡宽度对应
  **zh ≤ 30 码点 / en ≤ 60 码点**。中英用同一条上限是错的：30 会把 12 词的英文句全拒掉。
  上限的作用是堵住「汉字 + 长英文尾巴」这种只卡汉字数漏掉的输出（实测 46 码点仍判 true）。

- [ ] **Step 4: 运行测试确认通过**

Run: `node test/tip.test.mjs`
Expected: PASS

- [ ] **Step 5: 提交**

```
git add index.js test/tip.test.mjs
git commit -m "休息提醒：输出清洗与长度校验"
```

---

### Task 3: 生成编排（`resolveTip`，依赖注入）

**Files:**
- Modify: `index.js`
- Test: `test/tip.test.mjs`（追加）

**Interfaces:**
- Consumes: Task 1 的 `buildTipPrompt`、`TIP_ANGLES`；Task 2 的 `sanitizeTip`、`validateTip`
- Produces:
  - `export async function resolveTip(deps: { llm: { stream(o: object): AsyncIterable<object> } | undefined, provider: string, model: string, signal?: AbortSignal }, input: { phase, round, done, now, angle, lang }): Promise<string | null>`
  - 返回值：可用的句子，或 `null`（调用方把 `null` 映射成 204）

`deps.llm` 为 `undefined` 时立即返回 `null`（第一道降级，早于任何 I/O）。

**`deps.signal` 必须与内部 3 秒超时合并使用**（`AbortSignal.any([deps.signal, AbortSignal.timeout(3000)])`，`deps.signal` 缺席时退化为只用自己的超时）。只取其一都是错的：只用外部 signal 会让慢响应挂住请求，只用内部超时会让用户切走后模型调用继续跑并计费。

- [ ] **Step 1: 写失败测试（用假 llm，覆盖失败矩阵）**

```js
const input = { phase: 'short', round: 1, done: 1, now: '15:20', angle: 'water', lang: 'zh' }
const okLlm = (chunks) => ({ stream: async function* () { for (const c of chunks) yield c } })
const textChunks = (s) => [{ type: 'text-delta', text: s }, { type: 'finish', reason: { kind: 'stop' } }]

// 正常：攒 text-delta
const good = await resolveTip({ llm: okLlm(textChunks('去接杯水吧')), provider: 'p', model: 'm' }, input)
assert.equal(good, '去接杯水吧')

// llm 服务缺席 → null，且不抛
assert.equal(await resolveTip({ llm: undefined, provider: 'p', model: 'm' }, input), null)

// 模型抛错 → null
const boom = { stream: async function* () { throw new Error('network') } }
assert.equal(await resolveTip({ llm: boom, provider: 'p', model: 'm' }, input), null)

// 校验不过 → null（空响应）
assert.equal(await resolveTip({ llm: okLlm(textChunks('')), provider: 'p', model: 'm' }, input), null)

// 校验不过 → null（客套长句）
assert.equal(await resolveTip({ llm: okLlm(textChunks(long)), provider: 'p', model: 'm' }, input), null)

// finish 为 error / aborted 时不采纳已攒内容
assert.equal(await resolveTip({ llm: okLlm([{ type: 'text-delta', text: '去接杯水吧' }, { type: 'finish', reason: { kind: 'error' } }]), provider: 'p', model: 'm' }, input), null)

// 外部 signal 已 abort → null（路由在客户端断开时会这样调）
// 注意：不要在这里真等 3 秒去测内部超时，那会让每个用例慢 3 秒；
// 内部超时是否生效由 Task 4 Step 5 的实机验证覆盖。
const ac = new AbortController(); ac.abort()
assert.equal(await resolveTip({ llm: okLlm(textChunks('去接杯水吧')), provider: 'p', model: 'm', signal: ac.signal }, input), null)
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node test/tip.test.mjs`
Expected: FAIL —— `resolveTip` 未定义

- [ ] **Step 3: 实现 `resolveTip`**

构造 `AbortSignal.timeout(3000)`；调 `deps.llm.stream({ provider, model, system, messages, maxTokens: 60, signal })`——**不传 `reasoningEffort`，不传 `purpose`**；累加 `text-delta`；`finish.reason.kind` 不是 `'stop'` 时返回 `null`；对结果跑 `sanitizeTip` + `validateTip`，不过则 `null`；整个函数体包在 try/catch 里，任何异常都返回 `null`。

- [ ] **Step 4: 运行测试确认通过**

Run: `node test/tip.test.mjs`
Expected: PASS

- [ ] **Step 5: 提交**

```
git add index.js test/tip.test.mjs
git commit -m "休息提醒：生成编排与全路径回退"
```

---

### Task 4: 宿主路由 `/pomodoro/tip`

**Files:**
- Modify: `index.js`（`apply` 内注册路由）
- Test: `test/tip.test.mjs`（追加一个纯函数测试）

**Interfaces:**
- Consumes: Task 3 的 `resolveTip`
- Produces:
  - `export function isSameOrigin(origin: string | undefined, host: string | undefined): boolean`
  - 路由：`kind: 'exact'`、`path: '/pomodoro/tip'`、query `phase` / `round` / `done` / `angle` / `lang`

- [ ] **Step 1: 写失败测试（覆盖 Review Focus 1）**

```js
// Origin 缺席 → 放行（同源 GET 通常不带 Origin）
assert.equal(isSameOrigin(undefined, 'localhost:52341'), true)

// 同源 → 放行
assert.equal(isSameOrigin('http://localhost:52341', 'localhost:52341'), true)

// 跨站 → 拒绝
assert.equal(isSameOrigin('http://evil.example', 'localhost:52341'), false)
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node test/tip.test.mjs`
Expected: FAIL —— `isSameOrigin` 未定义

- [ ] **Step 3: 实现 `isSameOrigin` 与路由注册**

`isSameOrigin`：`origin` 为 `undefined`/空 → `true`；否则解析出它的 host（含端口）与传入 `host` 严格相等。

`apply(ctx)` 里：`const llm = ctx.get('llm')`；`const server = ctx.get('webServer')`；`server` 缺席则整体不注册。注册 `{ kind: 'exact', path: '/pomodoro/tip', handler }`，`handler` 用 `ctx.effect` 挂载以便随插件卸载。

handler 顺序：同源检查不过 → 204 → 解析 query → `resolveTip` → `null` 则 204，否则 `200 {"text": ...}`。**响应头带 `cache-control: no-store`。** 客户端断开时 abort 进行中的生成（`req.on('close')` → `controller.abort()`，signal 传进 `deps.signal`）。

**query 的值全部是字符串，必须在调用 `resolveTip` 前转成数字**：`round` 与 `done` 用 `Number(...)` 转换并检查 `Number.isFinite`，转换失败就当作 204。**不转的话 `buildTipPrompt` 的防御性兜底会把它们静默变成 `1` 和 `0`**——模型会对一个配置完全正确的用户说"本轮第 1 个番茄，今天已完成 0 个"，而没有任何地方看得出错了。

`now` 由 handler 自己算：取本地时间的 `HH:MM`（`new Date()` → 补零），**不要交给 `buildTipPrompt` 去取**，那会破坏它的纯函数性质。

provider/model 取 `ctx.get('agentDefaultModel').currentSelection()`；取不到则当作 `llm` 缺席处理（204）。

**注意：** `WebRoute.handler` 的第二参数在 inspect 输出里被解析成 DSH 自己的 `ServerResponse`（`{type:'server-response', rpcId, result}`），但按 `IncomingMessage` 这个第一参数看，实际应是 **Node 的 `http.ServerResponse`**。按 Node 语义写（`res.writeHead` / `res.end`），并在 Step 5 的实机验证里确认。

- [ ] **Step 4: 运行全部测试确认通过**

Run: `node test/tip.test.mjs && node test/model.test.mjs`
Expected: 两个都 PASS（model 的 40 项不许回归）

- [ ] **Step 5: 实机验证路由**

启用插件后，在浏览器控制台执行：

```js
await fetch('/pomodoro/tip?phase=short&round=1&done=1&angle=water&lang=zh').then(r => [r.status, r.text()])
```

Expected: `[200, '{"text":"…"}']`，且文本长度符合长度界（zh：6–24 汉字且 ≤30 码点）。把 provider 改名成不存在的路由后再试，Expected: `[204, '']`。

- [ ] **Step 6: 提交**

```
git add index.js test/tip.test.mjs
git commit -m "休息提醒：宿主路由 + 同源检查"
```

---

### Task 5: 客户端气泡

**Files:**
- Modify: `client.js`（新增气泡组件、CSS、i18n 键、设置开关）
- Modify: `locale/zh.json`、`locale/en.json`
- Test: `test/tip.test.mjs`（追加角度轮换的纯函数测试）

**Interfaces:**
- Consumes: Task 4 的 query 参数约定（`phase` / `round` / `done` / `angle` / `lang`）
- Produces:
  - `client.js` 内一个**本地的**角度 id 列表与 `nextAngle(prev: string): string`

**客户端不能 import 宿主半。** `client.js` 是浏览器 bundle，宿主半的 `index.js` 是 ESM 模块，两者不共享模块系统——所以角度 id 列表在客户端**必须自带一份副本**，与 Task 1 的 `TIP_ANGLES` 顺序一致。这是平台的硬边界，不是选择。缓解是宿主对未知角度一律回退到第一个（Task 1 已实现），所以最坏情况只是新角度暂不被使用，不会报错。

- [ ] **Step 1: 写失败测试**

`client.js` 是浏览器 bundle、不能直接 import，所以沿用现有 `test/model.test.mjs` 的**标记切片法**：在 `client.js` 里用 `// --- tip-angle:start ---` / `// --- tip-angle:end ---` 把**客户端自己的角度列表**和 `nextAngle` **一起**包住（`nextAngle` 依赖那个列表，切片里少了它就跑不起来），测试按标记切出来求值后使用。

下面断言里的 `TIP_ANGLES` 指的是**切片出来的那一份**，不是 Task 1 里 `index.js` 导出的同名常量——两者是各自独立的副本，客户端拿不到宿主的那份。

```js
// 轮换一圈回到起点，且每次都变
let a = TIP_ANGLES[0]
const seen = [a]
for (let i = 0; i < TIP_ANGLES.length - 1; i += 1) { a = nextAngle(a); seen.push(a) }
assert.equal(new Set(seen).size, TIP_ANGLES.length)
assert.equal(nextAngle(TIP_ANGLES[TIP_ANGLES.length - 1]), TIP_ANGLES[0])

// 未知值不抛，退到第一个
assert.equal(nextAngle('nope'), TIP_ANGLES[0])

// 客户端副本必须与宿主半那份一致（漂移会让新角度永远不被使用）
import { TIP_ANGLES as HOST_ANGLES } from '../index.js'
assert.deepEqual(TIP_ANGLES, HOST_ANGLES)
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node test/tip.test.mjs`
Expected: FAIL —— 切片里找不到 `nextAngle`

- [ ] **Step 3: 实现气泡与回退逻辑**

- 休息开始时（`phase` 变为 `short` / `long`）渲染 148px 圆形气泡于中上方，文案三行：阶段名 / 剩余时间 / 提醒句（先显示 `t('tip.fallback')`）。
- 同时（若设置项 `aiTip` 为真）发 `fetch('/pomodoro/tip?…', { signal: AbortSignal.timeout(3500) })`，角度取客户端持久化的计数器 + `nextAngle`。
- 200 → 新句淡入替换。**替换前必须再检查一次"当前仍在休息且气泡仍在"**（Review Focus 4）。
- 204 / 超时 / 抛错 → 保持默认句，不提示。
- 点 ✕ → 缩成 30px 小圆点挨着圆盘，显示剩余时间；**小圆点读同一个 snapshot**，所以秒级 tick 照常更新（Review Focus 5）。点小圆点展开回大气泡。
- 休息结束 / 切到专注 → 气泡消失，并 abort 进行中的 fetch。
- `prefers-reduced-motion` 时不做淡入淡出与缩放。
- 新增设置项 `aiTip`（默认 true），关掉完全不发请求。
- i18n 新增：`tip.fallback`（zh「站起来走两步」/ en 对应句）、`tip.title`、设置项标签。

- [ ] **Step 4: 运行全部测试确认通过**

Run: `node test/tip.test.mjs && node test/model.test.mjs`
Expected: 两个都 PASS

- [ ] **Step 5: 手工验证（逐条打勾）**

启用插件后：

1. 专注结束进入短休息 → 气泡立即出现，先显示默认句
2. 1–3 秒内默认句被 AI 句替换（若没替换，看 Network 里该请求的状态码，204 属正常回退）
3. 点 ✕ → 缩成小圆点，数字仍在走
4. 点小圆点 → 展开回大气泡
5. 休息期间切到专注 → 气泡消失，Network 里没有继续跑的请求
6. 把设置里「AI 生成提醒语」关掉 → 气泡只显示默认句，且不发请求
7. 切换界面语言到英文 → 默认句与 AI 句都是英文
8. 长休息（第 4 个番茄后）→ 同样出现气泡

- [ ] **Step 6: 提交**

```
git add client.js locale/zh.json locale/en.json test/tip.test.mjs
git commit -m "休息提醒：客户端气泡与回退"
```

---

### Task 6: 文档

**Files:**
- Modify: `README.md`

**Interfaces:**
- Consumes: 全部
- Produces: 无

- [ ] **Step 1: 补 README**

新增一节说明：气泡的形态与交互、AI 句子的来源与轮换角度、**失败矩阵**（七种情况全部回退到默认句）、**路由没有鉴权的缓解方式**、**`purpose` 字段是借用内部 API 的长期风险**、以及"发给模型的只有数字"的隐私边界。同时更新「验证状态」一节的自检项数与命令。

- [ ] **Step 2: 确认 README 里的命令与实际一致**

Run: `npm test`
Expected: 退出码 0

- [ ] **Step 3: 提交**

```
git add README.md
git commit -m "休息提醒：文档"
```

---

## Self-Review

**Spec coverage：** 架构与数据流 → Task 4/5；宿主半七步处理顺序 → Task 1（prompt）、2（清洗校验）、3（编排与超时）、4（服务缺席 / 同源 / 路由）；客户端半九条 → Task 5；失败矩阵七行 → Task 3 的测试逐行覆盖；两条限制 → Task 4（同源缓解）+ Task 6（文档写明风险）；隐私边界 → Task 1（prompt 只含数字）+ Task 6。无遗漏。

**Step scan：** 每个实现步骤只给签名与约束，函数体留给实现者；唯一给出算法说明的是 `sanitizeTip` 的处理顺序（因为顺序会影响结果，spec 未定）。

**Type consistency：** `TIP_ANGLES` / `buildTipPrompt` / `sanitizeTip` / `validateTip` / `resolveTip` / `isSameOrigin` / `nextAngle` 在 Interfaces 块中定义一次，后续任务引用同名同签名。

**Review Focus：** 五条各已落到任务——1 → Task 4 Step 1；2 → Task 2 Step 1；3 → Task 2 Step 1；4 → Task 5 Step 3；5 → Task 5 Step 3（小圆点读同一 snapshot）。

**Proportion：** 实测本计划 19438 字节，spec 9634 字节，**约 2.0 倍**。计划里没有整段函数体（唯一的算法说明是 `sanitizeTip` 的处理顺序，因为顺序会影响结果而 spec 未定），大部分篇幅在测试断言与手工验证清单上——这是"决定"而不是"转写"。2 倍仍在合理范围，但接近上限；若再加任务应考虑拆分。
