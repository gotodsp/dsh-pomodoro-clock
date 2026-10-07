/**
 * 番茄时钟 —— 浏览器半边。
 *
 * 挂载在全窗口浮层 `shell.overlay` 里，有三种形态：
 *   · 面板态：番茄图标 + 标题 + 收起按钮 / 阶段胶囊标签 / 超大倒计时 / 反色主按钮；
 *   · 圆盘态：62px 圆盘，外环是本阶段进度，中心是倒计时；
 *   · 休息气泡：短休/长休期间在**屏幕正中央**浮出 180px 圆形气泡（**放大版圆盘**：外环阶段色 + 内盘两段 + 倒计时，下接一句提醒），
 *     点 ✕ 缩成挨着圆盘的 30px 小圆点，休息一结束就散掉。
 *
 * 计时模型在 `apply` 里只创建一次，所以收起、切会话、刷新页面都不会打断倒计时。
 * 浮层本身是点击穿透的、只给直接子元素放行事件，因此这个部件的根节点必须
 * 始终只有自身大小，绝不能做成铺满屏幕的容器 —— 气泡是另一个同层节点，
 * 同样只有自身大小（见 BreakTip 上方的说明）。
 */
window.__ModuleLoader__.load({
  id: '@local/pomodoro-clock',
  factory: (require) => {
    const React = require('react')
    const h = React.createElement

    const NS = 'pomodoro'
    const PLUGIN_ID = '@local/pomodoro-clock'
    const STORAGE_KEY = 'dsh.pomodoro-clock.v1'
    const UI_KEY = 'dsh.pomodoro-clock.ui.v1'
    /** 提醒角度的落盘键。与 UI 键分开：拖动位置和角度轮换互不相干，不该互相覆盖。 */
    const TIP_KEY = 'dsh.pomodoro-clock.tip.v1'
    /** 提醒请求在客户端侧的上限（毫秒）。宿主自己也有超时，这里只保证请求不无限挂着。 */
    const TIP_TIMEOUT_MS = 3500
    /** 计时器轮询间隔：只用来刷新显示，真实时间以 endsAt 为准。 */
    const TICK_MS = 250
    /** 页面重开后最多补算多少个已结束的阶段，超过就当作过期运行重置。 */
    const CATCH_UP_LIMIT = 8
    /** 按下后位移超过这个像素数才算拖动，否则算点击。 */
    const DRAG_THRESHOLD = 4
    /** 未拖动过时，部件距离窗口右下角的默认间距。 */
    const EDGE_GAP = 20
    const PHASES = ['focus', 'short', 'long']

    /** 数值型设置及其闭区间取值范围。 */
    const NUMERIC_SETTINGS = {
      focusMinutes: [1, 180],
      shortMinutes: [1, 60],
      longMinutes: [1, 120],
      longEvery: [1, 12],
    }
    /** 开关型设置。 */
    const FLAG_SETTINGS = ['autoStartBreak', 'autoStartFocus', 'sound', 'aiTip']

    const DEFAULT_SETTINGS = {
      focusMinutes: 25,
      shortMinutes: 5,
      longMinutes: 15,
      longEvery: 4,
      autoStartBreak: true,
      autoStartFocus: false,
      sound: true,
      aiTip: true,
    }

    const EN = {
      'app.title': 'Pomodoro',
      'phase.focus': 'Focus',
      'phase.short': 'Short break',
      'phase.long': 'Long break',
      'action.start': 'Start focus',
      'action.pause': 'Pause',
      'action.startBreak': 'Start break',
      'action.reset': 'Restart this phase',
      'action.skip': 'Skip to the next phase',
      'action.settings': 'Pomodoro clock settings',
      'action.collapse': 'Collapse to a floating dial',
      'action.expand': 'Open the Pomodoro clock',
      'action.move': 'Drag to move',
      'action.dismissTip': 'Collapse the break reminder',
      'action.expandTip': 'Show the break reminder',
      'label.progress': 'Progress',
      'label.phase': 'Choose a phase',
      'stats.completed': 'Completed',
      'stats.cycle': 'Cycle',
      'tip.title': 'Break reminder',
      'tip.fallback': 'Stand up and walk a few steps',
      'settings.title': 'Settings',
      'settings.focus': 'Focus',
      'settings.short': 'Short break',
      'settings.long': 'Long break',
      'settings.minutes': 'min',
      'settings.longEvery': 'Long break every',
      'settings.every': 'pomodoros',
      'settings.autoStartBreak': 'Start breaks automatically',
      'settings.autoStartFocus': 'Start focus automatically',
      'settings.sound': 'Chime when a phase ends',
      'settings.aiTip': 'AI-written break reminders',
      'settings.resetStats': 'Clear statistics',
    }

    const ZH = {
      'app.title': '番茄时钟',
      'phase.focus': '专注',
      'phase.short': '短休息',
      'phase.long': '长休息',
      'action.start': '开始专注',
      'action.pause': '暂停',
      'action.startBreak': '开始休息',
      'action.reset': '重开本阶段',
      'action.skip': '跳到下一阶段',
      'action.settings': '番茄时钟设置',
      'action.collapse': '收起为悬浮圆盘',
      'action.expand': '打开番茄时钟',
      'action.move': '拖动可移动',
      'action.dismissTip': '收起休息提醒',
      'action.expandTip': '展开休息提醒',
      'label.progress': '进度',
      'label.phase': '选择阶段',
      'stats.completed': '已完成',
      'stats.cycle': '本轮',
      'tip.title': '休息提醒',
      'tip.fallback': '站起来走两步',
      'settings.title': '设置',
      'settings.focus': '专注',
      'settings.short': '短休息',
      'settings.long': '长休息',
      'settings.minutes': '分钟',
      'settings.longEvery': '长休息间隔',
      'settings.every': '个番茄',
      'settings.autoStartBreak': '自动开始休息',
      'settings.autoStartFocus': '自动开始专注',
      'settings.sound': '阶段结束提示音',
      'settings.aiTip': 'AI 生成提醒语',
      'settings.resetStats': '清除统计',
    }

    const CLASS = {
      root: 'dsp-pc-root',
      card: 'dsp-pc-card',
      mini: 'dsp-pc-mini',
      head: 'dsp-pc-head',
      tomato: 'dsp-pc-tomato',
      title: 'dsp-pc-title',
      spacer: 'dsp-pc-spacer',
      iconBtn: 'dsp-pc-icon-btn',
      tabs: 'dsp-pc-tabs',
      tab: 'dsp-pc-tab',
      time: 'dsp-pc-time',
      bigBtn: 'dsp-pc-big-btn',
      ring: 'dsp-pc-ring',
      ringInner: 'dsp-pc-ring-inner',
      panel: 'dsp-pc-panel',
      panelTitle: 'dsp-pc-panel-title',
      stats: 'dsp-pc-stats',
      field: 'dsp-pc-field',
      fieldEnd: 'dsp-pc-field-end',
      unit: 'dsp-pc-unit',
      input: 'dsp-pc-input',
      check: 'dsp-pc-check',
      actions: 'dsp-pc-actions',
      btn: 'dsp-pc-btn',
      tip: 'dsp-pc-tip',
      tipClose: 'dsp-pc-tip-close',
      tipInner: 'dsp-pc-tip-inner',
      tipRing: 'dsp-pc-tip-ring',
      tipTime: 'dsp-pc-tip-time',
      tipText: 'dsp-pc-tip-text',
      tipDot: 'dsp-pc-tip-dot',
    }

    /**
     * 插件自己的配色。每个名字给一对明暗值。
     *
     * **不走 `ctx.theme.overrideTokens()`，而是由下面的 `paletteDecls()` 直接生
     * 成两条 CSS 规则写进本插件自己的 `<style>`。** 这不是偏好，是踩坑后的结论：
     * 覆盖层能注册成功（`Theme.listTokens` 里 16 个 token 一个不少），但值**从来
     * 没落到 DOM 上** —— 实测 `getComputedStyle(document.body).getPropertyValue
     * ('--dsp-pc-ring-short')` 返回空串，于是三个阶段全部回退到兜底色。
     * 色值放进自己注入的样式表后，就和消费它们的规则**原子同在**：样式表在，
     * 颜色就在；样式表不在，整个部件都是裸的。两者再不可能脱节。
     * 代价：这些 token 不再出现在 `Theme.listTokens` 里。
     *
     * 名字带 dsp-pc- 前缀，不会和宿主 token 撞车。
     */
    const PALETTE = {
      '--dsp-pc-btn-bg': { light: '#fbdcd3', dark: '#4a1d12' },
      '--dsp-pc-btn-bg-hover': { light: '#f7cabc', dark: '#5e2517' },
      '--dsp-pc-btn-ink': { light: '#a0301c', dark: '#ffc9bb' },
      '--dsp-pc-btn-edge': { light: '#e8604a', dark: '#a8442c' },
      // 圆盘外环按阶段换色，三种色相刻意拉开距离（番茄 8.4° / 绿 148.1° /
      // 靛蓝 228.1°，两两间隔 ≥80°），这样 62px 的细环上一眼能分。
      // 没选琥珀是因为它在色相环上和番茄只差 28.5°，恰恰是最难分开的一个；
      // 也没选深绿，它和短休息绿只差 17°，比琥珀还近。
      '--dsp-pc-ring-focus': { light: '#e8604a', dark: '#f0705a' },
      '--dsp-pc-ring-short': { light: '#2f9e63', dark: '#4cc38a' },
      '--dsp-pc-ring-long': { light: '#4a63c8', dark: '#8b9df0' },
      // 未走过的那一段用同色低透明度版本。这里写死数值而不是用 color-mix()
      // 现算：后者一旦不被支持，整条 conic-gradient 失效，圆环会直接消失。
      '--dsp-pc-ring-focus-soft': { light: 'rgba(232, 96, 74, 0.22)', dark: 'rgba(240, 112, 90, 0.26)' },
      '--dsp-pc-ring-short-soft': { light: 'rgba(47, 158, 99, 0.22)', dark: 'rgba(76, 195, 138, 0.26)' },
      '--dsp-pc-ring-long-soft': { light: 'rgba(74, 99, 200, 0.22)', dark: 'rgba(139, 157, 240, 0.26)' },
      // 圆盘中间那两个深浅层次。这里**必须是不透明的实色**，不能带 alpha：
      // 中间原本是用宿主的 --dsw-specific-menu 盖出来的，而那是「磨砂面板」填充，
      // 透明度随平台变（实测同一 token 有 94% 和 58% 两套定义）。在 macOS 桌面上
      // 拿到偏透的那套，底下 conic-gradient 的扇形就透了上来，变成一块「太浅、
      // 分不出」的残影。实色 token 让两个平台完全一致。
      // 生成规则：阶段色叠在面板底色上，浅色主题 已走过≈30% / 未走过≈10%，
      // 深色主题 34% / 14%。两层都带色相，这样阶段刚开始时中间也不会变得没颜色。
      '--dsp-pc-dial-focus': { light: '#f8cfc9', dark: '#714642' },
      '--dsp-pc-dial-focus-rest': { light: '#fdefed', dark: '#4b3a3b' },
      '--dsp-pc-dial-short': { light: '#c9e6d6', dark: '#385d4f' },
      '--dsp-pc-dial-short-rest': { light: '#eaf5ef', dark: '#334340' },
      '--dsp-pc-dial-long': { light: '#d0d6f1', dark: '#4b516e' },
      '--dsp-pc-dial-long-rest': { light: '#edeffa', dark: '#3b3e4c' },
    }

    /**
     * 浮层 `.overlayLayer` 是 `position:absolute;inset:0;z-index:20;pointer-events:none`，
     * 仅给直接子元素放行指针事件 —— 所以这个部件只能是自身盒子大小。
     * 颜色全部走宿主主题 token；阶段强调色只用在圆环上。
     */
    /**
     * 把 PALETTE 摊成 CSS 声明串。明暗两套都从这里生成，避免手抄两遍出错。
     */
    const paletteDecls = (mode) =>
      Object.entries(PALETTE).map(([name, pair]) => `${name}:${pair[mode]}`).join(';')

    const CSS = [
      // 圆盘按阶段换色：这一条只做「阶段 → token」的映射，具体色值由下面的
      // 浅色/深色两条规则提供。映射和色值分开写，是为了让深色规则只覆盖原始
      // 色值、不去碰映射变量（原因见深色那条的注释）。
      //
      // **调色板必须同时发给气泡**（`.dsp-pc-tip`）：气泡是时钟根节点的**兄弟**，
      // 兄弟之间不继承自定义属性。只发给根节点时，气泡里的
      // `--dsp-pc-ring: var(--dsp-pc-ring-short)` 会因为 `--dsp-pc-ring-short` **不存在**
      // 而变成无效值，于是 `var(--dsp-pc-ring, 兜底)` 取兜底 —— 外环渲染成错误红。
      // 更隐蔽的是：`--dsp-pc-ring` 与 `--dsp-pc-ring-soft` 会**同时**失效、落到同一个
      // 兜底色，于是"已经扫过的扇形"整个消失，看上去只是一圈纯色 —— 用户实测报告就是
      // "外环是红色、和圆盘不一致、没有扫过的扇形"，三个现象同一个原因。
      `.${CLASS.root},.${CLASS.tip}{box-sizing:border-box;${paletteDecls('light')}}`,
      // 阶段映射：根节点与气泡各来一条（内联样式也会写同样的值，见 TIP_PHASE_VARS）。
      // 默认阶段（没有 data-phase 时）：映射到 focus 的色值。有 data-phase 时由下面的规则覆盖。
      `.${CLASS.root}{--dsp-pc-ring:var(--dsp-pc-ring-focus);--dsp-pc-ring-soft:var(--dsp-pc-ring-focus-soft);--dsp-pc-dial:var(--dsp-pc-dial-focus);--dsp-pc-dial-rest:var(--dsp-pc-dial-focus-rest)}`,
      // 深色：**只覆盖原始色值，绝不重新声明 --dsp-pc-ring / --dsp-pc-dial**。
      // 这条选择器是 (0,2,1)，而阶段规则 `.dsp-pc-root[data-phase=…]` 是 (0,2,0)
      // —— 一旦在这里也写映射变量，深色下阶段就会被永久钉死在 focus。
      // `body[data-ds-dark-theme]` 是宿主 layout presenter 维护的暗色属性，
      // 宿主自己的主题 CSS 用的也是它。
      `body[data-ds-dark-theme] .${CLASS.root},body[data-ds-dark-theme] .${CLASS.tip}{${paletteDecls('dark')}}`,
      // 阶段变量必须**同时**发给气泡：气泡和时钟根节点是**兄弟**（都直接挂在整帧浮层里），
      // 兄弟之间不继承自定义属性。早先只写给 `.dsp-pc-root`，于是气泡里 `var(--dsp-pc-ring, …)`
      // 每次都落到兜底值 —— 三个阶段全渲染成同一个颜色，且完全静默。
      // 气泡自己带 `data-phase`（见 BreakTip），这里把选择器扩成两者。
      `.${CLASS.root}[data-phase="focus"],.${CLASS.tip}[data-phase="focus"]{--dsp-pc-ring:var(--dsp-pc-ring-focus);--dsp-pc-ring-soft:var(--dsp-pc-ring-focus-soft);--dsp-pc-dial:var(--dsp-pc-dial-focus);--dsp-pc-dial-rest:var(--dsp-pc-dial-focus-rest)}`,
      `.${CLASS.root}[data-phase="short"],.${CLASS.tip}[data-phase="short"]{--dsp-pc-ring:var(--dsp-pc-ring-short);--dsp-pc-ring-soft:var(--dsp-pc-ring-short-soft);--dsp-pc-dial:var(--dsp-pc-dial-short);--dsp-pc-dial-rest:var(--dsp-pc-dial-short-rest)}`,
      `.${CLASS.root}[data-phase="long"],.${CLASS.tip}[data-phase="long"]{--dsp-pc-ring:var(--dsp-pc-ring-long);--dsp-pc-ring-soft:var(--dsp-pc-ring-long-soft);--dsp-pc-dial:var(--dsp-pc-dial-long);--dsp-pc-dial-rest:var(--dsp-pc-dial-long-rest)}`,
      // 共享的浮起面板外观：沿用宿主弹层的表面与投影，并给出 token 兜底。
      `.${CLASS.card},.${CLASS.mini}{position:absolute;border:1px solid var(--dsw-alias-border-l1);`,
      `background:var(--dsw-specific-menu,var(--dsw-alias-bg-overlay));`,
      `box-shadow:var(--dsw-elevation-soft,0 8px 28px rgb(0 0 0 / 16%));color:var(--dsw-alias-label-secondary)}`,
      // 从未拖动过时用 CSS 直接停在右下角，省掉一次测量与首帧跳动。
      `.${CLASS.card}[data-floating="false"],.${CLASS.mini}[data-floating="false"]{right:${EDGE_GAP}px;bottom:${EDGE_GAP}px}`,
      // ---- 面板态 ----
      `.${CLASS.card}{width:232px;padding:12px;border-radius:20px;display:flex;flex-direction:column;gap:12px}`,
      `.${CLASS.head}{display:flex;align-items:center;gap:8px;cursor:grab;touch-action:none;`,
      `user-select:none;-webkit-user-select:none}`,
      `.${CLASS.card}[data-dragging="true"] .${CLASS.head},.${CLASS.mini}[data-dragging="true"]{cursor:grabbing}`,
      `.${CLASS.tomato}{flex:none;display:block;width:24px;height:24px}`,
      `.${CLASS.title}{min-width:0;font-size:13px;font-weight:600;line-height:18px;color:var(--dsw-alias-label-primary);`,
      `white-space:nowrap;overflow:hidden;text-overflow:ellipsis}`,
      `.${CLASS.spacer}{flex:auto}`,
      `.${CLASS.iconBtn}{box-sizing:border-box;flex:none;display:inline-flex;align-items:center;justify-content:center;`,
      `width:22px;height:22px;padding:0;border:none;border-radius:999px;background:transparent;`,
      `color:var(--dsw-alias-label-secondary);font:inherit;line-height:1;cursor:pointer}`,
      `.${CLASS.iconBtn}:hover{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}`,
      `.${CLASS.iconBtn}:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}`,
      `.${CLASS.iconBtn} svg{display:block}`,
      // 阶段胶囊：外层是凹陷的槽，选中项浮起。
      `.${CLASS.tabs}{align-self:center;display:inline-flex;align-items:center;gap:2px;padding:3px;`,
      `border-radius:999px;background:var(--dsw-alias-bg-base)}`,
      `.${CLASS.tab}{box-sizing:border-box;padding:5px 12px;border:none;border-radius:999px;background:transparent;`,
      `color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;line-height:16px;white-space:nowrap;cursor:pointer}`,
      `.${CLASS.tab}:hover{color:var(--dsw-alias-label-primary)}`,
      `.${CLASS.tab}:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}`,
      `.${CLASS.tab}[aria-selected="true"]{background:var(--dsw-alias-bg-overlay);color:var(--dsw-alias-label-primary);`,
      `box-shadow:var(--dsw-elevation-soft,0 1px 2px rgb(0 0 0 / 14%))}`,
      `.${CLASS.time}{text-align:center;font-size:42px;line-height:48px;font-weight:400;letter-spacing:.5px;`,
      `color:var(--dsw-alias-label-primary);font-variant-numeric:tabular-nums}`,
      // 主按钮：浅番茄底 + 深番茄字 + 番茄描边。
      // 浅底必须配深字 —— 浅番茄配白字对比度只有 1.4:1；下面这一对是
      // 浅色 5.6:1、深色 9.7:1，都过 AA。描边负责把"可以点"补回来，
      // 否则浅色主题下按钮比卡片还浅，容易被读成次要操作。
      `.${CLASS.bigBtn}{box-sizing:border-box;align-self:center;display:inline-flex;align-items:center;justify-content:center;`,
      `gap:8px;height:38px;padding:0 26px;border-radius:999px;`,
      `border:1px solid var(--dsp-pc-btn-edge,#e8604a);`,
      `background:var(--dsp-pc-btn-bg,#fbdcd3);color:var(--dsp-pc-btn-ink,#a0301c);`,
      `font:inherit;font-size:13px;font-weight:600;line-height:1;white-space:nowrap;cursor:pointer}`,
      `.${CLASS.bigBtn}:hover{background:var(--dsp-pc-btn-bg-hover,#f7cabc)}`,
      `.${CLASS.bigBtn}:focus-visible{outline:2px solid var(--dsp-pc-btn-edge,#e8604a);outline-offset:2px}`,
      `.${CLASS.bigBtn} svg{display:block}`,
      // ---- 设置面板 ----
      `.${CLASS.panel}{display:flex;flex-direction:column;gap:7px;padding-top:10px;border-top:1px solid var(--dsw-alias-border-l1);font-size:12px;line-height:18px}`,
      `.${CLASS.panelTitle}{font-weight:600;color:var(--dsw-alias-label-primary)}`,
      `.${CLASS.stats}{color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums}`,
      `.${CLASS.field}{display:flex;align-items:center;justify-content:space-between;gap:8px}`,
      `.${CLASS.fieldEnd}{display:inline-flex;align-items:center;gap:5px}`,
      `.${CLASS.unit}{color:var(--dsw-alias-label-secondary)}`,
      `.${CLASS.input}{box-sizing:border-box;width:52px;height:24px;padding:0 6px;border-radius:8px;`,
      `border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-base);`,
      `color:var(--dsw-alias-label-primary);font:inherit;font-size:inherit;font-variant-numeric:tabular-nums}`,
      `.${CLASS.input}:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}`,
      `.${CLASS.check}{display:flex;align-items:center;gap:7px;cursor:pointer}`,
      `.${CLASS.check} input{margin:0;accent-color:var(--dsw-alias-brand-primary)}`,
      `.${CLASS.actions}{display:flex;flex-wrap:wrap;gap:6px;padding-top:3px}`,
      `.${CLASS.btn}{box-sizing:border-box;display:inline-flex;align-items:center;justify-content:center;gap:5px;`,
      `height:26px;padding:0 10px;border-radius:999px;border:1px solid var(--dsw-alias-border-l1);`,
      `background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;line-height:1;cursor:pointer}`,
      `.${CLASS.btn}:hover{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}`,
      `.${CLASS.btn}:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}`,
      `.${CLASS.btn} svg{display:block}`,
      // ---- 圆盘态 ----
      `.${CLASS.mini}{width:62px;height:62px;padding:0;border-radius:50%;cursor:grab;touch-action:none}`,
      // 圆盘外环：已走过的一段是实心阶段色，未走过的一段是同色低透明度版本。
      // 两段都跟着 data-phase 走，任何一段写死颜色都会让阶段区分失效。
      //
      // 兜底值刻意用**错误色**而不是番茄色。早先这里是 #e8604a，于是当主题调色板
      // 整个丢失时（实测：页面处于半更新状态，覆盖层被移除却没重新注册），三个
      // 阶段全部回退成番茄色 —— 一个"看起来完全合理"的错误画面，害我在读 CSS 和
      // 主题实现上绕了好几轮。现在这种故障渲染成红环：还在显示说明部件活着，
      // 是红的说明这是错误态，一眼可辨。两段共用同一个兜底色，顺带让进度也失效，
      // 与任何正常状态都不同。
      `.${CLASS.ring}{position:absolute;inset:0;border-radius:50%;display:grid;place-items:center;`,
      `background:conic-gradient(var(--dsp-pc-ring,var(--dsw-alias-state-error-primary)) var(--dsp-pc-progress,0%),var(--dsp-pc-ring-soft,var(--dsw-alias-state-error-primary)) 0)}`,
      // 圆盘中间：自己的 conic-gradient，两层都是**不透明实色**。
      // 早先这里借用了宿主的 --dsw-specific-menu 当遮罩，那是磨砂面板填充、
      // 透明度随平台变，于是底下的扇形会透上来 —— 换成实色 token 后，
      // 中间在任何平台都是同一份颜色。
      // 兜底同样不用阶段色，改用不透明的中性面板色：故障由红环负责报警，
      // 中间保持中性，倒计时文字仍然可读。
      `.${CLASS.ringInner}{width:50px;height:50px;border-radius:50%;display:grid;place-items:center;`,
      `background:conic-gradient(var(--dsp-pc-dial,var(--dsw-alias-bg-overlay)) var(--dsp-pc-progress,0%),var(--dsp-pc-dial-rest,var(--dsw-alias-bg-overlay)) 0);`,
      `color:var(--dsw-alias-label-primary);`,
      `font-size:12px;font-weight:600;line-height:1;font-variant-numeric:tabular-nums}`,
      // ---- 休息气泡 ----
      // **放大版的圆盘**：不是另一个新物件，而是角落那个 62px 圆盘放大到 180px，用的是
      // 同一套 token、同一套结构（外环阶段色两段 + 内盘深一档两段 + 中心读数），只多接一句文案。
      // 这样"两个东西在报同一件事"就变成了"同一个东西临时变大"。
      //
      // 尺寸 180px、环 **9px**（不是按 62px 的比例放大到 15px）：环一粗就变成甜甜圈，
      // 视觉重量全跑到环上，40px 的倒计时反而被压住，文案也没地方。**"样式一致"指的是
      // 同一套颜色与结构，不是同一个比例** —— 圆盘小所以环相对粗，气泡大所以环相对细。
      //
      // 位置 = 屏幕正中央（`left/top:50%` + `translate:-50% -50%`）。这是刻意的取舍：它等于压在
      // 对话正文和输入框上，是"存在感最强"也"最挡视线"的位置，代价由 ✕ → 小圆点那条退路兜着。
      // 不用 `position:fixed`：固定定位在带 transform 的祖先下会改参考系，而浮层这一层
      // 就是现成的坐标系 —— 圆盘的默认位置用的也是它。
      // 垂直居中走 `translate` 而不是 `transform`：`transform` 要留给进出场动画的缩放，
      // 两者写在一起会互相覆盖（动画一跑，居中就没了）。
      `.${CLASS.tip}{position:absolute;left:50%;top:50%;translate:-50% -50%;`,
      `box-sizing:border-box;width:180px;height:180px;padding:9px;border-radius:50%;display:grid;place-items:center;`,
      // **不要给气泡加 1px 描边**（曾经加过 `border:1px solid --dsw-alias-border-l1`，两个坏处）：
      // 1) 暗色主题下它是浅色的 —— 那是个会发白的元素，"四个位置发白"的实测反馈就是它露出来的部分；
      // 2) 有边框时**内边距盒只有 178px**，而 SVG 外环是 180px，两者错位 1px，环盖不住边框，
      //    边框就在环没对齐的地方露出来。
      // 环（SVG 描边）自己就是边界，不需要再描一层。
      `box-shadow:var(--dsw-elevation-soft,0 8px 28px rgb(0 0 0 / 16%));`,
      `animation:dsp-pc-tip-in 240ms ease-out}`,
      // 外环改用 **SVG** 画，不用 conic-gradient。
      //
      // 原因：浏览器把 conic-gradient 拆成**四个象限**栅格化，四条象限边界（正上、正右、正下、
      // 正左）会留下 1px 的接缝。9px 宽的环上，接缝横穿整条环，看起来就是"每一边中间有一小段
      // 有颜色的线"（实测反馈）。SVG 的 `<circle>` 一次描边成形，没有象限拼接，也没有接缝。
      // 顺带的好处：环宽就是 `stroke-width`，不必再靠 padding 反推。
      // r=85.5、stroke-width=9 → 环占 r 81~90；内盘 r=81（162px），两者正好接上。
      `.${CLASS.tipRing}{position:absolute;inset:0;width:180px;height:180px;display:block;pointer-events:none}`,
      // 描边宽度与填充写进 CSS，**不靠属性**。
      // 实测现象："四个方向中间没问题、四个角没有颜色" —— 这是**线太细/太淡**的典型特征：
      // 笔画在正上正下正左正右是横平竖直的，渲染得清楚；到四个斜角曲线成 45°，抗锯齿把线摊到
      // 两个像素上就淡到看不见。属性形式的 stroke-width 没生效时就是这个样子。
      // 颜色仍由每个 circle 的 style 提供（见 BreakTip），这里只管几何。
      `.${CLASS.tipRing} circle{fill:none;stroke-width:9}`,
      `.${CLASS.tipRing} circle:last-child{stroke-linecap:butt}`,
      // 内盘：与圆盘的 `.dsp-pc-ring-inner` 同一套（不透明两段实色），只是里面多了那句文案。
      // 内盘 164px（r=82）而不是 162px（r=81）：**故意往环底下压 1px**。
      // SVG 环的内缘与内盘的外缘如果正好相接，两条抗锯齿边会叠出一道极淡的亮缝，
      // 看上去像"环和内盘之间有个缝"。压 1px 之后这条缝被内盘盖住。
      // 环因此显窄 1px（9 → 8 可见），肉眼无感。
      // `position:relative` 不是为了定位，是**绘制顺序**：SVG 是绝对定位元素，绝对定位
      // 会盖在静态元素之上。内盘不加定位就压不住环的内缘，"往环底下压 1px"那招会失效。
      // 加上之后内盘进入定位层，DOM 里又排在 SVG 之后，于是正常盖在环上。
      // `clip-path:circle(50%)` 与 `border-radius:50%` 两个都写，是刻意的冗余：
      // 实测"环有的地方宽 9px、四个角几乎没有宽度" = 环宽**不均匀**，这是形状问题 ——
      // 说明内盘渲染成了**正方形**（正方形的角指向四个斜角，正好把环在那里整条盖掉，
      // 只剩正上正下正左正右露出 9px）。`clip-path` 不依赖 `border-radius`，能强制成圆。
      `.${CLASS.tipInner}{position:relative;width:164px;height:164px;border-radius:50%;clip-path:circle(50%);display:flex;flex-direction:column;`,
      `align-items:center;justify-content:center;text-align:center;`,
      `background:conic-gradient(var(--dsp-pc-dial,var(--dsw-alias-bg-overlay)) var(--dsp-pc-progress,0%),var(--dsp-pc-dial-rest,var(--dsw-alias-bg-overlay)) 0)}`,
      `.${CLASS.tipTime}{font-size:40px;line-height:1;font-weight:600;color:var(--dsw-alias-label-primary);`,
      `font-variant-numeric:tabular-nums;margin-bottom:9px}`,
      // 提醒句：换句时靠 React 的 key 换掉这个节点，这条动画随之重放（见 BreakTip）。
      `.${CLASS.tipText}{font-size:11px;line-height:15px;max-width:126px;color:var(--dsw-alias-label-secondary);`,
      `overflow-wrap:anywhere;animation:dsp-pc-tip-text 260ms ease-out}`,
      // ✕：留在圆内（顶到圆外会露在圆形背景之外），按下不抢焦点。位置随 180px 外收。
      `.${CLASS.tipClose}{position:absolute;top:28px;right:34px;box-sizing:border-box;display:inline-flex;`,
      `align-items:center;justify-content:center;width:20px;height:20px;padding:0;border:none;border-radius:999px;`,
      `background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;line-height:1;cursor:pointer}`,
      `.${CLASS.tipClose}:hover{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}`,
      `.${CLASS.tipClose}:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}`,
      `.${CLASS.tipClose} svg{display:block}`,
      // 小圆点：挂在部件根节点**内部**（`right:100%`），所以拖动圆盘/卡片时它跟着走，
      // 不需要任何测量代码。只有 30px，数字读的是同一个 snapshot，秒级 tick 照常刷新。
      `.${CLASS.tipDot}{position:absolute;right:100%;top:50%;translate:0 -50%;margin-right:6px;`,
      `box-sizing:border-box;width:30px;height:30px;padding:0;border-radius:50%;display:grid;place-items:center;`,
      `border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-specific-menu,var(--dsw-alias-bg-overlay));`,
      `box-shadow:var(--dsw-elevation-soft,0 8px 28px rgb(0 0 0 / 16%));color:var(--dsw-alias-label-primary);`,
      `font:inherit;font-size:9px;line-height:1;font-variant-numeric:tabular-nums;cursor:pointer;`,
      `animation:dsp-pc-tip-in 200ms ease-out}`,
      `.${CLASS.tipDot}:hover{background:var(--dsw-alias-bg-layer-2)}`,
      `.${CLASS.tipDot}:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}`,
      `@keyframes dsp-pc-tip-in{from{opacity:0;transform:scale(.94)}to{opacity:1;transform:none}}`,
      `@keyframes dsp-pc-tip-text{from{opacity:0}to{opacity:1}}`,
      // 减少动态效果：淡入与缩放**整个关掉**（不是缩短）。气泡照常出现、照常更新。
      `@media (prefers-reduced-motion:reduce){.${CLASS.tip},.${CLASS.tipDot},.${CLASS.tipText}{animation:none}}`,
    ].join('')

    // ---- 纯函数工具 ------------------------------------------------------

    const clamp = (value, min, max) => Math.min(max, Math.max(min, value))
    const clampInt = (value, min, max) => clamp(Math.round(value), min, max)

    /** 某个阶段配置的分钟数。 */
    const phaseMinutes = (settings, phase) => phase === 'focus'
      ? settings.focusMinutes
      : phase === 'short' ? settings.shortMinutes : settings.longMinutes

    /** 某个阶段的完整时长（毫秒）。 */
    const phaseDuration = (settings, phase) => phaseMinutes(settings, phase) * 60000

    /** `mm:ss`，向上取整，让刚进入的阶段显示完整时长。 */
    const formatClock = (seconds) => {
      const safe = Math.max(0, Math.round(seconds))
      return `${String(Math.floor(safe / 60)).padStart(2, '0')}:${String(safe % 60).padStart(2, '0')}`
    }

    /** 只保留认识的设置项，数值一律夹到合法区间。 */
    function normalizeSettings(input, base) {
      const settings = { ...base }
      if (input === null || typeof input !== 'object') return settings
      for (const [key, [min, max]] of Object.entries(NUMERIC_SETTINGS)) {
        const value = input[key]
        if (typeof value === 'number' && Number.isFinite(value)) settings[key] = clampInt(value, min, max)
      }
      for (const key of FLAG_SETTINGS) {
        if (typeof input[key] === 'boolean') settings[key] = input[key]
      }
      return settings
    }

    function readJson(key) {
      try {
        const raw = window.localStorage.getItem(key)
        if (raw === null) return null
        const parsed = JSON.parse(raw)
        return parsed !== null && typeof parsed === 'object' ? parsed : null
      } catch (error) {
        return null
      }
    }

    function writeJson(key, value) {
      try {
        window.localStorage.setItem(key, JSON.stringify(value))
      } catch (error) {
        // 存储不可用时也不影响本次会话内的计时。
      }
    }

    function removeKey(key) {
      try {
        window.localStorage.removeItem(key)
      } catch (error) {
        // 没有可清除的内容。
      }
    }

    // ---- 部件位置状态 ----------------------------------------------------

    /**
     * 位置与收起状态属于"浏览器"而不属于"计时"：
     * `pos` 为 null 表示用户还没拖过，此时交给 CSS 的默认位置。
     */
    function readUi() {
      const stored = readJson(UI_KEY)
      const position = stored !== null && stored.pos !== null && typeof stored.pos === 'object'
        && Number.isFinite(stored.pos?.x) && Number.isFinite(stored.pos?.y)
        ? { x: stored.pos.x, y: stored.pos.y }
        : null
      return { pos: position, collapsed: stored !== null && stored.collapsed === true }
    }

    // ---- 休息提醒：角度轮换、语言与请求 ----------------------------------

    // 角度 id 列表在客户端**必须自带一份**：client.js 是浏览器包（`window.__ModuleLoader__`
    // 的工厂），宿主半 index.js 是 ESM 模块，两者不共享模块系统，拿不到宿主那份 TIP_ANGLES。
    // 顺序即轮换顺序，两边必须逐项一致；宿主对不认识的取值一律回退到第一个，所以最坏情况
    // 只是这个新角度暂时用不上，不会报错。test/tip.test.mjs 按下面的标记切出来钉这两件事。
    // --- tip-angle:start ---
    /** 提醒角度的轮换顺序（宿主 TIP_ANGLES 的副本，见上）。 */
    const TIP_ANGLES = ['water', 'distance', 'walk', 'stretch', 'breathe']

    /**
     * 下一个角度。未知取值（宿主将来加了新角度、本地存了坏数据）不抛，从第一个角度起轮 ——
     * 与宿主的兜底同一套语义，最坏只是轮换少一档，不会让提醒句消失。
     * @param {string | null | undefined} prev 上一次用过的角度；没存过时为 null
     * @returns {string} 本次要用的角度 id
     */
    function nextAngle(prev) {
      return TIP_ANGLES[(TIP_ANGLES.indexOf(prev) + 1) % TIP_ANGLES.length]
    }
    // --- tip-angle:end ---

    /** 上一次用过的角度；没存过、或存了不认识的值时返回 null（首次即从第一个角度起轮）。 */
    function readAngle() {
      const stored = readJson(TIP_KEY)
      const angle = stored === null ? null : stored.angle
      return typeof angle === 'string' && TIP_ANGLES.includes(angle) ? angle : null
    }

    /** 落盘本次角度。**发请求之前就写**：失败也要轮换，否则一直 204 就永远停在同一个角度。 */
    function writeAngle(angle) {
      writeJson(TIP_KEY, { angle })
    }

    /**
     * 界面语言的短码（'zh' | 'en'），作为 query 参数发给宿主。
     *
     * 读 locale 服务的快照，而不是自己记一份：语言随时可切，快照才是当下值（语言切换会经
     * `subscribeLocale` 触发重渲染，所以这个值跟着更新，请求也随之重发）。
     * 只有 zh 发 'zh'，其余一律 'en'：宿主只认 'en' 走英文模板，其它取值会被它按中文处理
     * （prompt 要求写中文、长度按汉字数校验）—— 发给非中文界面等于拿中文的界去卡别的语言。
     * 读不到快照时也不抛，按 'en'。
     */
    function readLang(ctx) {
      try {
        const active = ctx.locale.getLocale().active
        return typeof active === 'string' && active.toLowerCase().startsWith('zh') ? 'zh' : 'en'
      } catch (error) {
        return 'en'
      }
    }

    /**
     * 拉一次提醒句。**永不抛**：204（宿主的每一条失败路径）/ 超时 / 断网 / 响应体不合形
     * 一律返回 null，调用方保持默认句 —— 气泡不会因为这句话变空或报错。
     * @param {string} url 请求地址（五个 query 参数都已带齐）
     * @param {AbortSignal} signal 同时承担 3.5 秒超时与"休息结束就取消"两种取消
     * @returns {Promise<string | null>} 可用的一句话，或 null
     */
    async function requestTip(url, signal) {
      try {
        const response = await fetch(url, { signal })
        // 204 是宿主的失败出口：它不是错误，但也没有正文可读。
        if (response.status !== 200) return null
        const body = await response.json()
        const text = body !== null && typeof body === 'object' ? body.text : null
        if (typeof text !== 'string') return null
        const trimmed = text.trim()
        return trimmed === '' ? null : trimmed
      } catch (error) {
        return null
      }
    }

    /**
     * 本次请求的取消信号：3.5 秒超时 + 休息结束时的主动取消，合成一个。
     *
     * `AbortSignal.any` 是 2024 年才齐的 API。万一环境里没有，宁可退化成"只带主动取消"
     * （超时还有宿主自己那道 3 秒），也绝不让构造信号这件事抛出去：这个 effect 抛错会被
     * 浮层的错误边界连整个时钟一起撤掉 —— 一个可选的提醒句不值得拿时钟来换。
     * @param {AbortController} controller 休息结束时由 effect 清理调用的那个
     * @returns {AbortSignal} fetch 用的信号
     */
    function tipSignal(controller) {
      try {
        return AbortSignal.any([controller.signal, AbortSignal.timeout(TIP_TIMEOUT_MS)])
      } catch (error) {
        return controller.signal
      }
    }

    // ---- 阶段结束提示音 --------------------------------------------------

    let audio = null

    /** 两声短音；专注阶段结束时音高更低。 */
    function chime(phase) {
      try {
        const Ctor = window.AudioContext ?? window.webkitAudioContext
        if (Ctor === undefined) return
        audio = audio ?? new Ctor()
        if (audio.state === 'suspended') void audio.resume()
        const base = phase === 'focus' ? 700 : 520
        const start = audio.currentTime
        for (const [index, frequency] of [base, base * 1.5].entries()) {
          const oscillator = audio.createOscillator()
          const gain = audio.createGain()
          const at = start + index * 0.18
          oscillator.type = 'sine'
          oscillator.frequency.value = frequency
          gain.gain.setValueAtTime(0.0001, at)
          gain.gain.exponentialRampToValueAtTime(0.14, at + 0.02)
          gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.16)
          oscillator.connect(gain)
          gain.connect(audio.destination)
          oscillator.start(at)
          oscillator.stop(at + 0.18)
        }
      } catch (error) {
        // 提示音是可选能力，任何异常都不该影响计时。
      }
    }

    function closeAudio() {
      if (audio === null) return
      const closing = audio
      audio = null
      try {
        void closing.close()
      } catch (error) {
        // 已经关闭过了。
      }
    }

    // ---- 计时模型 --------------------------------------------------------

    function createModel() {
      const listeners = new Set()
      let snapshot = null

      const state = {
        phase: 'focus',
        running: false,
        endsAt: 0,
        remainingMs: DEFAULT_SETTINGS.focusMinutes * 60000,
        completedFocus: 0,
        cycleFocus: 0,
        settings: { ...DEFAULT_SETTINGS },
        // 各阶段被切走时留下的"续跑点"，切回去可以接着走而不是从零开始。
        // 只有 switchPhase 会写入，且只记真正走过一部分的阶段；阶段自然走完、
        // 重开本阶段、清除统计时都会被清掉，避免旧进度在下次进入时冒出来。
        stash: {},
      }

      const stored = readJson(STORAGE_KEY)
      if (stored !== null) {
        state.settings = normalizeSettings(stored.settings, DEFAULT_SETTINGS)
        if (PHASES.includes(stored.phase)) state.phase = stored.phase
        if (Number.isFinite(stored.completedFocus) && stored.completedFocus >= 0) state.completedFocus = Math.floor(stored.completedFocus)
        if (Number.isFinite(stored.cycleFocus) && stored.cycleFocus >= 0) state.cycleFocus = Math.floor(stored.cycleFocus)
        if (stored.stash !== null && typeof stored.stash === 'object') {
          for (const phase of PHASES) {
            const value = stored.stash[phase]
            // 只有大于 0 的才是有效续跑点；超过当前时长的夹回去，改过设置也不会越界。
            if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
              state.stash[phase] = Math.min(value, phaseDuration(state.settings, phase))
            }
          }
        }
        const duration = phaseDuration(state.settings, state.phase)
        if (stored.running === true && Number.isFinite(stored.endsAt)) {
          // 存的是截止时刻而不是剩余量，所以刷新后能直接对上真实时间。
          state.running = true
          state.endsAt = stored.endsAt
          state.remainingMs = state.endsAt - Date.now()
        } else if (Number.isFinite(stored.remainingMs)) {
          state.remainingMs = Math.min(duration, Math.max(0, stored.remainingMs))
        }
      }

      function persist() {
        writeJson(STORAGE_KEY, {
          phase: state.phase,
          running: state.running,
          endsAt: state.endsAt,
          remainingMs: state.remainingMs,
          completedFocus: state.completedFocus,
          cycleFocus: state.cycleFocus,
          settings: state.settings,
          stash: state.stash,
        })
      }

      function computeSnapshot() {
        const duration = phaseDuration(state.settings, state.phase)
        const remainingMs = state.running
          ? Math.max(0, state.endsAt - Date.now())
          : Math.max(0, state.remainingMs)
        const seconds = Math.ceil(remainingMs / 1000)
        return {
          phase: state.phase,
          // 现在结束本阶段会进入哪里 —— 由模型算，视图不要自己复刻周期规则。
          // 专注阶段要用 cycleFocus + 1 判断，因为 completePhase 是先推进再判定。
          nextPhase: state.phase === 'focus'
            ? (state.cycleFocus + 1 >= state.settings.longEvery ? 'long' : 'short')
            : 'focus',
          running: state.running,
          seconds,
          totalSeconds: Math.round(duration / 1000),
          text: formatClock(seconds),
          progress: duration > 0 ? Math.min(1, Math.max(0, 1 - remainingMs / duration)) : 0,
          completedFocus: state.completedFocus,
          cycleFocus: state.cycleFocus,
          settings: state.settings,
        }
      }

      /** 只在"读者看得见的东西"真的变了时才通知，避免每 250ms 重渲染。 */
      function refresh() {
        const next = computeSnapshot()
        if (snapshot !== null
          && snapshot.phase === next.phase
          && snapshot.running === next.running
          && snapshot.seconds === next.seconds
          && snapshot.totalSeconds === next.totalSeconds
          && snapshot.completedFocus === next.completedFocus
          && snapshot.cycleFocus === next.cycleFocus
          && snapshot.settings === next.settings) return
        snapshot = next
        for (const listener of [...listeners]) {
          try {
            listener()
          } catch (error) {
            console.error(`${PLUGIN_ID}: snapshot listener failed`, error)
          }
        }
      }

      /** 停下计时，把当前阶段恢复到完整时长；该阶段的续跑点同时作废。 */
      function enterFresh(phase) {
        state.phase = phase
        state.remainingMs = phaseDuration(state.settings, phase)
        state.running = false
        state.endsAt = 0
        delete state.stash[phase]
      }

      /**
       * 进入下一个阶段。`at` 是新阶段开始计时的时刻 —— 传入上一阶段的截止时刻，
       * 阶段串起来就不会累积误差。
       *
       * `count` 为 false 表示"跳过"或"用户当时不在"，不计入番茄数；
       * `force` 表示无视"自动开始"设置继续串下去，只有补算时才用。
       */
      function completePhase(options, at) {
        const finishing = state.phase
        const fromFocus = finishing === 'focus'
        // 统计计数与周期位置是两件事，不能共用一个开关：
        //   completedFocus —— "真正完成了几个人番茄"，只有自然走完才算；
        //   cycleFocus     —— "在周期里的位置"，专注阶段无论怎么结束都往前推一格。
        // 早期版本把两者都挂在 options.count 上，于是「跳过」和「补算」都会把
        // 周期冻住，长休息永远不可达 —— longEvery=1 时甚至会进入一个按规则
        // 根本不该存在的短休息。
        if (fromFocus) {
          if (options.count === true) state.completedFocus += 1
          state.cycleFocus += 1
        }
        const long = fromFocus && state.cycleFocus >= state.settings.longEvery
        // 这里**不**清零。第四个专注结束时 cycleFocus 恰好等于 longEvery，那一刻
        // 「本轮已完成 4 个」就是事实 —— 在进入长休息的瞬间清零，会让 4/4 只存在
        // 零毫秒、任何一次渲染都观察不到，于是 `本轮 X/4` 的分子永远够不到分母，
        // 读起来像"永远完不成一轮"。清零挪到「下一个专注开始」时做，见下方归一化。
        const following = fromFocus ? (long ? 'long' : 'short') : 'focus'
        // 进入专注 = 新一轮开始，把上一轮遗留的满计数收掉。
        // 必须放在这里而不是"长休息走完时"：用户可以在长休息中途点 Tab 直接切到
        // 专注，那条路走 switchPhase，根本不经过 completePhase。
        if (following === 'focus' && state.cycleFocus >= state.settings.longEvery) state.cycleFocus = 0
        const autoStart = options.force === true
          ? true
          : options.count === true
            && (following === 'focus' ? state.settings.autoStartFocus : state.settings.autoStartBreak)
        // 走完的阶段不该再留续跑点，新进入的阶段也必须从完整时长开始 ——
        // 否则上一轮切走时存下的"还剩 3 分钟"会在这次进来时冒出来。
        delete state.stash[finishing]
        delete state.stash[following]
        state.phase = following
        state.remainingMs = phaseDuration(state.settings, following)
        if (autoStart) {
          state.running = true
          state.endsAt = at + state.remainingMs
        } else {
          state.running = false
          state.endsAt = 0
        }
        if (options.chime === true) chime(state.phase)
      }

      function mutate(operation) {
        operation()
        persist()
        refresh()
      }

      /**
       * 静默补齐页面关闭期间已经走完的阶段，让重开后落在墙钟真正对应的阶段上。
       * 补算的阶段不计入番茄数 —— 用户当时并不在。超过上限就当作过期运行重置。
       */
      function catchUp() {
        let replayed = 0
        while (state.running && state.endsAt <= Date.now() && replayed < CATCH_UP_LIMIT) {
          const endedAt = state.endsAt
          replayed += 1
          completePhase({ count: false, force: true, chime: false }, endedAt)
        }
        if (state.running && state.endsAt <= Date.now()) enterFresh('focus')
      }

      catchUp()

      return {
        getSnapshot() {
          if (snapshot === null) snapshot = computeSnapshot()
          return snapshot
        },
        subscribe(listener) {
          listeners.add(listener)
          return () => {
            listeners.delete(listener)
          }
        },
        tick() {
          const now = Date.now()
          if (state.running && state.endsAt <= now) {
            // 用截止时刻而不是当前时刻作为起点，误差不会被逐阶段放大。
            const endedAt = state.endsAt
            mutate(() => completePhase({ count: true, chime: state.settings.sound }, endedAt))
          } else {
            refresh()
          }
        },
        toggle() {
          mutate(() => {
            const now = Date.now()
            if (state.running) {
              state.remainingMs = Math.max(0, state.endsAt - now)
              state.running = false
              state.endsAt = 0
            } else {
              if (state.remainingMs <= 0) {
                state.remainingMs = phaseDuration(state.settings, state.phase)
                delete state.stash[state.phase]
              }
              state.running = true
              state.endsAt = now + state.remainingMs
            }
          })
        },
        reset() {
          mutate(() => {
            const now = Date.now()
            state.remainingMs = phaseDuration(state.settings, state.phase)
            state.endsAt = state.running ? now + state.remainingMs : 0
            // 重开就是从零开始，这个阶段的旧续跑点没有意义了。
            delete state.stash[state.phase]
          })
        },
        skip() {
          mutate(() => completePhase({ count: false, chime: false }, Date.now()))
        },
        /**
         * 胶囊标签切换阶段：切过去、**一律停住**，要真正开始得按「开始」。
         *
         * 不保留"正在计时"—— 点标签是导航，不是提交。让它切换后继续跑，等于
         * 在这条没有"阶段结束"事件的路径上自动开始了一个阶段：既和
         * autoStartBreak / autoStartFocus 的语义冲突（关掉自动开始却在
         * 这里被绕过），误触时也会静默开始一段你并没要过的休息。
         *
         * 但切换**不再销毁进度**：离开时把当前阶段已走剩下的部分记进 stash，
         * 切回来就续上（仍是暂停态）。这样"为了看一眼短休息几分钟"点一下
         * 再点回来，不会白白丢掉已经专注的时间。
         */
        switchPhase(phase) {
          if (!PHASES.includes(phase) || phase === state.phase) return
          mutate(() => {
            const leaving = state.phase
            const leftover = state.running
              ? Math.max(0, state.endsAt - Date.now())
              : state.remainingMs
            // 只有"走过一部分、又没走完"的阶段才值得留续跑点：
            // 完整未动的阶段切回来本来就该是完整时长，不必存。
            if (leftover > 0 && leftover < phaseDuration(state.settings, leaving)) {
              state.stash[leaving] = leftover
            } else {
              delete state.stash[leaving]
            }
            const duration = phaseDuration(state.settings, phase)
            const remembered = state.stash[phase]
            state.phase = phase
            // 与 completePhase 里同样的归一化：切进专注也意味着新一轮开始。
            // 少了这一句，用户在长休息中途切到专注时 cycleFocus 会一直卡在
            // longEvery 上，之后每次专注结束都会再判出一个长休息。
            if (phase === 'focus' && state.cycleFocus >= state.settings.longEvery) state.cycleFocus = 0
            state.remainingMs = typeof remembered === 'number' && remembered > 0
              ? Math.min(remembered, duration)
              : duration
            state.running = false
            state.endsAt = 0
          })
        },
        updateSettings(patch) {
          mutate(() => {
            const previous = state.settings
            state.settings = normalizeSettings({ ...previous, ...patch }, previous)
            const duration = phaseDuration(state.settings, state.phase)
            if (state.running) {
              const now = Date.now()
              const left = Math.min(Math.max(0, state.endsAt - now), duration)
              state.remainingMs = left
              state.endsAt = now + Math.max(1000, left)
            } else {
              const untouched = state.remainingMs >= phaseDuration(previous, state.phase) - 1000
              state.remainingMs = untouched ? duration : Math.min(state.remainingMs, duration)
            }
          })
        },
        resetAll() {
          mutate(() => {
            removeKey(STORAGE_KEY)
            state.settings = { ...DEFAULT_SETTINGS }
            state.completedFocus = 0
            state.cycleFocus = 0
            state.stash = {}
            enterFresh('focus')
          })
        },
        refresh() {
          refresh()
        },
        dispose() {
          listeners.clear()
          closeAudio()
        },
      }
    }

    // ---- 图标：内联 SVG，用 currentColor，不依赖任何图标库 ----------------

    function icon(children) {
      return h('svg', {
        viewBox: '0 0 16 16',
        width: 13,
        height: 13,
        'aria-hidden': true,
        focusable: false,
      }, children)
    }

    const playIcon = () => icon(h('path', { d: 'M5 3.4v9.2L13 8z', fill: 'currentColor' }))

    const pauseIcon = () => icon([
      h('rect', { key: 'a', x: 4.6, y: 3.4, width: 2.4, height: 9.2, rx: 0.8, fill: 'currentColor' }),
      h('rect', { key: 'b', x: 9, y: 3.4, width: 2.4, height: 9.2, rx: 0.8, fill: 'currentColor' }),
    ])

    const resetIcon = () => icon([
      h('path', { key: 'a', d: 'M13 8a5 5 0 1 1-1.6-3.7', fill: 'none', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round' }),
      h('path', { key: 'b', d: 'M13.2 2.6v2.6h-2.6', fill: 'none', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round', strokeLinejoin: 'round' }),
    ])

    const skipIcon = () => icon([
      h('path', { key: 'a', d: 'M3.6 3.6v8.8L10.2 8z', fill: 'currentColor' }),
      h('rect', { key: 'b', x: 11, y: 3.6, width: 1.8, height: 8.8, rx: 0.7, fill: 'currentColor' }),
    ])

    const gearIcon = () => icon([
      h('circle', { key: 'a', cx: 8, cy: 8, r: 2.1, fill: 'none', stroke: 'currentColor', strokeWidth: 1.4 }),
      h('path', {
        key: 'b',
        d: 'M8 1.7v1.9M8 12.4v1.9M1.7 8h1.9M12.4 8h1.9M3.6 3.6l1.3 1.3M11.1 11.1l1.3 1.3M12.4 3.6l-1.3 1.3M4.9 11.1l-1.3 1.3',
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.4,
        strokeLinecap: 'round',
      }),
    ])

    const collapseIcon = () => icon(
      h('path', { d: 'M3.5 8h9', fill: 'none', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round' }))

    /** 气泡右上角的 ✕：收起成小圆点。 */
    const closeIcon = () => icon([
      h('path', { key: 'a', d: 'M4.3 4.3l7.4 7.4', fill: 'none', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round' }),
      h('path', { key: 'b', d: 'M11.7 4.3l-7.4 7.4', fill: 'none', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round' }),
    ])

    /**
     * 左上角的番茄钟图标：立体番茄 + 暖白表盘 + 时针分针。
     *
     * 让它像番茄而不是像一颗红蛋，靠三件事：
     *   1. 果实画成略扁的椭圆（横比纵宽），用径向渐变做出"熟透发亮"的观感 ——
     *      左上偏亮、边缘压暗，再叠一片低透明度的斜向高光；
     *   2. 顶部是六片放射状绿萼加一根果蒂，萼片横向展开得比果实肩部更宽，
     *      这是番茄最容易辨认的特征；
     *   3. 表盘嵌在果实正中，用暖白而不是纯白，免得在深色卡片上刺眼。
     *
     * 指针固定指向 15:00 —— 时针朝右（3 点方向），分针朝上（12 点方向）。
     */
    function tomatoIcon() {
      return h('svg', {
        className: CLASS.tomato,
        viewBox: '0 0 24 24',
        width: 24,
        height: 24,
        'aria-hidden': true,
        focusable: false,
      },
      h('defs', { key: 'defs' },
        // 果实：左上高光 → 主体珊瑚红 → 边缘深红
        h('radialGradient', { key: 'body', id: 'dsp-pc-tomato-body', cx: '36%', cy: '26%', r: '80%' },
          h('stop', { key: 'a', offset: '0%', stopColor: '#f4907a' }),
          h('stop', { key: 'b', offset: '42%', stopColor: '#e8604a' }),
          h('stop', { key: 'c', offset: '100%', stopColor: '#c43b24' })),
        // 绿萼与果蒂：上亮下暗
        h('linearGradient', { key: 'leaf', id: 'dsp-pc-tomato-leaf', x1: '0', y1: '0', x2: '0', y2: '1' },
          h('stop', { key: 'a', offset: '0%', stopColor: '#7cc463' }),
          h('stop', { key: 'b', offset: '100%', stopColor: '#3f8a34' }))),
      // 果实：略扁的椭圆
      h('ellipse', { key: 'body', cx: 12, cy: 14.4, rx: 8.6, ry: 7.4, fill: 'url(#dsp-pc-tomato-body)' }),
      // 左上高光：果实的油亮反光
      h('ellipse', {
        key: 'gloss',
        cx: 9.3,
        cy: 10.9,
        rx: 2.6,
        ry: 1.7,
        fill: '#ffffff',
        opacity: 0.22,
        transform: 'rotate(-30 9.3 10.9)',
      }),
      // 六片放射状绿萼：相邻两片相隔 60°，横向两片伸到果实肩部之外
      h('path', {
        key: 'calyx',
        d: 'M14.1 3.16L13.21 6.1L16.2 6.8L13.21 7.5L14.1 10.44L12 8.2L9.9 10.44L10.79 7.5L7.8 6.8L10.79 6.1L9.9 3.16L12 5.4Z',
        fill: 'url(#dsp-pc-tomato-leaf)',
        stroke: '#4f9c40',
        strokeWidth: 0.6,
        strokeLinejoin: 'round',
      }),
      // 果蒂
      h('rect', {
        key: 'stem',
        x: 11.25,
        y: 2.6,
        width: 1.5,
        height: 4.2,
        rx: 0.75,
        fill: 'url(#dsp-pc-tomato-leaf)',
      }),
      // 暖白表盘
      h('circle', { key: 'face', cx: 12, cy: 14.4, r: 5, fill: '#fff8f2' }),
      // 时针：指向 3 点方向
      h('line', {
        key: 'hour',
        x1: 12,
        y1: 14.4,
        x2: 15.1,
        y2: 14.4,
        stroke: '#b8352a',
        strokeWidth: 1.7,
        strokeLinecap: 'round',
      }),
      // 分针：指向 12 点方向
      h('line', {
        key: 'minute',
        x1: 12,
        y1: 14.4,
        x2: 12,
        y2: 9.9,
        stroke: '#b8352a',
        strokeWidth: 1.4,
        strokeLinecap: 'round',
      }))
    }

    // ---- 视图层 hooks ----------------------------------------------------

    /**
     * 阶段名的字面量调用 —— 三个 `t()` 都写成字面量，语言包键名一目了然。
     * 提到模块作用域是因为「跳到…」按钮在设置面板里也要用它。
     */
    function phaseLabelOf(t, phase) {
      return phase === 'focus'
        ? t('phase.focus')
        : phase === 'short' ? t('phase.short') : t('phase.long')
    }

    /** 订阅模型；快照引用只在真正变化时才换，因此不会每帧重渲染。 */
    function usePomodoro(model) {
      const [value, setValue] = React.useState(() => model.getSnapshot())
      React.useEffect(() => {
        setValue(model.getSnapshot())
        return model.subscribe(() => setValue(model.getSnapshot()))
      }, [model])
      return value
    }

    /** 语言切换时重渲染；`t` 在调用时读取当前语言，所以无需重新绑定。 */
    function useLocaleRefresh(subscribeLocale) {
      const [, setRevision] = React.useState(0)
      React.useEffect(() => {
        if (typeof subscribeLocale !== 'function') return undefined
        return subscribeLocale(() => setRevision((revision) => revision + 1))
      }, [subscribeLocale])
    }

    // ---- 组成部件 --------------------------------------------------------

    /** 数字输入框：输入过程中保留原始文本，失焦或回车才提交。 */
    function NumberField({ label, unit, value, min, max, onCommit }) {
      const [draft, setDraft] = React.useState(String(value))
      React.useEffect(() => {
        setDraft(String(value))
      }, [value])
      const commit = () => {
        const parsed = Number.parseInt(draft, 10)
        if (Number.isFinite(parsed)) onCommit(clampInt(parsed, min, max))
        else setDraft(String(value))
      }
      return h('label', { className: CLASS.field },
        h('span', null, label),
        h('span', { className: CLASS.fieldEnd },
          h('input', {
            className: CLASS.input,
            type: 'number',
            inputMode: 'numeric',
            min,
            max,
            step: 1,
            value: draft,
            'aria-label': label,
            onChange: (event) => setDraft(event.target.value),
            onBlur: commit,
            onKeyDown: (event) => {
              if (event.key !== 'Enter') return
              event.preventDefault()
              commit()
              event.currentTarget.blur()
            },
          }),
          h('span', { className: CLASS.unit }, unit)))
    }

    function CheckField({ label, checked, onChange }) {
      return h('label', { className: CLASS.check },
        h('input', {
          type: 'checkbox',
          checked,
          onChange: (event) => onChange(event.target.checked),
        }),
        h('span', null, label))
    }

    /** 设置面板：统计信息 + 时长 + 开关 + 次要操作，全部收在这里。 */
    function SettingsPanel({ snap, pomodoro, t }) {
      const settings = snap.settings
      return h('div', { className: CLASS.panel, role: 'group', 'aria-label': t('action.settings') },
        h('span', { className: CLASS.panelTitle }, t('settings.title')),
        h('span', { className: CLASS.stats },
          `\u{1F345} ${t('stats.completed')} ${snap.completedFocus} · ${t('stats.cycle')} ${snap.cycleFocus}/${settings.longEvery}`),
        h(NumberField, {
          label: t('settings.focus'),
          unit: t('settings.minutes'),
          value: settings.focusMinutes,
          min: NUMERIC_SETTINGS.focusMinutes[0],
          max: NUMERIC_SETTINGS.focusMinutes[1],
          onCommit: (value) => pomodoro.updateSettings({ focusMinutes: value }),
        }),
        h(NumberField, {
          label: t('settings.short'),
          unit: t('settings.minutes'),
          value: settings.shortMinutes,
          min: NUMERIC_SETTINGS.shortMinutes[0],
          max: NUMERIC_SETTINGS.shortMinutes[1],
          onCommit: (value) => pomodoro.updateSettings({ shortMinutes: value }),
        }),
        h(NumberField, {
          label: t('settings.long'),
          unit: t('settings.minutes'),
          value: settings.longMinutes,
          min: NUMERIC_SETTINGS.longMinutes[0],
          max: NUMERIC_SETTINGS.longMinutes[1],
          onCommit: (value) => pomodoro.updateSettings({ longMinutes: value }),
        }),
        h(NumberField, {
          label: t('settings.longEvery'),
          unit: t('settings.every'),
          value: settings.longEvery,
          min: NUMERIC_SETTINGS.longEvery[0],
          max: NUMERIC_SETTINGS.longEvery[1],
          onCommit: (value) => pomodoro.updateSettings({ longEvery: value }),
        }),
        h(CheckField, {
          label: t('settings.autoStartBreak'),
          checked: settings.autoStartBreak,
          onChange: (value) => pomodoro.updateSettings({ autoStartBreak: value }),
        }),
        h(CheckField, {
          label: t('settings.autoStartFocus'),
          checked: settings.autoStartFocus,
          onChange: (value) => pomodoro.updateSettings({ autoStartFocus: value }),
        }),
        h(CheckField, {
          label: t('settings.sound'),
          checked: settings.sound,
          onChange: (value) => pomodoro.updateSettings({ sound: value }),
        }),
        // 关掉就连请求都不发：气泡照样出、照样显示默认句（见 PomodoroClock 的 effect 守卫）。
        h(CheckField, {
          label: t('settings.aiTip'),
          checked: settings.aiTip,
          onChange: (value) => pomodoro.updateSettings({ aiTip: value }),
        }),
        h('div', { className: CLASS.actions },
          h('button', {
            type: 'button',
            className: CLASS.btn,
            onClick: () => pomodoro.reset(),
          }, resetIcon(), h('span', null, t('action.reset'))),
          h('button', {
            type: 'button',
            className: CLASS.btn,
            onClick: () => pomodoro.skip(),
          }, skipIcon(), h('span', null, `${t('action.skip')} · ${phaseLabelOf(t, snap.nextPhase)}`)),
          h('button', {
            type: 'button',
            className: CLASS.btn,
            onClick: () => pomodoro.resetAll(),
          }, t('settings.resetStats'))))
    }

    /** 标题栏里的按钮不能触发拖动。 */
    const stopPointer = (event) => {
      event.stopPropagation()
    }

    // --- tip-key:start ---
    /**
     * 折叠态圆盘根节点的按键处理：只有按键**发生在根节点本身**时才展开面板。
     *
     * 为什么必须看 target：小圆点（TipDot）是根节点的子节点，它自己也是一个真实的 button，
     * 并且是键盘用户展开气泡的唯一入口。Enter/空格在它身上按下时照样会冒泡到根节点的
     * onKeyDown —— 在那里不加区分地 preventDefault()，被取消的正是小圆点**原生的点击**，
     * 结果是「按 Enter 想展开气泡，却把整个时钟展开成了面板」，而气泡再也回不来。
     * 鼠标路径没有这个问题，只是因为小圆点的 onPointerDown 把冒泡截住了。
     *
     * 返回值只给测试看（test/tip.test.mjs 按这里的标记切片求值）：true = 本函数接手了这次按键。
     * @param {{ target: unknown, currentTarget: unknown, key: string, preventDefault(): void }} event
     * @param {() => void} expandPanel 展开面板
     * @returns {boolean} 是否已处理这次按键
     */
    function miniRootKeyDown(event, expandPanel) {
      if (event.target !== event.currentTarget) return false
      if (event.key !== 'Enter' && event.key !== ' ') return false
      event.preventDefault()
      expandPanel()
      return true
    }
    // --- tip-key:end ---

    // --- tip-focus:start ---
    /**
     * ✕ 的这次激活是不是键盘来的。
     *
     * 为什么必须分开：鼠标点 ✕ 时焦点本来就该留在用户原来编辑的地方（所以 ✕ 的 mousedown 里
     * preventDefault，气泡挂载时也不抢焦点）；但**键盘**激活 ✕ 之后气泡随卸载消失，焦点掉回
     * `document.body`，剩下的唯一控件是那个 30px 小圆点——键盘用户得从文档开头重新 Tab 一整圈
     * 才能碰到它，README 里「键盘可达」那句话在这一步是假的。这条修复只覆盖键盘路径，
     * 与 spec 的「不抢输入焦点」（讲的是气泡**自己冒出来**时不许抢）不冲突。
     *
     * 判定用 MouseEvent.detail：真实指针点击是点击计数（≥1），键盘（Enter/空格）与辅助技术
     * 合成的 click 都是 0。没有 detail 字段时按「不是键盘」处理——宁可不动焦点，也不误抢。
     * 返回值只给测试看（test/tip.test.mjs 按这里的标记切片求值）。
     * @param {{ detail?: number } | undefined} event ✕ 上的 click 事件
     * @returns {boolean} true = 这次收起要把焦点交给小圆点
     */
    function tipCloseFromKeyboard(event) {
      return event?.detail === 0
    }
    // --- tip-focus:end ---

    // --- tip-round:start ---
    /**
     * 发给宿主的 round 参数：休息期间 cycleFocus 就是「本轮第几个番茄」（专注结束时先加一、
     * 再判长休息），**但它可以是 0**：开机、长休息结束回到专注、长休息中途切到专注、清除统计
     * 之后，这四种状态都是一次普通点击就能到的（点「短休息」胶囊）。
     *
     * 0 是宿主**接受**的合法整数（0 不是非法输入），所以不会 204——它会一路走进 prompt，
     * 让模型听到「本轮第 0 个番茄」这个假前提，然后顺着编。宿主那边有意不做静默兜底
     * （见 index.js 的 parseCount：严格是策略，不是疏漏），所以圆场必须在客户端做：
     * 钳到 1 是这四个状态下最不误导的说法（0 只表示「还没走完一个番茄」）。
     * 返回值只给测试看（test/tip.test.mjs 按这里的标记切片求值）。
     * @param {number} cycleFocus 模型里的周期位置（可能是 0）
     * @returns {string} 最小为 1 的整数字符串
     */
    function tipRoundParam(cycleFocus) {
      return String(Math.max(1, cycleFocus))
    }
    // --- tip-round:end ---

    /**
     * **屏幕正中央**的 180px 圆形气泡：**放大版的圆盘** —— 外环阶段色（已走实心 / 未走淡）、
     * 内盘深一档的两段色、中心 40px 倒计时，下面接一句提醒。不再显示阶段名（圆盘上本来也没有）。
     *
     * 它和时钟根节点是**兄弟**（都直接挂在整帧浮层里）：气泡的参考系是整帧（正中央），
     * 时钟是被拖动或贴着右下角的另一个盒子，两者不能共用一个容器。各是各的尺寸，
     * 浮层其余部分照旧点击穿透。
     * 不抢输入焦点：挂载时不调用 focus()，✕ 的 mousedown 也 preventDefault ——
     * 点它不会把光标从正在编辑的地方带走。
     * 唯一的例外是**键盘**激活 ✕（见 tipCloseFromKeyboard）：那不是「抢」，是收尾——
     * 被激活的按钮马上要随气泡一起卸载，焦点无主，交给小圆点才不会让键盘用户从头 Tab。
     * @param {{ onDismiss: (fromKeyboard: boolean) => void }} props
     *   onDismiss 的参数为 true 表示这次收起来自键盘激活（见 tipCloseFromKeyboard）。
     */
    // 气泡的阶段色用**内联**方式发过去，不走 CSS 继承。
    //
    // 原因：气泡和时钟根节点是**兄弟**（都直接挂在整帧浮层里），兄弟之间不继承自定义属性。
    // 早先用"给 `.dsp-pc-tip[data-phase=…]` 也写一条映射规则"来补；那条路能work，但它依赖
    // 选择器匹配、样式表顺序与继承三者**全部**正确 —— 任何一处出问题，四个变量会同时落到
    // 兜底值，表现是"整圈一个颜色、看不出扇形、且和圆盘颜色不一样"，而且完全静默、没有报错。
    // 内联样式没有这些环节：写在元素上就是那个值。
    const TIP_PHASE_VARS = {
      focus: {
        '--dsp-pc-ring': 'var(--dsp-pc-ring-focus)',
        '--dsp-pc-ring-soft': 'var(--dsp-pc-ring-focus-soft)',
        '--dsp-pc-dial': 'var(--dsp-pc-dial-focus)',
        '--dsp-pc-dial-rest': 'var(--dsp-pc-dial-focus-rest)',
      },
      short: {
        '--dsp-pc-ring': 'var(--dsp-pc-ring-short)',
        '--dsp-pc-ring-soft': 'var(--dsp-pc-ring-short-soft)',
        '--dsp-pc-dial': 'var(--dsp-pc-dial-short)',
        '--dsp-pc-dial-rest': 'var(--dsp-pc-dial-short-rest)',
      },
      long: {
        '--dsp-pc-ring': 'var(--dsp-pc-ring-long)',
        '--dsp-pc-ring-soft': 'var(--dsp-pc-ring-long-soft)',
        '--dsp-pc-dial': 'var(--dsp-pc-dial-long)',
        '--dsp-pc-dial-rest': 'var(--dsp-pc-dial-long-rest)',
      },
    }

    // 气泡外环的几何：半径与周长。SVG 用 dasharray/dashoffset 表示进度，周长是个常数。
    // r = 85.5：180px 泡、9px 环 → 环中线落在 r=85.5，占 r 81~90，与 162px 内盘（r=81）严丝合缝。
    const TIP_RING_R = 85.5
    const TIP_RING_C = 2 * Math.PI * TIP_RING_R

    function BreakTip({ snap, t, sentence, onDismiss }) {
      // 进度按 0~1 收口：NaN / 越界值都会让 dashoffset 变成无效字符串，环直接画不出来。
      const tipPercent = Math.min(1, Math.max(0, Number(snap.progress) || 0))
      return h('div', {
        className: CLASS.tip,
        role: 'group',
        'aria-label': t('tip.title'),
        // 留作排查用（肉眼能在元素面板里看到当前阶段），颜色本身不依赖它。
        'data-phase': snap.phase,
        style: {
          // 阶段色：外环两段 + 内盘两段，内联，见上面的 TIP_PHASE_VARS。
          ...(TIP_PHASE_VARS[snap.phase] ?? TIP_PHASE_VARS.focus),
          // 进度值：和圆盘共用同一个自定义属性名，外环与内盘都读它画扇形。
          '--dsp-pc-progress': `${Math.round(snap.progress * 100)}%`,
        },
      },
      h('button', {
        type: 'button',
        className: CLASS.tipClose,
        onMouseDown: (event) => event.preventDefault(),
        // detail === 0 说明这次 click 是键盘/辅助技术合成的：收起之后要把焦点交给小圆点。
        onClick: (event) => onDismiss(tipCloseFromKeyboard(event)),
        'aria-label': t('action.dismissTip'),
        title: t('action.dismissTip'),
      }, closeIcon()),
      // 外环：**SVG 描边**，不用 conic-gradient —— 后者在四个象限边界会留 1px 接缝，
      // 9px 宽的环上表现为"每一边正中出现一小段有颜色的线"（实测反馈）。
      // r=85.5、stroke-width=9 → 环占 r 81~90；内盘 162px（r=81）与之正好接上，不留缝。
      // 进度用 dasharray/dashoffset 表达，起点靠 rotate(-90) 挪到正上方。
      // 画在按钮与内盘**之间**：接缝没有了，但 ✕ 落在内盘范围内（距圆心约 69 < 81），不会被环压到。
      h('svg', {
        className: CLASS.tipRing,
        viewBox: '0 0 180 180',
        'aria-hidden': 'true',
        focusable: 'false',
      },
      h('circle', {
        cx: 90, cy: 90, r: TIP_RING_R, fill: 'none', strokeWidth: 9,
        // 颜色必须走 `style`，**不能**写成 `stroke="var(--…)"` 这种 presentation attribute：
        // 自定义属性在那类属性里支持不可靠，失效就等于不描边 —— 整圈底色轨道会整个消失，
        // 只剩进度弧那一截，看上去"环不完整、大片没有颜色"（实测反馈）。
        style: { stroke: 'var(--dsp-pc-ring-soft,var(--dsw-alias-state-error-primary))' },
      }),
      h('circle', {
        cx: 90, cy: 90, r: TIP_RING_R, fill: 'none', strokeWidth: 9,
        style: { stroke: 'var(--dsp-pc-ring,var(--dsw-alias-state-error-primary))' },
        strokeDasharray: TIP_RING_C,
        strokeDashoffset: TIP_RING_C * (1 - tipPercent),
        transform: 'rotate(-90 90 90)',
      })),
      // 内盘：与圆盘同构，只在读数下面多接一句提醒。**不再显示阶段名** —— 圆盘本来就没有，
      // 阶段由环的颜色表达；重复写一个名字正是"挤"和"不好看"的来源。
      h('div', { className: CLASS.tipInner },
        // 剩余时间与卡片/圆盘读同一个 snapshot，所以秒级 tick 照常刷新它。
        h('div', { className: CLASS.tipTime, role: 'timer', 'aria-live': 'off' }, snap.text),
        // key 换成句子就重挂这一行，CSS 的淡入随之重放：默认句 → AI 句是"换"而不是"跳"。
        // sentence 为 null 时显示 i18n 的默认句 —— 中文不写死在逻辑里。
        h('span', {
          key: sentence ?? 'tip-fallback',
          className: CLASS.tipText,
        }, sentence ?? t('tip.fallback'))))
    }

    /**
     * 收起后的小圆点：挨着圆盘/卡片，只显示剩余时间。
     *
     * 挂在时钟根节点**内部**（CSS 用 `right:100%` 贴到它左边），所以拖动圆盘、在圆盘与
     * 面板之间切换，它都跟着走，不需要任何测量。
     * `onPointerDown` 必须截住：圆盘态的父节点在 pointerdown 上起拖动、按位移判点击，
     * 不截住的话点这个小圆点会顺带把部件展开成面板。
     *
     * **已知的 ARIA 代价（有意保留，不是疏漏）**：圆盘态的父节点是 `role="button"`，而
     * button 这个角色的后代在可访问性树里按规范是 presentational —— 也就是说这个真实
     * `<button>`（连同它的 aria-label）可能**不会被当成独立控件**暴露给辅助技术：用户听到的
     * 是外层那个「展开 · 阶段 剩余时间」按钮。仍然可用的两条路是鼠标点击、以及键盘 Tab 到它
     * 再按 Enter/空格展开气泡（后者由 miniRootKeyDown 保证，见那个函数的说明）。
     * 替代方案是把小圆点挪到根节点外面，那就需要"测量根节点位置"的循环才跟得上被拖动的圆盘
     * —— 比"某个屏幕阅读器少一个控件"更糟，所以维持嵌套。**改这里前先读这段。**
     *
     * innerRef 是给键盘路径用的（Finding 6）：✕ 被键盘激活而收起时，焦点要在提交之后落到这里。
     * 用自定义属性名而不是 `ref`：TipDot 是普通函数组件，React 18 下 `ref` 需要 forwardRef 才
     * 传得进去，改属性名就不用赌运行时的 React 版本。
     * @param {{ innerRef?: { current: unknown } }} props
     */
    function TipDot({ snap, t, onExpand, innerRef }) {
      const label = `${t('action.expandTip')} · ${snap.text}`
      return h('button', {
        type: 'button',
        ref: innerRef,
        className: CLASS.tipDot,
        onPointerDown: stopPointer,
        onMouseDown: (event) => event.preventDefault(),
        onClick: onExpand,
        'aria-label': label,
        title: label,
      }, snap.text)
    }

    function PomodoroClock({ pomodoro, t, subscribeLocale, getLang }) {
      const snap = usePomodoro(pomodoro)
      const [ui, setUi] = React.useState(readUi)
      const [open, setOpen] = React.useState(false)
      const [dragging, setDragging] = React.useState(false)
      // 气泡自己的两件状态：是否被 ✕ 收成了小圆点、以及拿回来的那句提醒。
      // 两者都不落盘 —— 它们只属于"当前这一轮休息"，刷新页面后重新来一次是正确的。
      const [tipDismissed, setTipDismissed] = React.useState(false)
      const [tipSentence, setTipSentence] = React.useState(null)
      const rootRef = React.useRef(null)
      // 键盘激活 ✕ 时把焦点交给小圆点（Finding 6）：见 tipCloseFromKeyboard 与下面的 effect。
      const tipDotRef = React.useRef(null)
      const restoreTipFocus = React.useRef(false)
      useLocaleRefresh(subscribeLocale)

      /** ✕ 收起气泡。fromKeyboard 为真才动焦点——鼠标点击时焦点该留在用户原来编辑的地方，
       *  那条「不抢输入焦点」的约束在这里继续成立（见 BreakTip 的说明）。 */
      const dismissTip = (fromKeyboard) => {
        restoreTipFocus.current = fromKeyboard === true
        setTipDismissed(true)
      }

      // 焦点只能在**提交之后**交给小圆点：收起的那一刻它才挂载。标记在这里清掉，
      // 免得下一轮休息复用时凭空抢一次焦点。restoreTipFocus 为假时（鼠标点 ✕）什么都不做。
      React.useEffect(() => {
        if (!tipDismissed || !restoreTipFocus.current) return
        restoreTipFocus.current = false
        tipDotRef.current?.focus?.()
      }, [tipDismissed])

      // 休息阶段的判断只在这里做一次：三个阶段里只有 short / long 出气泡，
      // 切到专注就是"散掉"（return null 的渲染分支 + effect 清理里的 abort）。
      const breakPhase = snap.phase === 'focus' ? null : snap.phase
      const lang = getLang()
      const aiTip = snap.settings.aiTip === true

      // 折叠态不跨轮次：休息结束、或从一种休息切到另一种，下一个休息重新给大气泡。
      React.useEffect(() => {
        setTipDismissed(false)
      }, [breakPhase])

      /**
       * 休息开始时拉一次提醒句；任何失败都保持默认句、不做任何提示（失败矩阵见设计文档）。
       * 依赖只有三个原始值（阶段 / 语言 / AI 开关），所以秒级 tick 不会重发请求；
       * 反过来，语言或开关中途变了会重新发一次，气泡里的句子跟着换成对应语言的。
       */
      React.useEffect(() => {
        // 换阶段或换语言后先回到默认句：上一轮/上一语言的句子立刻作废，不留过期文案。
        setTipSentence(null)
        if (breakPhase === null || !aiTip) return undefined
        // 角度先落盘再发请求：这次失败也要轮换，否则一直 204 就永远停在同一个角度。
        const angle = nextAngle(readAngle())
        writeAngle(angle)
        const controller = new AbortController()
        let live = true
        // 五个参数一个都不能少：宿主对缺席、非数字或非整数（小数/负数）的 round / done
        // 一律 204（它有意不做 Number(null) === 0 那种静默兜底，见 index.js 的 parseCount）。
        const query = new URLSearchParams({
          phase: breakPhase,
          // 0 必须在这里钳成 1：宿主接受 0，于是 prompt 会真写出「本轮第 0 个番茄」。
          // 四种到达方式与理由见 tipRoundParam 的说明。
          round: tipRoundParam(snap.cycleFocus),
          // 模型没有"今天"这个维度，completedFocus 就是设置面板里那个「已完成」总数；
          // 宿主 prompt 因此只写「已完成（累计）」，不写"今天"（见 index.js 的 buildTipPrompt）。
          done: String(snap.completedFocus),
          angle,
          lang,
        })
        void requestTip(
          `/pomodoro/tip?${query.toString()}`,
          // 两种取消合成一个 signal：3.5 秒超时，以及休息一结束就 abort（见返回值）。
          tipSignal(controller),
        ).then((text) => {
          // Review Focus 4：响应可能晚于这次休息到达（用户切到专注、或休息走完）。
          // 那两种情况下这个 effect 已经被清理：live 为 false、请求已 abort，
          // 所以迟到的响应绝不替换默认句，也不会让已经消失的气泡复活。
          if (!live || text === null) return
          setTipSentence(text)
        })
        return () => {
          live = false
          controller.abort()
        }
      }, [breakPhase, lang, aiTip])

      const updateUi = (patch) => {
        const next = { ...ui, ...patch }
        writeJson(UI_KEY, next)
        setUi(next)
      }

      /** 窗口缩小时把已经拖出去的部件拉回可视区。 */
      React.useEffect(() => {
        const settle = () => {
          const node = rootRef.current
          if (node === null) return
          setUi((current) => {
            if (current.pos === null) return current
            const layer = node.offsetParent
            const rect = node.getBoundingClientRect()
            const width = layer === null ? window.innerWidth : layer.clientWidth
            const height = layer === null ? window.innerHeight : layer.clientHeight
            const x = clamp(current.pos.x, 0, Math.max(0, width - rect.width))
            const y = clamp(current.pos.y, 0, Math.max(0, height - rect.height))
            if (x === current.pos.x && y === current.pos.y) return current
            const next = { ...current, pos: { x, y } }
            writeJson(UI_KEY, next)
            return next
          })
        }
        settle()
        window.addEventListener('resize', settle)
        return () => window.removeEventListener('resize', settle)
      }, [])

      /**
       * 在 window 上监听拖动。位移没超过阈值的按下算点击 —— 圆盘就是靠这个展开的。
       */
      const beginDrag = (event, onTap) => {
        if (event.button !== 0) return
        const node = rootRef.current
        if (node === null) return
        const layer = node.offsetParent
        const layerRect = layer === null ? null : layer.getBoundingClientRect()
        const rect = node.getBoundingClientRect()
        const baseLeft = rect.left - (layerRect === null ? 0 : layerRect.left)
        const baseTop = rect.top - (layerRect === null ? 0 : layerRect.top)
        const spanX = (layerRect === null ? window.innerWidth : layerRect.width) - rect.width
        const spanY = (layerRect === null ? window.innerHeight : layerRect.height) - rect.height
        const startX = event.clientX
        const startY = event.clientY
        const pointerId = event.pointerId
        let travelled = false
        let latest = null

        const move = (moveEvent) => {
          if (moveEvent.pointerId !== pointerId) return
          const dx = moveEvent.clientX - startX
          const dy = moveEvent.clientY - startY
          if (!travelled && Math.abs(dx) + Math.abs(dy) < DRAG_THRESHOLD) return
          if (!travelled) {
            travelled = true
            setDragging(true)
          }
          latest = {
            x: clamp(baseLeft + dx, 0, Math.max(0, spanX)),
            y: clamp(baseTop + dy, 0, Math.max(0, spanY)),
          }
          setUi((current) => ({ ...current, pos: latest }))
        }
        const end = () => {
          window.removeEventListener('pointermove', move)
          window.removeEventListener('pointerup', end)
          window.removeEventListener('pointercancel', end)
          setDragging(false)
          if (!travelled) {
            if (typeof onTap === 'function') onTap()
            return
          }
          // 落盘用最后一次指针位置，避免用到还没渲染完的旧状态。
          writeJson(UI_KEY, { ...readUi(), pos: latest })
          setUi((current) => ({ ...current, pos: latest }))
        }
        window.addEventListener('pointermove', move)
        window.addEventListener('pointerup', end)
        window.addEventListener('pointercancel', end)
      }

      /** 阶段名走字面量调用，语言包键名一目了然。 */
      const phaseLabel = (phase) => phaseLabelOf(t, phase)
      const percent = Math.round(snap.progress * 100)
      const floating = ui.pos !== null
      const style = floating
        ? { left: `${ui.pos.x}px`, top: `${ui.pos.y}px`, right: 'auto', bottom: 'auto' }
        : undefined
      // 切换阶段后一律停在暂停态，所以按钮文案必须跟着阶段走 ——
      // 否则在短休息/长休息阶段会显示成「开始专注」。
      const toggleLabel = snap.running
        ? t('action.pause')
        : snap.phase === 'focus' ? t('action.start') : t('action.startBreak')

      // 休息期间的两个形态，二选一：大气泡（默认）或小圆点（点了 ✕ 之后）。
      // 小圆点是部件根节点的子节点（CSS 的 right:100% 让它挨着圆盘/卡片），
      // 大气泡则是它的**兄弟**节点（位置参考系是整帧浮层，与可拖动的时钟不同）。
      // 两者都是自身大小，浮层其余部分照旧点击穿透。
      const tipDot = breakPhase !== null && tipDismissed
        ? h(TipDot, { snap, t, innerRef: tipDotRef, onExpand: () => setTipDismissed(false) })
        : null
      const tipBubble = breakPhase !== null && !tipDismissed
        ? h(BreakTip, { snap, t, sentence: tipSentence, onDismiss: dismissTip })
        : null

      if (ui.collapsed) {
        return h(React.Fragment, null, h('div', {
          ref: rootRef,
          className: `${CLASS.root} ${CLASS.mini}`,
          'data-phase': snap.phase,
          'data-floating': String(floating),
          'data-dragging': String(dragging),
          'data-pomodoro-clock': 'pomodoro-clock',
          style,
          role: 'button',
          tabIndex: 0,
          title: `${phaseLabel(snap.phase)} ${snap.text} · ${t('label.progress')} ${percent}%`,
          'aria-label': `${t('action.expand')} · ${phaseLabel(snap.phase)} ${snap.text}`,
          onPointerDown: (event) => beginDrag(event, () => updateUi({ collapsed: false })),
          onKeyDown: (event) => {
            // 小圆点（子节点）上的 Enter/空格不属于这里：它有自己的原生点击，见 miniRootKeyDown。
            miniRootKeyDown(event, () => updateUi({ collapsed: false }))
          },
        },
        h('span', {
          className: CLASS.ring,
          style: { '--dsp-pc-progress': `${percent}%` },
        }, h('span', { className: CLASS.ringInner }, snap.text)),
        tipDot),
        tipBubble)
      }

      return h(React.Fragment, null, h('div', {
        ref: rootRef,
        className: `${CLASS.root} ${CLASS.card}`,
        'data-phase': snap.phase,
        'data-floating': String(floating),
        'data-dragging': String(dragging),
        'data-pomodoro-clock': 'pomodoro-clock',
        style,
      },
      // 标题栏：整条都是拖动把手。
      h('div', {
        className: CLASS.head,
        title: t('action.move'),
        onPointerDown: (event) => beginDrag(event),
      },
      tomatoIcon(),
      h('span', { className: CLASS.title }, t('app.title')),
      h('span', { className: CLASS.spacer }),
      h('button', {
        type: 'button',
        className: CLASS.iconBtn,
        onPointerDown: stopPointer,
        onClick: () => setOpen((value) => !value),
        'aria-expanded': open,
        'aria-label': t('action.settings'),
        title: t('action.settings'),
      }, gearIcon()),
      h('button', {
        type: 'button',
        className: CLASS.iconBtn,
        onPointerDown: stopPointer,
        onClick: () => updateUi({ collapsed: true }),
        'aria-label': t('action.collapse'),
        title: t('action.collapse'),
      }, collapseIcon())),
      // 阶段胶囊：点击直接切到该阶段，方向键也能切换。
      h('div', {
        className: CLASS.tabs,
        role: 'tablist',
        'aria-label': t('label.phase'),
      }, ...PHASES.map((phase, index) => h('button', {
        key: phase,
        type: 'button',
        role: 'tab',
        className: CLASS.tab,
        'aria-selected': snap.phase === phase,
        tabIndex: snap.phase === phase ? 0 : -1,
        // 悬停就能看到这个阶段有多长，省得"为了看一眼时长"而点一下、
        // 平白切走当前正在跑的阶段。
        title: `${phaseLabel(phase)} · ${phaseMinutes(snap.settings, phase)} ${t('settings.minutes')}`,
        onClick: () => pomodoro.switchPhase(phase),
        // 方向键只移动焦点，不提交 —— 在 tablist 里浏览不等于选择。
        // 提交走 Enter / 空格（button 原生就会触发 onClick），即"手动激活"。
        onKeyDown: (event) => {
          const delta = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0
          if (delta === 0) return
          event.preventDefault()
          const strip = event.currentTarget.parentElement
          const tabs = strip === null ? [] : [...strip.querySelectorAll('[role="tab"]')]
          const target = tabs[(index + delta + tabs.length) % tabs.length]
          if (target !== undefined) target.focus()
        },
      }, phaseLabel(phase)))),
      h('div', { className: CLASS.time, role: 'timer', 'aria-live': 'off' }, snap.text),
      h('button', {
        type: 'button',
        className: CLASS.bigBtn,
        onClick: () => pomodoro.toggle(),
        'aria-label': toggleLabel,
        title: toggleLabel,
      }, snap.running ? pauseIcon() : playIcon(), h('span', null, toggleLabel)),
      open ? h(SettingsPanel, { snap, pomodoro, t }) : null,
      tipDot),
      tipBubble)
    }

    // ---- 插件主体 --------------------------------------------------------

    function registerDictionary(ctx, locale, dict) {
      try {
        return ctx.locale.register(NS, locale, dict)
      } catch (error) {
        console.error(`${PLUGIN_ID}: locale "${locale}" was not registered`, error)
        return () => {}
      }
    }

    function apply(ctx) {
      const model = createModel()
      const subscribeLocale = (listener) => ctx.locale.subscribe(listener)

      // 样式以插件为单位插入一次，卸载时连同 <style> 一起移除。
      ctx.effect(() => {
        const existing = document.querySelector(`style[data-plugin="${PLUGIN_ID}"]`)
        if (existing !== null) existing.remove()
        const tag = document.createElement('style')
        tag.dataset.plugin = PLUGIN_ID
        tag.textContent = CSS
        document.head.appendChild(tag)
        return () => {
          if (tag.parentNode !== null) tag.parentNode.removeChild(tag)
        }
      }, 'pomodoro styles')

      // 先注册词条，再绑定翻译函数，保证任何时刻调用都能查到。
      ctx.effect(() => registerDictionary(ctx, 'zh', ZH), 'pomodoro locale zh')
      ctx.effect(() => registerDictionary(ctx, 'en', EN), 'pomodoro locale en')
      const t = ctx.locale.bind(NS)

      // 这里原先调用 ctx.theme.overrideTokens() 注册调色板，现已移除：
      // 覆盖层注册得成功，值却到不了 DOM，导致阶段色全部失效。配色改由 PALETTE
      // 直接生成 CSS 规则写进本插件自己的样式表（见 paletteDecls），与消费点
      // 原子同在。详见 PALETTE 上方与 README 的说明。

      ctx.effect(() => {
        model.refresh()
        const handle = window.setInterval(() => {
          model.tick()
        }, TICK_MS)
        return () => {
          window.clearInterval(handle)
          model.dispose()
        }
      }, 'pomodoro tick')

      // 注册在 root 作用域的浮层上：整个窗口只有一个时钟，且不随会话切换重建。
      // `getLang` 传函数而不是传值：注册时 inject 只求值一次，而语言随时可切。
      ctx.effect(() => ctx.slots.inject('shell.overlay', () => ctx.slots.register({
        name: 'shell.overlay',
        id: 'pomodoro-clock',
        order: 5,
        inject: () => ({ pomodoro: model, t, subscribeLocale, getLang: () => readLang(ctx) }),
      }, PomodoroClock)), 'pomodoro overlay')
    }

    return { apply, inject: ['slots', 'locale'] }
  },
})
