/**
 * lib/browser.mjs —— 浏览器会话（**一台常驻的浏览器，插件自己养着**）
 * ============================================================================
 * 为什么"常驻"而不是"用完就关"：
 *   · 抖音的**登录态**就在这个 profile 里，开开关关容易掉登录、也慢；
 *   · 截帧要真的播视频，每次冷启动要等好几秒。
 * ⇒ 起一次，用一整天；dsh 关掉时再由插件收摊（`ctx.effect` 里 stop）。
 *
 * ⚠️ 四条硬规矩：
 *   1. **独立 user-data-dir**（跟使用者日常那个浏览器完全隔离，不碰他的书签/密码）；
 *   2. 进程 **detached + unref**，别拖住宿主退出；
 *   3. **端口复用**：同一个 profile 起不了第二台浏览器 ⇒ 先复用（见 cdp.mjs pickPort）；
 *   4. **三种显示方式**（2026-10-24 新增，用户要求"别弹窗抢前台"）：
 *        auto（默认，先 hidden 失败退 headless）/ hidden（真窗口挪到屏幕外+最小化）
 *        / headless（无窗口）/ visible（登录扫码时才用）
 * ============================================================================
 */
import { launchBrowser, openTab, closeTab, probeCdp, pickPort, cdpHealthy, portFree, closeBrowser, Cdp } from './cdp.mjs'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

export const BROWSER_MODES = ['auto', 'hidden', 'headless', 'visible']

export class BrowserSession {
  constructor({ dir, port = 0, mode = 'auto', headless = false, log = () => {} } = {}) {
    this.dir = dir
    this.port = port
    this.mode = String(mode || (headless ? 'headless' : 'auto'))
    this.log = log
    this.userDataDir = join(dir, 'browser')
    this.runtimeFile = join(dir, 'browser-runtime.json')
    this.proc = null
    this.tabs = new Set()
  }

  /** 账本：上次用的端口 —— 端口复用靠它 */
  recordedPort() {
    try {
      const j = JSON.parse(readFileSync(this.runtimeFile, 'utf8'))
      return Number(j?.port) || 0
    } catch { return 0 }
  }

  saveRuntime(extra = {}) {
    try {
      writeFileSync(this.runtimeFile, JSON.stringify({ port: this.port, mode: this.mode, at: new Date().toISOString(), ...extra }, null, 2), 'utf8')
    } catch { /* 记账失败不影响跑 */ }
  }

  async alive() {
    return Boolean(await probeCdp(this.port || this.recordedPort()))
  }

  /** 只探活，不起浏览器（面板刷新用这个） */
  async aliveInfo() {
    const info = await probeCdp(this.port || this.recordedPort())
    return { alive: Boolean(info), port: this.port, mode: this.mode, browser: info?.Browser || '' }
  }

  /** 保证浏览器活着（已活就复用） */
  async start(url = 'about:blank') {
    const wantMode = this.mode === 'auto' ? 'hidden' : this.mode
    // ⭐ 2026-10 真机踩坑：构造函数里给了明确端口就别再"挑"——
    //   挑端口会命中一个卡死的实例（HTTP 答话正常、WS 永不回），之后所有 CDP 命令都超时。
    const fixed = Number(this.port) > 0
    let pick
    if (fixed) {
      const healthy = await cdpHealthy(this.port, 2_000)
      if (!healthy && !(await portFree(this.port))) {
        throw new Error(`端口 ${this.port} 被一个不响应的浏览器占着 —— 换个端口或先关掉它`)
      }
      pick = { port: this.port, reused: Boolean(healthy) }
    } else {
      pick = await pickPort({ recorded: this.recordedPort() })
    }
    this.port = pick.port
    if (pick.reused) {
      const info = await probeCdp(this.port)
      // ⭐ 2026-10-24 真机事故：复用到的是**之前 headless 起的那个**，屏幕上根本没有窗口，
      //   主人点「登录抖音」只看到日志说"已打开登录窗口"，实际什么也没弹出来。
      //   要可见却没窗口 ⇒ 关掉重开（走 CDP，不误杀主人自己的 Edge）。
      const headless = /headless/i.test(String(info?.['User-Agent'] || ''))
      const needWindow = wantMode === 'visible' || wantMode === 'hidden'
      if (headless && needWindow) {
        this.log(`复用到的是 headless 浏览器（屏幕上没有窗口），关掉重开一个 ${wantMode} 的`)
        await closeBrowser(this.port)
        pick = { port: this.port, reused: false }
      } else {
        if (!this.mode || this.mode === 'auto') this.mode = wantMode
        this.saveRuntime({ reused: true })
        this.log(`复用已开的浏览器（端口 ${this.port}）`)
        return { reused: true, port: this.port }
      }
    }
    let r
    try {
      r = await launchBrowser({ userDataDir: this.userDataDir, port: this.port, mode: wantMode, url })
    } catch (e) {
      // auto：hidden 起不来就退 headless（有些机器挪到屏幕外会被窗口管理器拒绝）
      if (this.mode === 'auto' && wantMode !== 'headless') {
        this.log(`hidden 模式起不来（${e?.message ?? e}），退回 headless`)
        r = await launchBrowser({ userDataDir: this.userDataDir, port: this.port, mode: 'headless', url })
      } else throw e
    }
    this.proc = r.proc
    this.mode = r.mode
    this.saveRuntime({ pid: r.proc?.pid || 0 })
    this.log(`浏览器已起（${r.browser.replace(/\\/g, '/').split('/').pop()}，${r.mode}），调试端口 ${this.port}`)
    if (r.mode === 'hidden') await this.minimize()
    return { reused: false, browser: r.browser, mode: r.mode }
  }

  /** 把所有窗口最小化（hidden 模式下用；比"挪到屏幕外"更稳） */
  async minimize() {
    try {
      const info = await probeCdp(this.port)
      if (!info?.webSocketDebuggerUrl) return false
      const cdp = await Cdp.connect(info.webSocketDebuggerUrl, 8_000)
      const { targetInfos = [] } = await cdp.send('Target.getTargets', {}, 8_000)
      let n = 0
      for (const t of targetInfos.filter((x) => x.type === 'page')) {
        try {
          const { windowId } = await cdp.send('Browser.getWindowForTarget', { targetId: t.targetId }, 8_000)
          await cdp.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'minimized' } }, 8_000)
          n++
        } catch { /* 这个窗口不让改就算了 */ }
      }
      cdp.close()
      this.log(`已把 ${n} 个窗口最小化（不抢前台）`)
      return n > 0
    } catch (e) {
      this.log(`最小化失败（不影响跑）：${e?.message ?? e}`)
      return false
    }
  }

  /**
   * 需要人看的时候（登录扫码）：切到可见窗口。
   * ⚠️ 2026-10-24 踩到的：hidden 模式是把窗口挪到屏幕外（--window-position=-32000,-32000），
   *   只把 windowState 设成 normal 等于"还原到原来的位置"= 还在屏幕外 ⇒ 主人点了「登录抖音」
   *   只看到日志写"已打开登录窗口"，屏幕上什么都没有。所以还原之后**必须再显式摆一次位置**。
   */
  async show() {
    try {
      const info = await probeCdp(this.port)
      if (!info?.webSocketDebuggerUrl) return false
      const cdp = await Cdp.connect(info.webSocketDebuggerUrl, 8_000)
      const { targetInfos = [] } = await cdp.send('Target.getTargets', {}, 8_000)
      let n = 0
      for (const t of targetInfos.filter((x) => x.type === 'page')) {
        try {
          const { windowId } = await cdp.send('Browser.getWindowForTarget', { targetId: t.targetId }, 8_000)
          await cdp.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'normal' } }, 8_000)
          // 再摆到主屏左上角（这一步才是"从屏幕外拽回来"的关键）
          await cdp.send('Browser.setWindowBounds', {
            windowId,
            bounds: { left: 120, top: 80, width: 1200, height: 900 },
          }, 8_000)
          n++
        } catch { /* 忽略 */ }
      }
      cdp.close()
      if (n) this.log(`已把 ${n} 个窗口摆到屏幕上（120, 80）`)
      return n > 0
    } catch (e) { this.log(`显示窗口失败：${e?.message ?? e}`); return false }
  }

  /** 切显示方式（登录时 visible，平时 hidden/headless）—— 变了才重启浏览器 */
  async setMode(mode) {
    if (!mode || mode === this.mode || (this.mode === 'auto' && mode === 'auto')) return { changed: false }
    if (await this.alive()) {
      if (mode === 'visible') { await this.show(); this.mode = mode; this.saveRuntime(); return { changed: true, restarted: false } }
      await this.stop()
    }
    this.mode = mode
    await this.start()
    return { changed: true, restarted: true }
  }

  /** 开一个标签页（返回 CDP 连接） */
  async tab(url = 'about:blank') {
    await this.start()
    const { cdp, target } = await openTab({ port: this.port, url })
    this.tabs.add(target.id)
    return { cdp, target }
  }

  async close(id) {
    this.tabs.delete(id)
    await closeTab(this.port, id)
  }

  /** 收摊：关掉自己开的标签 + 杀掉浏览器 */
  async stop() {
    for (const id of [...this.tabs]) {
      try { await this.close(id) } catch { /* 已经没了 */ }
    }
    if (this.proc) {
      try { this.proc.kill() } catch { /* 已退出 */ }
      this.proc = null
    }
  }

  /** 已登录检查用的兜底：看 profile 目录里有没有东西（有 cookie 才算数） */
  get hasProfile() {
    try { return existsSync(join(this.userDataDir, 'Default', 'Cookies')) } catch { return false }
  }
}

export { sleep }
