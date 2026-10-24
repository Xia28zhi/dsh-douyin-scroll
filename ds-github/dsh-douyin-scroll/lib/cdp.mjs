/**
 * lib/cdp.mjs —— 极简 CDP 客户端（**零 npm 依赖**）
 * ============================================================================
 * 为什么不用 playwright / puppeteer：
 *   · 它们要下 Chromium（150MB+），而**每个人机器上本来就有 Edge / Chrome**；
 *   · 插件装进 node_modules 后再拖一棵 playwright 树，桌面版上很容易装不动。
 * ⇒ 我们直接用 **CDP**（Chrome DevTools Protocol）：Node 22 自带 `WebSocket` 全局，
 *    浏览器用机器上现成的 Edge / Chrome 启动，零依赖、零下载。
 *
 * 三条硬规矩（都是踩过的坑）：
 *   1. **浏览器进程必须 detach + windowsHide**，不然 dsh 宿主关掉时它会变孤儿进程；
 *   2. **user-data-dir 钉在插件家目录** —— 登录态（cookie）才会长期留着，重启也能用；
 *   3. 所有 send 都要**带超时**：抖音那边偶发不回包，没超时会把一轮永久卡住 ✗。
 * ============================================================================
 */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { createConnection } from 'node:net'

/**
 * 机器上现成的 Chromium 内核浏览器（按可能性排序）
 * ⭐ 2026-10-24 对齐同类项目（NEWJO123/dsh-douyin-scroll `lib/chrome.mjs`）：
 *    先认 **DOUYIN_BROWSER 环境变量**（用户想指定就用它），再走常见路径 ——
 *    并把 D:/E: 盘（本机工具多装在 E 盘）也列进去，别只盯 C 盘。
 */
export function findBrowser() {
  const env = String(process.env.DOUYIN_BROWSER || '').trim()
  if (env && existsSync(env)) return env
  const cands = []
  const pf = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)'
  const pf64 = process.env.ProgramFiles || 'C:\\Program Files'
  const local = process.env.LOCALAPPDATA || ''
  cands.push(join(pf, 'Microsoft', 'Edge', 'Application', 'msedge.exe'))
  cands.push(join(pf64, 'Microsoft', 'Edge', 'Application', 'msedge.exe'))
  cands.push(join(pf64, 'Google', 'Chrome', 'Application', 'chrome.exe'))
  cands.push(join(pf, 'Google', 'Chrome', 'Application', 'chrome.exe'))
  if (local) {
    cands.push(join(local, 'Google', 'Chrome', 'Application', 'chrome.exe'))
    cands.push(join(local, 'Microsoft', 'Edge', 'Application', 'msedge.exe'))
  }
  for (const root of ['D:\\', 'E:\\']) {
    cands.push(join(root, 'Program Files', 'Google', 'Chrome', 'Application', 'chrome.exe'))
    cands.push(join(root, 'Program Files (x86)', 'Microsoft', 'Edge', 'Application', 'msedge.exe'))
  }
  for (const p of cands) if (p && existsSync(p)) return p
  return ''
}

/** 某端口上有没有活的 CDP（有就返回 /json/version 的内容） */
export async function probeCdp(port, timeout = 800) {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(timeout) })
    if (!r.ok) return null
    return await r.json()
  } catch { return null }
}

/** 端口有没有人监听 */
export function portFree(port, timeout = 400) {
  return new Promise((resolve) => {
    const s = createConnection({ host: '127.0.0.1', port })
    let done = false
    const fin = (v) => { if (!done) { done = true; try { s.destroy() } catch { /* 关掉 */ } resolve(v) } }
    s.once('connect', () => fin(false))
    s.once('error', () => fin(true))
    setTimeout(() => fin(true), timeout)
  })
}

/**
 * 某端口上的 CDP 到底**能不能用**（不只是"HTTP 答话"）
 * ⭐ 2026-10 真机踩坑：一个卡死的 Edge 仍然会正常回答 `/json/version`，
 *    但 WebSocket 上的任何命令都永远不返回 —— 只按 probeCdp 判断"活着"就会
 *    一直复用它，表现为「CDP Page.enable 超时 30s」。所以这里做一次真往返。
 */
export async function cdpHealthy(port, timeout = 2_500) {
  const info = await probeCdp(port, Math.min(timeout, 800))
  if (!info?.webSocketDebuggerUrl) return null
  let cdp = null
  try {
    cdp = await Cdp.connect(info.webSocketDebuggerUrl, timeout)
    await cdp.send('Browser.getVersion', {}, timeout)
    return info
  } catch {
    return null
  } finally {
    try { cdp?.close() } catch { /* 已关 */ }
  }
}

/**
 * 挑调试端口（⭐ 对齐 NEWJO123 `lib/chrome.mjs` 的端口复用逻辑）：
 *   同一个 user-data-dir 起不了第二台浏览器 —— 如果只挑"空端口"，会挑到空口起新实例，
 *   而新实例因为 profile 正被占用而秒退，表现为"60 秒连不上 CDP"。
 *   正确顺序：账本里记的端口活着就复用 → 扫区间找已有 CDP 复用 → 都不行才找空口。
 *   ⭐ 2026-10：复用前必须 `cdpHealthy`（真往返），否则会把卡死的浏览器当活的。
 */
export async function pickPort({ recorded = 0, from = 9333, to = 9372 } = {}) {
  if (recorded) {
    const info = await cdpHealthy(recorded)
    if (info) return { port: recorded, reused: true, info }
  }
  for (let p = from; p <= to; p++) {
    const info = await cdpHealthy(p, 1_200)
    if (info) return { port: p, reused: true, info }
  }
  for (let p = from; p <= to; p++) {
    if (await portFree(p)) return { port: p, reused: false, info: null }
  }
  throw new Error(`${from}–${to} 端口都被占了 —— 先关掉一些浏览器再试`)
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** CDP 连接：send(method, params) → Promise<result>；on(method, cb) 订阅事件 */
export class Cdp {
  constructor(ws) {
    this.ws = ws
    this.seq = 0
    this.pending = new Map()
    this.listeners = new Map()
    ws.addEventListener('message', (ev) => {
      let msg
      try { msg = JSON.parse(String(ev.data)) } catch { return }
      if (msg.id != null) {
        const p = this.pending.get(msg.id)
        if (!p) return
        this.pending.delete(msg.id)
        if (msg.error) p.reject(new Error(msg.error.message || 'CDP error'))
        else p.resolve(msg.result)
        return
      }
      for (const cb of this.listeners.get(msg.method) || []) {
        try { cb(msg.params) } catch { /* 订阅者自己炸了不该带崩连接 */ }
      }
    })
  }

  static async connect(wsUrl, timeout = 10_000) {
    const ws = new WebSocket(wsUrl)
    await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('CDP 连接超时')), timeout)
      ws.addEventListener('open', () => { clearTimeout(t); resolve() })
      ws.addEventListener('error', (e) => { clearTimeout(t); reject(new Error('CDP 连接失败：' + (e?.message ?? ''))) })
    })
    return new Cdp(ws)
  }

  send(method, params = {}, timeout = 30_000) {
    const id = ++this.seq
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`CDP ${method} 超时（${timeout}ms）`))
      }, timeout)
      this.pending.set(id, {
        resolve: (v) => { clearTimeout(t); resolve(v) },
        reject: (e) => { clearTimeout(t); reject(e) },
      })
      try { this.ws.send(JSON.stringify({ id, method, params })) } catch (e) {
        clearTimeout(t); this.pending.delete(id); reject(e)
      }
    })
  }

  on(method, cb) {
    if (!this.listeners.has(method)) this.listeners.set(method, [])
    this.listeners.get(method).push(cb)
    return () => {
      const arr = this.listeners.get(method) || []
      const i = arr.indexOf(cb)
      if (i >= 0) arr.splice(i, 1)
    }
  }

  close() { try { this.ws.close() } catch { /* 已关 */ } }
}

/**
 * 起一个带调试端口的浏览器（**独立 user-data-dir** ⇒ 跟用户日常那个浏览器互不干扰）
 * @param mode 'headless' 无窗口 | 'hidden' 真窗口但挪到屏幕外+静音（抖音对 headless 敏感时用它）| 'visible' 正常窗口
 * @returns {{browser:string, port:number, proc:object, wsUrl:string, mode:string}}
 */
export async function launchBrowser({ userDataDir, port = 9333, headless = false, mode = '', url = 'about:blank', width = 1280, height = 900 }) {
  const browser = findBrowser()
  if (!browser) throw new Error('机器上没找到 Edge / Chrome —— 装一个再点「登录抖音」')
  const want = String(mode || (headless ? 'headless' : 'visible'))
  const hidden = want === 'hidden'
  const args = [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${userDataDir}`,
    '--remote-allow-origins=*',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-blink-features=AutomationControlled',   // 别让页面一眼认出是自动化
    `--window-size=${width},${height}`,
    '--disable-notifications',
    '--mute-audio',                                     // 截帧时别放声音
    want === 'headless' ? '--headless=new' : '',
    // ⭐ hidden：真窗口但挪到屏幕外 —— 抖音对 headless 的指纹更敏感，hidden 更像人
    hidden ? '--window-position=-32000,-32000' : '',
    // 窗口在后台/被遮住时别把定时器和渲染降频，否则视频不播、截帧全黑
    hidden || want === 'headless'
      ? '--disable-background-timer-throttling'
      : '',
    hidden || want === 'headless' ? '--disable-backgrounding-occluded-windows' : '',
    hidden || want === 'headless' ? '--disable-renderer-backgrounding' : '',
    url,
  ].filter(Boolean)

  const proc = spawn(browser, args, { windowsHide: true, stdio: 'ignore', detached: true })
  proc.unref()
  proc.on('error', () => { /* 起不来会在下面的轮询里超时说清楚 */ })

  // 等调试端口就绪（最多 25 秒）
  let info = null
  for (let i = 0; i < 50; i++) {
    await sleep(500)
    try {
      const r = await fetch(`http://127.0.0.1:${port}/json/version`)
      if (r.ok) { info = await r.json(); break }
    } catch { /* 还没起来 */ }
  }
  if (!info) throw new Error(`浏览器起来了但调试端口 ${port} 没响应（可能被安全软件拦了）`)
  return { browser, port, proc, wsUrl: info.webSocketDebuggerUrl || '', mode: want }
}

/** 连到已有浏览器的第一个页面标签（拿不到就直接连 browser 级 ws 再开新标签） */
/**
 * 关掉某个调试端口上的浏览器（用于「复用到的那个是 headless，屏幕上根本没有窗口」时重开）。
 * 只走 CDP 的 Browser.close：干净、不会误杀用户自己的 Edge。
 */
export async function closeBrowser(port, timeout = 6_000) {
  try {
    const info = await probeCdp(port, 1_200)
    if (!info?.webSocketDebuggerUrl) return false
    const cdp = await Cdp.connect(info.webSocketDebuggerUrl, timeout)
    try { await cdp.send('Browser.close', {}, timeout) } catch { /* 关的时候连接断开是正常的 */ }
    try { cdp.close() } catch { /* 已经断了 */ }
    for (let i = 0; i < 20; i++) {
      await new Promise((r) => setTimeout(r, 200))
      if (await portFree(port, 300)) return true
    }
    return false
  } catch { return false }
}

export async function attachPage({ port = 9333, url = '' } = {}) {  const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
  let target = list.find((t) => t.type === 'page')
  if (!target) throw new Error('没找到可用标签页')
  if (url && target.url !== url) {
    // 直接在这个标签里导航
  }
  const cdp = await Cdp.connect(target.webSocketDebuggerUrl)
  return { cdp, target }
}

/** 直接开一个新标签并返回它的 CDP 连接（最稳：不受已有标签影响） */
export async function openTab({ port = 9333, url = 'about:blank' } = {}) {
  const created = await (await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent(url)}`, { method: 'PUT' })).json()
  const cdp = await Cdp.connect(created.webSocketDebuggerUrl)
  return { cdp, target: created }
}

/** 关掉一个标签 */
export async function closeTab(port, id) {
  try { await fetch(`http://127.0.0.1:${port}/json/close/${id}`) } catch { /* 关不掉就算了 */ }
}

/** 常用封装：等页面加载完 */
export async function navigate(cdp, url, timeout = 30_000) {
  await cdp.send('Page.enable', {}, timeout)
  const loaded = new Promise((resolve) => {
    const off = cdp.on('Page.loadEventFired', () => { off(); resolve() })
    setTimeout(() => resolve(), timeout)     // 超时也放行：抖音是 SPA，load 之后还要等数据
  })
  await cdp.send('Page.navigate', { url }, timeout)
  await loaded
}

/** 常用封装：执行一段 JS 拿结果（返回 JSON-safe 的值） */
export async function evaluate(cdp, expr, timeout = 30_000) {
  const r = await cdp.send('Runtime.evaluate', {
    expression: expr,
    returnByValue: true,
    awaitPromise: true,
  }, timeout)
  if (r?.exceptionDetails) throw new Error(r.exceptionDetails.text || 'JS 执行异常')
  return r?.result?.value
}

/** 常用封装：截图（PNG base64），可裁一块区域 */
export async function screenshot(cdp, clip = null, timeout = 30_000) {
  const r = await cdp.send('Page.captureScreenshot', { format: 'png', ...(clip ? { clip: { ...clip, scale: 1 } } : {}) }, timeout)
  return r?.data || ''
}
