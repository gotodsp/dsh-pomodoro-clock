/**
 * 番茄时钟 —— 浏览器半边。
 *
 * 挂载在全窗口浮层 `shell.overlay` 里，有两种形态：
 *   · 面板态：番茄图标 + 标题 + 收起按钮 / 阶段胶囊标签 / 超大倒计时 / 反色主按钮；
 *   · 圆盘态：62px 圆盘，外环是本阶段进度，中心是倒计时。
 *
 * 计时模型在 `apply` 里只创建一次，所以收起、切会话、刷新页面都不会打断倒计时。
 * 浮层本身是点击穿透的、只给直接子元素放行事件，因此这个部件的根节点必须
 * 始终只有自身大小，绝不能做成铺满屏幕的容器。
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
    const FLAG_SETTINGS = ['autoStartBreak', 'autoStartFocus', 'sound']

    const DEFAULT_SETTINGS = {
      focusMinutes: 25,
      shortMinutes: 5,
      longMinutes: 15,
      longEvery: 4,
      autoStartBreak: true,
      autoStartFocus: false,
      sound: true,
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
      'label.progress': 'Progress',
      'label.phase': 'Choose a phase',
      'stats.completed': 'Completed',
      'stats.cycle': 'Cycle',
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
      'label.progress': '进度',
      'label.phase': '选择阶段',
      'stats.completed': '已完成',
      'stats.cycle': '本轮',
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
    }

    /**
     * 插件自己的配色，交给宿主主题服务托管：每个名字给一对明暗值，
     * 切主题时宿主自己换，插件里不需要判断当前是明是暗。
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
    const CSS = [
      // 圆环按阶段换色。这里只做「阶段 → token」的映射，具体色值由主题服务
      // 托管（见 PALETTE）；兜底色写在消费点，主题服务缺席时回退到番茄色，
      // 而不是让整个环消失。
      `.${CLASS.root}{box-sizing:border-box;--dsp-pc-ring:var(--dsp-pc-ring-focus);--dsp-pc-ring-soft:var(--dsp-pc-ring-focus-soft);--dsp-pc-dial:var(--dsp-pc-dial-focus);--dsp-pc-dial-rest:var(--dsp-pc-dial-focus-rest)}`,
      `.${CLASS.root}[data-phase="focus"]{--dsp-pc-ring:var(--dsp-pc-ring-focus);--dsp-pc-ring-soft:var(--dsp-pc-ring-focus-soft);--dsp-pc-dial:var(--dsp-pc-dial-focus);--dsp-pc-dial-rest:var(--dsp-pc-dial-focus-rest)}`,
      `.${CLASS.root}[data-phase="short"]{--dsp-pc-ring:var(--dsp-pc-ring-short);--dsp-pc-ring-soft:var(--dsp-pc-ring-short-soft);--dsp-pc-dial:var(--dsp-pc-dial-short);--dsp-pc-dial-rest:var(--dsp-pc-dial-short-rest)}`,
      `.${CLASS.root}[data-phase="long"]{--dsp-pc-ring:var(--dsp-pc-ring-long);--dsp-pc-ring-soft:var(--dsp-pc-ring-long-soft);--dsp-pc-dial:var(--dsp-pc-dial-long);--dsp-pc-dial-rest:var(--dsp-pc-dial-long-rest)}`,
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
      `.${CLASS.ring}{position:absolute;inset:0;border-radius:50%;display:grid;place-items:center;`,
      `background:conic-gradient(var(--dsp-pc-ring,#e8604a) var(--dsp-pc-progress,0%),var(--dsp-pc-ring-soft,rgba(232,96,74,.22)) 0)}`,
      // 圆盘中间：自己的 conic-gradient，两层都是**不透明实色**。
      // 早先这里借用了宿主的 --dsw-specific-menu 当遮罩，那是磨砂面板填充、
      // 透明度随平台变，于是底下的扇形会透上来 —— 换成实色 token 后，
      // 中间在任何平台都是同一份颜色。
      `.${CLASS.ringInner}{width:50px;height:50px;border-radius:50%;display:grid;place-items:center;`,
      `background:conic-gradient(var(--dsp-pc-dial,#f8cfc9) var(--dsp-pc-progress,0%),var(--dsp-pc-dial-rest,#fdefed) 0);`,
      `color:var(--dsw-alias-label-primary);`,
      `font-size:12px;font-weight:600;line-height:1;font-variant-numeric:tabular-nums}`,
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
        if (long) state.cycleFocus = 0
        const following = fromFocus ? (long ? 'long' : 'short') : 'focus'
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

    function PomodoroClock({ pomodoro, t, subscribeLocale }) {
      const snap = usePomodoro(pomodoro)
      const [ui, setUi] = React.useState(readUi)
      const [open, setOpen] = React.useState(false)
      const [dragging, setDragging] = React.useState(false)
      const rootRef = React.useRef(null)
      useLocaleRefresh(subscribeLocale)

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

      if (ui.collapsed) {
        return h('div', {
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
            if (event.key !== 'Enter' && event.key !== ' ') return
            event.preventDefault()
            updateUi({ collapsed: false })
          },
        },
        h('span', {
          className: CLASS.ring,
          style: { '--dsp-pc-progress': `${percent}%` },
        }, h('span', { className: CLASS.ringInner }, snap.text)))
      }

      return h('div', {
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
      open ? h(SettingsPanel, { snap, pomodoro, t }) : null)
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

      // 主题服务走可选依赖：拿不到就退回 CSS 里写死的浅色值，不影响插件激活。
      // 注册成功后，主按钮的番茄色会随明暗主题自动切换。
      const theme = ctx.get('theme')
      if (theme !== undefined) {
        ctx.effect(() => theme.overrideTokens(PLUGIN_ID, PALETTE), 'pomodoro palette')
      }

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
      ctx.effect(() => ctx.slots.inject('shell.overlay', () => ctx.slots.register({
        name: 'shell.overlay',
        id: 'pomodoro-clock',
        order: 5,
        inject: () => ({ pomodoro: model, t, subscribeLocale }),
      }, PomodoroClock)), 'pomodoro overlay')
    }

    return { apply, inject: ['slots', 'locale'] }
  },
})
