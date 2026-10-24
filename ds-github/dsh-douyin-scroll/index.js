/**
 * dsh-douyin-scroll —— host 半端（**刷抖音**）
 * ============================================================================
 * 它是什么：每天替你刷一轮抖音的 DSH 插件版。
 *   1. **自己养一台浏览器**（机器上现成的 Edge / Chrome + CDP，零下载），登录态长期留着；
 *   2. **谷时 / 每日固定时间 / 开 dsh 时**自动跑，也能在设置页手动「现在跑一轮」；
 *   3. **跑一轮** = 起一个 `dsh --profile headless <prompt>`，把 `duty.md` 交给它，
 *      它手里的工具由**本插件自带的 MCP 服务端**提供（见 `lib/mcp-server.mjs`）；
 *   4. 一轮结束后，**宿主**按 `picks.json` 做收藏 / 发评论（**模型没有这两只手**）；
 *   5. **设置页**（`client.js`）通过 `/api/douyin-duty/*` 读写配置、看状态、登录、手动跑。
 *
 * 家里（`$DSH_HOME/douyin-duty/`）：`config.json`（**配置权威在这里**）/ `state.json` /
 * `seen.json` / `picks.json` / `out/<日期>.md` / `frames/` / `duty.md` / `duty.log` / `browser/`。
 *
 * 🔴 三条从参考项目 dsh-bili-scroll 继承来的硬规矩（都是真机事故换的）：
 *   · **任何定时器回调、任何写文件，都要自己 try/catch 兜住** —— 插件再错也只该"这一轮没跑成"，
 *     绝不该把 DSH 宿主带走；
 *   · **别裸 import `@deepseek-ai/*`**（桌面版不装 optional peer ⇒ 整条插件静默不激活）；
 *   · **会动用户账号的开关默认全关**，要他自己开。
 * ============================================================================
 */
import { loadHostDeps } from './lib/hostdeps.mjs'

const hostDeps = await loadHostDeps()
const z = hostDeps.z
const defineTool = hostDeps.defineTool

import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync, statSync, renameSync, readdirSync, unlinkSync, openSync, closeSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { BrowserSession } from './lib/browser.mjs'
import { Douyin } from './lib/douyin.mjs'
import { fav, comment, share } from './lib/act.mjs'
import {
  WINDOWS, DEFAULT_CFG, stateDirOf, readJson, writeJson, dayKey, hhmm, isPeak, inWindow,
  countPicked, ensureDirs, ensureCharter,
} from './lib/state.mjs'
import {
  readOutbox, listOutbox, setStatus as setOutboxStatus, sentToday, quotaLeft, hitWhitelist, OUTBOX_KINDS, recordSent,
} from './lib/outbox.mjs'
import { probeVision } from './lib/vision.mjs'

export const name = 'douyin-scroll'
export const inject = ['webServer', 'tools', 'settings']

/** 🔴 每个字段都要 `.extra('volatile', true)`：DSH 的 settings.update() 只认 volatile 字段 */
export const Config = !z ? undefined : z.object({
  perDay: z.natural().default(5).extra('volatile', true),
  peakValley: z.boolean().default(false).extra('volatile', true),
  noon: z.boolean().default(true).extra('volatile', true),
  night: z.boolean().default(true).extra('volatile', true),
  dailyAt: z.string().default('').extra('volatile', true),
  onStart: z.boolean().default(false).extra('volatile', true),
  framesPerVideo: z.natural().default(3).extra('volatile', true),
  useOcr: z.boolean().default(true).extra('volatile', true),
  useVision: z.boolean().default(false).extra('volatile', true),
  visionApiBase: z.string().default('').extra('volatile', true),
  visionApiKey: z.string().default('').extra('volatile', true),
  visionModel: z.string().default('').extra('volatile', true),
  visionBackups: z.array(z.string()).default([]).extra('volatile', true),
  favOn: z.boolean().default(false).extra('volatile', true),
  autoComment: z.boolean().default(false).extra('volatile', true),
  mentionName: z.string().default('').extra('volatile', true),
  commentPerRound: z.natural().default(1).extra('volatile', true),
  commentAtEnabled: z.boolean().default(false).extra('volatile', true),
  dailyCommentQuota: z.natural().default(5).extra('volatile', true),
  outboxMode: z.string().default('review').extra('volatile', true),
  dmEnabled: z.boolean().default(false).extra('volatile', true),
  dmWhitelist: z.array(z.string()).default([]).extra('volatile', true),
  dmDailyQuota: z.natural().default(1).extra('volatile', true),
  groupEnabled: z.boolean().default(false).extra('volatile', true),
  groupWhitelist: z.array(z.string()).default([]).extra('volatile', true),
  groupDailyQuota: z.natural().default(1).extra('volatile', true),
  // ⭐ 人设提示词（抄 dsh-bili-scroll 的口径）：写草稿/评论时按它说话；填路径就去读那个文件
  personaPrompt: z.string().default('').extra('volatile', true),
  browserMode: z.string().default('auto').extra('volatile', true),
  retentionDays: z.natural().default(7).extra('volatile', true),
  // ⭐ 一轮最多刷多少条候选（默认 60）：超了就让模型拿已经看到的收尾，别让某一轮刷到一百多
  scanLimit: z.natural().default(60).extra('volatile', true),
  headlessProfile: z.string().default('headless').extra('volatile', true),
  dshBin: z.string().default('').extra('volatile', true),
})

const textOutput = { type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false }

export function apply(ctx, config) {
  const pluginDir = dirname(fileURLToPath(import.meta.url))
  let myVer = ''
  try { myVer = String(JSON.parse(readFileSync(join(pluginDir, 'package.json'), 'utf8')).version || '') } catch { myVer = '' }

  const stateDir = stateDirOf(ctx)
  ensureDirs(stateDir)
  const outDir = join(stateDir, 'out')
  const logFile = join(stateDir, 'duty.log')
  const cfgFile = join(stateDir, 'config.json')
  const stateFile = join(stateDir, 'state.json')
  const picksFile = join(stateDir, 'picks.json')
const actedFile = join(stateDir, 'acted.json')
  const charterFile = join(stateDir, 'duty.md')

  // 关键词 / 博主链接：面板里可能被写成"一格整串"（用 / , ， 、 ; ； 或换行分隔），
  // 这里统一拆成数组 —— 2026-10-24 用户反馈 `AI/搞笑鬼畜/DeepSeek` 被当成一个关键词。
  // ⭐ 分隔符统一：斜杠 / 逗号 / 顿号 / 分号 / **空格与换行**（用户习惯在框里空格隔开）
  const KW_RE = /[\/,，、;；\s]+/
  const URL_RE = /[,，、;；\s]+/
  const splitList = (arr, re) => {
    const out = []
    const seen = new Set()
    const src = Array.isArray(arr) ? arr : (arr == null ? [] : [arr])
    for (const x of src) {
      for (const piece of String(x ?? '').split(re)) {
        const t = piece.trim()
        if (!t) continue
        const k = t.toLowerCase()
        if (seen.has(k)) continue
        seen.add(k)
        out.push(t)
      }
    }
    return out.slice(0, 200)
  }
  const normCfg = (c) => {
    try {
      c.keywords = splitList(c.keywords, KW_RE)
      c.userUrls = splitList(c.userUrls, URL_RE)
    } catch { /* 拆不动就原样用 */ }
    return c
  }

  /** ⭐ 配置权威在 `config.json`；DSH 设置项只是"另一份视图"，两边对得上就以设置页为准 */
  let cfg = normCfg({ ...DEFAULT_CFG, ...readJson(cfgFile, {}) })
  const deepCfg = () => {
    const c = { ...DEFAULT_CFG, ...readJson(cfgFile, {}) }
    c.sources = { ...DEFAULT_CFG.sources, ...(c.sources || {}) }
    return normCfg(c)
  }
  const refreshCfg = () => {
    try {
      const next = deepCfg()
      // DSH 设置页改过的（不是默认值的）字段优先
      // ⭐ 只收**原始值**（string/number/boolean）：真机 2026-10-23 踩到宿主设置视图把
      //    headlessProfile 递成对象 ⇒ `--profile [object Object]` ⇒ 一轮白跑 ✗
      for (const k of Object.keys(DEFAULT_CFG)) {
        const v = config?.[k]
        const prim = typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean'
        if (prim && JSON.stringify(v) !== JSON.stringify(DEFAULT_CFG[k])) next[k] = v
      }
      cfg = next
    } catch { /* 读不到就沿用内存里那份 */ }
    return cfg
  }
  const saveCfg = (patch) => {
    const cur = deepCfg()
    const next = { ...cur, ...patch }
    if (patch.sources) next.sources = { ...cur.sources, ...patch.sources }
    writeJson(cfgFile, next)
    // 同步一份回 DSH 设置项（写不进去也不影响：config.json 才是权威）
    try { for (const [k, v] of Object.entries(patch)) if (config && k in config) config[k] = v } catch { /* 忽略 */ }
    cfg = next
    return next
  }

  const log = (m) => {
    try { appendFileSync(logFile, `${new Date().toISOString()}  ${m}\n`, 'utf8') } catch { /* 日志被占着就算了 */ }
  }
  const rotateLogIfBig = () => {
    try {
      if (existsSync(logFile) && statSync(logFile).size > 2_000_000) {
        try { renameSync(logFile, logFile + '.1') } catch { /* 滚不动就算了 */ }
      }
    } catch { /* 忽略 */ }
  }

  refreshCfg()
  log(`刷抖音挂载（v${myVer}，家=${stateDir}）`)
  for (const n of hostDeps.notes) log('  · ' + n)

  // ─────────────────────── 家里该有的文件 ───────────────────────
  try {
    // ⭐ 第一次运行就落一份默认 `config.json` —— 值班那一轮是**另一个进程**，
    //    它读不到内存里的默认值，只认这个文件。
    if (!existsSync(cfgFile)) {
      writeJson(cfgFile, DEFAULT_CFG)
      log('默认配置已写到 ' + cfgFile)
    }
  } catch (e) { log(`写默认配置失败：${e?.message ?? e}`) }

  try {
    ensureCharter(pluginDir, stateDir, log)
  } catch (e) { log(`铺章程失败：${e?.message ?? e}`) }

  // ─────────────────────── 浏览器会话 ───────────────────────
  // ⭐ P0（2026-10-24）：**懒启动** —— 打开设置页不再拉起浏览器；只有真要跑/要登录/要点「测一下」才起。
  // 显示方式由 cfg.browserMode 决定（auto/hidden/headless/visible），登录时临时切 visible。
  let session = null
  let dy = null
  const ensureDy = async (mode = '') => {
    // ⭐ 每次都用**当前**配置算一遍要哪种窗口：以前只在建 session 时读一次 cfg，
    //   改成 headless/visible 之后跑一轮还是老样子（2026-10-24 真机"设了没生效"）。
    const want = String(mode || cfg.browserMode || 'auto')
    if (!session) {
      session = new BrowserSession({
        dir: stateDir,
        port: Number(process.env.DOUYIN_PORT || 0),   // 0 = 交给 pickPort 挑（账本里记着的端口优先复用）
        mode: want,
        log,
      })
    }
    await session.setMode(want)
    if (!dy) {
      await session.start()
      dy = new Douyin(session, { log, dir: stateDir })
    }
    return dy
  }

  /**
   * 登录专用：**一定要有一个屏幕上看得见的窗口**。
   *   2026-10-24 真机：之前测试留下的 headless 浏览器占着端口，点「登录抖音」只写了
   *   「已打开登录窗口」，屏幕上什么都没有 —— 主人以为"浏览器打不开"。
   *   所以登录时不再复用：关掉重开一个 visible 的。
   */
  const ensureDyFresh = async (mode = 'visible') => {
    if (session) { try { await session.stop() } catch { /* 关不掉就换个新的 */ } }
    session = null
    dy = null
    return ensureDy(mode)
  }

  // ⭐ P2（2026-10-24）：截帧过期清理 —— 每轮都往 frames/ 丢十几张 png，不清会无声长到几个 GB
  const cleanOldFrames = () => {
    try {
      const days = Math.max(1, Math.min(Number(cfg.retentionDays) || 7, 90))
      const cut = Date.now() - days * 86400_000
      const dir = join(stateDir, 'frames')
      if (!existsSync(dir)) return
      let n = 0
      for (const f of readdirSync(dir)) {
        const p = join(dir, f)
        try {
          if (statSync(p).isFile() && statSync(p).mtimeMs < cut) { unlinkSync(p); n++ }
        } catch { /* 单个文件清不掉就跳过 */ }
      }
      if (n) log(`清理了 ${n} 个过期截帧（保留 ${days} 天）`)
    } catch (e) { log(`清截帧失败（不影响跑）：${e?.message ?? e}`) }
  }
  try { cleanOldFrames() } catch { /* 启动清理失败不挡挂载 */ }

  // ─────────────────────── 跑一轮 ───────────────────────
  /**
   * 找 dsh（⭐ 对齐桌面版 DeepSeek Harness 2026-10-23 实机排查）：
   *   ① 设置里指的路（用户填的）
   *   ② 桌面版自带的 CLI —— `dsh.cmd` 的真身是
   *      `DeepSeek Harness.exe --expose-internals <app.asar>/dsh/.../dsh-desktop-host/lib/cli.js`，
   *      我们直接按这个形状起（ELECTRON_RUN_AS_NODE=1，走 node 模式，**不经过 cmd**，
   *      避开 cmd.exe 8191 字符参数上限——值班提示词是整段内联的，很容易超）；
   *   ③ 同一台机器的 dsh.cmd（shell 兜底）
   *   ④ npm 全局装的那份 bin.js（老规矩，本机 node 路径会变，不能写死）
   *   ⑤ 都没有 ⇒ 报 missing，**不硬跑**（以前退化成裸 `dsh` ⇒ 一串 GBK 乱码 + exit 1 ✗）
   */
  const desktopCliCandidates = () => {
    const out = []
    const exeDirs = []
    try { if (process.execPath) exeDirs.push(dirname(process.execPath)) } catch { /* 忽略 */ }
    try { if (process.env.LOCALAPPDATA) exeDirs.push(join(process.env.LOCALAPPDATA, 'Programs', 'DeepSeek Harness')) } catch { /* 忽略 */ }
    for (const exeDir of [...new Set(exeDirs)]) {
      if (!exeDir) continue
      const exe = join(exeDir, 'DeepSeek Harness.exe')
      const asar = join(exeDir, 'resources', 'app.asar')
      const cliJs = join(asar, 'dsh', 'node_modules', '@deepseek-ai', 'dsh-desktop-host', 'lib', 'cli.js')
      const dshCmd = join(exeDir, 'resources', 'runtime', 'cli', 'bin', 'dsh.cmd')
      // ② 直连 CLI（node 模式，无 cmd、无参数长度上限）
      // ⭐ cli.js 在 app.asar **归档内部**：普通 fs 的 existsSync 一律 false（只有 Electron 主进程
      //    打了 asar 补丁才查得到）。所以这里只验"主程序 + app.asar 归档"在，cli.js 交给 noStatArgs 免检
      //    （否则直连方案永远被跳过，退回 dsh.cmd —— 而 dsh.cmd 路径带空格，shell 下会被 cmd 截断 ✗）
      try {
        const ok = existsSync(exe) && (existsSync(cliJs) || existsSync(asar))
        if (ok) out.push({ command: exe, args: ['--expose-internals', cliJs], shell: false, noStatArgs: true, env: { ELECTRON_RUN_AS_NODE: '1' } })
      } catch { /* 下一个 */ }
      // ③ 官方启动脚本（shell 兜底；命令带空格 ⇒ 由 shellCmd() 补引号）
      try { if (existsSync(dshCmd)) out.push({ command: dshCmd, args: [], shell: true }) } catch { /* 下一个 */ }
    }
    return out
  }

  /**
   * shell:true 时的命令引号。
   * ⭐ 实机翻车：node 的 spawn(shell:true) 只是把 `command + args` 整串塞进
   *    `cmd /d /s /c "…"`，**不会给 command 单独加引号** —— 路径里带空格
   *    （`…\DeepSeek Harness\…\dsh.cmd`）就被 cmd 砍成 `…\DeepSeek` ⇒
   *    "'C:\Users\netease\AppData\Local\Programs\DeepSeek' 不是内部或外部命令"。
   */
  const shellCmd = (c) => (/[\s"&()^<>|]/.test(c) ? `"${c}"` : c)

  /** 在 PATH 里把 dsh 解析成**绝对路径**再返回（⭐ 安全加固对齐上游 2.0.4：绝不 shell:true 拼提示词） */
  const findOnPath = () => {
    const names = process.platform === 'win32' ? ['dsh.cmd', 'dsh.exe', 'dsh.bat', 'dsh'] : ['dsh']
    for (const d of String(process.env.PATH || '').split(process.platform === 'win32' ? ';' : ':')) {
      const dir = d.replace(/^"|"$/g, '').trim()
      if (!dir) continue
      for (const n of names) {
        try { const p = join(dir, n); if (existsSync(p)) return p } catch { /* 坏路径跳过 */ }
      }
    }
    return ''
  }

  const resolveDsh = () => {
    const tryNode = process.execPath
    const dshBin = String(cfg.dshBin || '').trim()
    const cands = []
    if (dshBin) cands.push({ command: dshBin, args: [], shell: /\.(cmd|bat)$/i.test(dshBin) })
    cands.push(...desktopCliCandidates())
    const appdata = process.env.APPDATA
    if (appdata) cands.push({ command: tryNode, args: [join(appdata, 'npm', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')], shell: false })
    cands.push({ command: tryNode, args: [join(process.env.LOCALAPPDATA || '', 'npm', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')], shell: false })
    const onPath = findOnPath()
    if (onPath) cands.push({ command: onPath, args: [], shell: /\.(cmd|bat)$/i.test(onPath), fallback: true })
    for (const c of cands) {
      try {
        if (c.command === dshBin && dshBin && !existsSync(dshBin)) continue
        // asar 内部的 cli.js 免检（见 desktopCliCandidates 注释）
        if (!c.noStatArgs && c.args?.[0] && !existsSync(c.args[0])) continue
        return { ...c, missing: false }
      } catch { /* 下一个 */ }
    }
    return { missing: true, hint: '没找到 dsh —— 去设置页把 dsh 的路径填一下（桌面版 DeepSeek Harness 自带，一般不用填；或把 dsh 加进 PATH）' }
  }

  /**
   * MCP 服务脚本（`lib/mcp-server.mjs`）交给谁跑。
   * ⭐ 2026-10-23 实机排查：以前写的是 `process.execPath` —— 桌面版里它就是 **Electron 主程序**，
   *    拿它当解释器跑 .mjs 只在"父进程恰好继承了 ELECTRON_RUN_AS_NODE"时才碰巧成功 ✗
   *    （桌面版自己的约定也印证了这点：`runtime/bin/node` 就是 `export ELECTRON_RUN_AS_NODE=1; exec 主程序 --expose-internals`）。
   * ⇒ 优先用桌面版自带的那份**真 node**（primary-runtime 里，v24，无 Electron 戏法）；
   *   实在没有才退回主程序，并把 ELECTRON_RUN_AS_NODE 明确写进 overlay 的 env（**不靠继承**）。
   */
  const nodeForScript = () => {
    const cands = []
    try {
      if (process.execPath) cands.push(join(dirname(process.execPath), 'resources', 'runtime', 'primary-runtime', 'dependencies', 'node', 'bin', 'node.exe'))
      if (process.env.LOCALAPPDATA) cands.push(join(process.env.LOCALAPPDATA, 'Programs', 'DeepSeek Harness', 'resources', 'runtime', 'primary-runtime', 'dependencies', 'node', 'bin', 'node.exe'))
    } catch { /* 忽略 */ }
    for (const p of cands) { try { if (p && existsSync(p)) return { command: p, env: {} } } catch { /* 下一个 */ } }
    if (process.versions.electron) return { command: process.execPath, env: { ELECTRON_RUN_AS_NODE: '1' } }
    return { command: process.execPath || 'node', env: {} }
  }

  /**
   * 给值班轮写一份一次性 overlay：
   *   ① 打开被 headless 默认禁掉的服务（credentials / authorization / deepseek-account）
   *   ② 跟随用户当前选的模型（不然会解析到一个要 API key 的路由上，还没发请求就死）
   *   ③ 挂 `@deepseek-ai/dsh-mcp-client` → 起我们自己的 `lib/mcp-server.mjs`
   */
  const ensureOverlay = () => {
    const file = join(stateDir, 'headless-overlay.yml')
    const script = join(pluginDir, 'lib', 'mcp-server.mjs')
    const posix = (p) => String(p).replace(/\\/g, '/')
    const yml = []
    for (const id of ['credentials', 'authorization', 'deepseek-account']) yml.push('- id: ' + id, '  disabled: false', '')
    try {
      const sel = ctx.get('agentDefaultModel')?.currentSelection?.() ?? null
      const prov = sel?.provider ?? sel?.providerId
      const mod = sel?.model ?? sel?.modelId
      if (prov && mod) {
        yml.push('- id: agent-default-model', '  config:', '    provider: ' + String(prov), '    model: ' + String(mod), '')
      }
    } catch { /* 老版本没这个服务 */ }
    const runner = nodeForScript()
    const extraEnv = Object.entries(runner.env || {})
      .map(([k, v]) => `          ${k}: ${JSON.stringify(String(v))}`)
    yml.push(
      '- insert:',
      '    - id: mcp-douyin-duty',
      "      name: '@deepseek-ai/dsh-mcp-client'",
      '      config:',
      '        serverName: douyin-duty',
      '        transport: stdio',
      `        command: '${posix(runner.command)}'`,
      '        args:',
      `          - '${posix(script)}'`,
      '        env:',
      `          DOUYIN_HOME: '${posix(stateDir)}'`,
      `          DOUYIN_PORT: '${Number(process.env.DOUYIN_PORT || 9333)}'`,
      ...extraEnv,
      '',
    )
    try { writeFileSync(file, yml.join('\n'), 'utf8'); return file } catch (e) { log(`写 overlay 失败：${e?.message ?? e}`); return null }
  }

  /**
   * ⭐ 人设（抄 dsh-bili-scroll 2026-10-21 的口径）：
   *   · 填一串文字 ⇒ 就照这串文字说话；
   *   · 填一个路径（`D:\x\AGENTS.md`，或某个目录 ⇒ 读它下面的 AGENTS.md）⇒ 每轮现读；
   *   · **留空 = 中性说话** —— 绝不猜、绝不偷偷读工作区（bili 上就是"只要给人设就会走偏"那次事故）。
   */
  const readPersona = () => {
    const raw = String(cfg.personaPrompt || '').trim()
    if (!raw) return { text: '', from: '' }
    const looksPath = !raw.includes('\n') && (
      /^[A-Za-z]:[\\/]/.test(raw) || raw.startsWith('\\\\') || raw.startsWith('~/') || /\.(md|txt)$/i.test(raw)
    )
    if (!looksPath) return { text: raw, from: '' }
    try {
      let p = raw.replace(/^~\//, ((process.env.USERPROFILE || '') || '~') + '/')
      if (statSync(p).isDirectory()) {
        // ⭐ 目录：按顺序找第一个存在的（以前只认 AGENTS.md，填个放 PERSONA.md 的目录就白填了）
        const cands = ['AGENTS.md', 'PERSONA.md', 'CLAUDE.md', 'README.md']
        p = cands.map((n) => join(p, n)).find((x) => existsSync(x)) || join(p, 'AGENTS.md')
      }
      const text = readFileSync(p, 'utf8').replace(/^\uFEFF/, '').slice(0, 8000)
      return { text, from: p }
    } catch (e) {
      log(`人设文件没读到（${raw}）：${e?.message ?? e} ⇒ 这一轮按中性说话`)
      return { text: '', from: '', error: String(e?.message ?? e) }
    }
  }

  /** 把 duty.md + 今天的设定拼成那一轮的提示词（**设定内联** —— 那一轮被沙箱关着，读不到配置） */
  const promptFor = () => {
    let charter = ''
    try { charter = readFileSync(charterFile, 'utf8') } catch { charter = '（章程没读到，按常识刷）' }
    const srcs = Object.entries(cfg.sources || {}).filter(([, v]) => v).map(([k]) => k)
    const kw = Array.isArray(cfg.keywords) && cfg.keywords.length ? cfg.keywords.join('、') : '（没填，用章程里的默认组）'
    const users = Array.isArray(cfg.userUrls) && cfg.userUrls.length ? cfg.userUrls.join(' ') : '（没填）'
    const persona = readPersona()
    return [
      '下面这份是「每天替我刷一轮抖音」的值守章程，照它做。做完整整一轮，然后退出。',
      '',
      '【今天的设定】',
      `- 今天是 ${dayKey()}（现在 ${hhmm()}）`,
      `- 开着的来源：${srcs.join('、') || '（一个都没开 —— 去设置页开）'}`,
      `- 关键词：${kw}`,
      `- 指定博主：${users}`,
      `- 每天最多挑 ${Number(cfg.perDay) || 5} 条（硬闸，挑满了就收工）`,
      `- 每条截 ${Number(cfg.framesPerVideo) || 3} 帧；OCR ${cfg.useOcr ? '开' : '关'}；视觉模型 ${cfg.useVision ? '开' : '关'}`,
      `- 报告：${String(cfg.reportLevel || 'full')}`,
      persona.text
        ? `- 人设：见下面【人设】一节${persona.from ? `（现读自 ${persona.from}）` : ''}`
        : '- 人设：（没填 ⇒ 中性说话，别扮演任何人）',
      ...(persona.text
        ? ['', '【人设】（写草稿、写日报里"它自己的一句话"时按这个说话；别把这段念出来）', persona.text]
        : []),
      '',
      '【章程】',
      charter,
      '',
      '最后用一句话汇报你挑到了什么。现在几点了自己看一眼系统时间。',
    ].join('\n')
  }

  /** ⭐ P1（2026-10-24）：这一轮被"验证/风控/掉登录"中止了 —— 写清楚原因，别把 0 条伪装成正常 */
  const abortLatest = () => {
    try {
      const j = readJson(join(stateDir, 'abort-latest.json'), null)
      if (!j || !j.at) return null
      const t = Date.parse(j.at)
      if (!t || t < dutyStartedAt) return null      // 上一轮留下的旧证据，不算这一轮
      return j
    } catch { return null }
  }
  const writeAbortReport = (ab) => {
    try {
      if (String(cfg.reportLevel || 'full') === 'off') return
      const f = join(outDir, `${dayKey()}.md`)
      const block = [
        '',
        '---',
        '',
        `## ⚠️ 这一轮中途被中止（${ab.at}）`,
        '',
        `- 原因：**${ab.reason}**`,
        `- 停在哪：\`${String(ab.url || '').slice(0, 200)}\``,
        ab.shot ? `- 截图：\`${ab.shot}\`` : '',
        '',
        '> 这不是"今天没有值得看的"，而是**刷到一半被拦住了**（验证码 / 风控 / 掉登录）。',
        '> 我没有替你点验证码，也没继续刷。你在设置页点「登录抖音」把页面处理一下，下一轮就能正常跑。',
        '',
      ].filter((x) => x !== '').join('\n')
      if (existsSync(f)) appendFileSync(f, block + '\n', 'utf8')
      else writeFileSync(f, `# 刷抖音 · ${dayKey()} —— 这一轮被中止\n${block}\n`, 'utf8')
      log(`这一轮被中止（${ab.reason}）⇒ 已写进报告`)
    } catch (e) { log(`写中止报告失败（不影响别的）：${e?.message ?? e}`) }
  }

  /** ⭐ 那一轮没写出报告时，宿主补一份占位 —— 别让主人打开 out/ 什么都没有 */
  const stubReportIfMissing = (code) => {
    try {
      if (String(cfg.reportLevel || 'full') === 'off') return
      const f = join(outDir, `${dayKey()}.md`)
      if (existsSync(f)) return
      let tail = ''
      try { tail = readFileSync(logFile, 'utf8').slice(-1500) } catch { /* 读不到就算了 */ }
      writeFileSync(f, [
        `# 刷抖音 · ${dayKey()} —— 这一轮没写出报告`,
        '',
        `> ⚠️ 那一轮结束了，但没生成正常报告（退出码 ${code}）。`,
        '> 常见原因：卡在某个工具上反复重试、预算烧完、或者没登录。下一轮它会重来。',
        '',
        '```',
        String(tail).trim(),
        '```',
        '',
      ].join('\n'), 'utf8')
      log('这一轮没写报告 ⇒ 补了一份占位报告')
    } catch { /* 补不上就算了 */ }
  }

  /**
   * ⭐ 2026-10-24：**动作账本**（`acted.json`，按天记 id → 做过了什么）。
   *   以前 `runActions` 每轮都拿"当天所有 picks"重做一遍 ⇒
   *     ① 收藏是 toggle ⇒ 第二轮把第一轮收藏的**取消**了；
   *     ② 评论会重复发（同一条视频下面刷好几遍）。
   *   现在只处理"本轮还没做过的"，一天一条视频最多收藏 / 评论各一次。
   */
  const readActed = () => readJson(actedFile, {})
  const actedOf = (id) => {
    try { const d = readActed()[dayKey()]; return (d && d[String(id)]) || {} } catch { return {} }
  }
  const markActed = (id, patch) => {
    try {
      const all = readActed()
      const d = all[dayKey()] || (all[dayKey()] = {})
      d[String(id)] = { ...(d[String(id)] || {}), ...patch }
      writeJson(actedFile, all)
    } catch (e) { log(`动作账本没写进去（不影响这一轮）：${e?.message ?? e}`) }
  }

  /**
   * ⭐ 把 outbox 里的一条**真发出去**（唯一能动的入口：轮末 auto 模式 / 面板批准）。
   *   配额按"今天真发出去几条"算；发完写状态，失败不吞。
   */
  const deliverOutboxItem = async (o) => {
    const today = dayKey()
    try {
      if (o.kind === 'comment') {
        const q = quotaLeft(stateDir, today, 'comment', cfg.dailyCommentQuota || 5)
        if (q <= 0) {
          setOutboxStatus(stateDir, o.id, 'pending', '今天的评论配额用完了，留着明天')
          return { ok: false, error: '今天的评论配额用完了' }
        }
        if (!o.videoId) {
          setOutboxStatus(stateDir, o.id, 'failed', '这条没写 videoId，发不了')
          return { ok: false, error: '缺 videoId' }
        }
        await ensureDy()
        const mention = cfg.commentAtEnabled ? String(cfg.mentionName || '').trim().replace(/^@+/, '') : ''
        const r = await comment(session, o.videoId, o.text, { dryRun: false, mention })
        setOutboxStatus(stateDir, o.id, r.ok ? 'sent' : 'failed', r.msg)
        log(`评论（outbox ${o.id} / ${o.videoId}）：${r.msg}`)
        return r
      }
      // ② 私信 / 群：发的是**视频卡片**（分享面板里那一行的「分享」按钮），不带正文。
      //    ⚠️ 用户 2026-10-24 明确改过口径：「私信就别私信总结了，直接在评论区总结并 @」
      //    ⇒ 总结类内容只走评论；这两路只做「把这条视频分享给谁」，受白名单 + 配额 + 开关约束。
      if (o.kind === 'dm' || o.kind === 'group') {
        const isDm = o.kind === 'dm'
        if (isDm && !cfg.dmEnabled) {
          setOutboxStatus(stateDir, o.id, 'failed', '发私信这个开关没开（dmEnabled=false）')
          return { ok: false, error: '私信开关没开' }
        }
        if (!isDm && !cfg.groupEnabled) {
          setOutboxStatus(stateDir, o.id, 'failed', '分享到群这个开关没开（groupEnabled=false）')
          return { ok: false, error: '群分享开关没开' }
        }
        const to = String(o.target || '').trim()
        if (!to) {
          setOutboxStatus(stateDir, o.id, 'failed', '这条没写 target（分享给谁）')
          return { ok: false, error: '缺 target' }
        }
        const wl = (isDm ? cfg.dmWhitelist : cfg.groupWhitelist) || []
        if (wl.length && !wl.includes(to)) {
          setOutboxStatus(stateDir, o.id, 'failed', `「${to}」不在白名单里`)
          return { ok: false, error: `${to} 不在白名单` }
        }
        const quotaKey = isDm ? 'dm' : 'group'
        const quotaMax = Number(isDm ? cfg.dmDailyQuota : cfg.groupDailyQuota) || 2
        if (quotaLeft(stateDir, today, quotaKey, quotaMax) <= 0) {
          setOutboxStatus(stateDir, o.id, 'pending', `今天的${isDm ? '私信' : '群分享'}配额用完了，留着明天`)
          return { ok: false, error: '配额用完' }
        }
        if (!o.videoId) {
          setOutboxStatus(stateDir, o.id, 'failed', '这条没写 videoId，分享不了')
          return { ok: false, error: '缺 videoId' }
        }
        await ensureDy()
        const r = await share(session, o.videoId, to, { dryRun: false })
        setOutboxStatus(stateDir, o.id, r.ok ? 'sent' : 'failed', r.msg)
        log(`分享（outbox ${o.id} / ${o.videoId} → ${to}）：${r.msg}`)
        return r
      }
      setOutboxStatus(stateDir, o.id, 'failed', '不认识的草稿类型：' + String(o.kind))
      return { ok: false, error: '不认识的草稿类型' }
    } catch (e) {
      const msg = String(e?.message ?? e).slice(0, 160)
      setOutboxStatus(stateDir, o.id, 'failed', msg)
      log(`发送 outbox ${o.id} 出错（已兜住）：${msg}`)
      return { ok: false, error: msg }
    }
  }

  /**
   * ⭐ 一轮结束后：宿主按 picks.json / outbox 做收藏 / 评论。
   *   这两只手**只有这里有** —— 模型手里没有（MCP 工具白名单里就没给），
   *   模型只能 `douyin_draft` 写草稿；真发不发、发给谁、发几条，由开关 + 白名单 + 配额说了算。
   */
  const runActions = async (why) => {
    try {
      const all = readJson(picksFile, {})
      const list = Array.isArray(all[dayKey()]) ? all[dayKey()] : []
      const drafts = listOutbox(stateDir, { status: 'pending', limit: 100 })
      if (!list.length && !drafts.length) return
      if (!cfg.favOn && !cfg.autoComment && !drafts.length) return
      // ⭐ 浏览器**按需懒启动**：review 模式只是排队，用不着开浏览器
      //    （以前这里无条件 ensureDy()，等于每跑一轮都把浏览器拉起来）
      let dyReady = false
      const needDy = async () => { if (!dyReady) { await ensureDy(); dyReady = true } }

      // ① 收藏（只处理**今天还没收藏过**的 —— toggle 不会再反向取消）
      if (cfg.favOn) {
        for (const p of list) {
          if (actedOf(p.id).favAt) continue
          await needDy()
          const r = await fav(session, p.id, { dryRun: false })
          log(`收藏 ${p.id}：${r.msg}`)
          if (r.ok) markActed(p.id, { favAt: new Date().toISOString() })
        }
      }

      // ③ 评论：⭐ 草稿（outbox）优先，和「评论并 @ 你」那个老开关**互不牵连**
      //    —— 以前整段挂在 `if (cfg.autoComment)` 里：用户把「发送方式」选成"自动发"、
      //    却关着「评论并 @ 你」，草稿就永远发不出去，连一句日志都没有（P4 自查发现）。
      let commentedOk = 0   // 本轮真发出去的评论数（决定要不要做分享：@ 优先于分享）
      const mention = String(cfg.mentionName || '').trim()
      const perRound = Math.max(0, Math.min(Number(cfg.commentPerRound) || 1, 5))
      const cm = drafts.filter((o) => o.kind === 'comment')
      if (cm.length) {
        if (cfg.outboxMode !== 'auto') {
          log(`评论（${why}）：${cm.length} 条草稿在 outbox 等你批准（outboxMode=review）`)
        } else {
          let left = Math.min(perRound, quotaLeft(stateDir, dayKey(), 'comment', cfg.dailyCommentQuota || 5))
          if (left <= 0) log(`评论（${why}）：今天的配额已经用完，${cm.length} 条草稿留着明天`)
          for (let i = 0; i < cm.length; i++) {
            if (left <= 0) { log(`评论（${why}）：配额用完，剩 ${cm.length - i} 条草稿留着明天`); break }
            const r = await deliverOutboxItem(cm[i])
            if (r.ok) { left--; commentedOk++ }
          }
        }
      } else if (cfg.autoComment && mention) {
        // 没有草稿才用 picks 兜底（兼容老配置：只开 autoComment + mentionName 的用法）
        await needDy()
        let commented = 0
        const left = Math.min(perRound, quotaLeft(stateDir, dayKey(), 'comment', cfg.dailyCommentQuota || 5))
        for (const p of list) {
          if (commented >= left) break
          if (actedOf(p.id).commentAt) continue      // ⭐ 今天已经评论过这条，别再刷一遍
          const body = String(p.reason || '').slice(0, 60)
          const r = await comment(session, p.id, body, { dryRun: false, mention })
          log(`评论 ${p.id}：${r.msg}`)
          if (r.ok) {
            commented++
            commentedOk++
            markActed(p.id, { commentAt: new Date().toISOString() })
            // ⭐ 兜底路径也要记一笔发出的账，否则配额统计永远是 0（真机踩过）
            recordSent(stateDir, { kind: 'comment', target: mention, videoId: p.id, text: body, why: `run/${why}`, note: r.msg })
          }
        }
      }

      // ③ 分享（私信 / 群）：⭐ 用户 2026-10-24 定下的口径 ——
      //    「默认二选一，如能 @ 则跳过分享个人；分享群聊是必备的，不跳过」。
      //    ⇒ ① 私信：只要这轮评论真发出去了（@ 优先），就跳过，草稿留着下次；
      //       ② 群：**不受这条影响**，该发还发（群聊是主人要的固定动作）。
      //    两者都受 outboxMode / 白名单 / 每日配额约束。
      const dmShares = drafts.filter((o) => o.kind === 'dm')
      const groupShares = drafts.filter((o) => o.kind === 'group')
      if (dmShares.length && commentedOk > 0) {
        log(`私信分享（${why}）：本轮已发出 ${commentedOk} 条评论（@ 优先），${dmShares.length} 条私信分享草稿留着下次`)
      }
      const toShare = (commentedOk > 0 ? [] : dmShares).concat(groupShares)
      if (toShare.length) {
        if (cfg.outboxMode !== 'auto') {
          log(`分享（${why}）：${toShare.length} 条在 outbox 等你批准（outboxMode=review）`)
        } else {
          for (const o of toShare) {
            const r = await deliverOutboxItem(o)
            if (!r.ok) log(`分享 outbox ${o.id} 没成：${r.error || r.msg}`)
          }
        }
      } else if (commentedOk > 0 && !groupShares.length) {
        log(`分享（${why}）：本轮走 @（已发 ${commentedOk} 条），不分享`)
      }

      const sent = sentToday(stateDir, dayKey(), 'comment')
      const pend = listOutbox(stateDir, { status: 'pending', limit: 100 }).length
      log(`动作收尾（${why}）：收藏${cfg.favOn ? '开' : '关'}、今日评论已发 ${sent} 条、outbox 待批 ${pend} 条`)
    } catch (e) { log(`动作收尾出错（已兜住）：${e?.message ?? e}`) }
  }

  // ⭐⭐（对齐 dsh-bili-scroll 2.0.4 体检第 2 条）：**同一时间只允许一轮在跑**，并登记这个子进程
  //    —— 定时跳、手动点、聊天工具可能同时触发；以前没锁 ⇒ 同时起两个 headless 轮，
  //    两边抢同一个浏览器 / seen.json，账全乱。卸载插件时也把它一起收掉。
  let dutyChild = null
  let dutyStartedAt = 0
  /** ⭐ 一轮最长多久算卡死。模型卡住/网络半死时子进程可能永远不收尾，
   *  以前这把锁没有超时 ⇒ 之后再也不会跑，直到重启客户端。 */
  const DUTY_TIMEOUT_MIN = 30

  const runDuty = (why = 'window') => {
    try {
      if (dutyChild) {
        const alive = dutyChild.exitCode === null && !dutyChild.killed
        if (alive) {
          const mins = (Date.now() - dutyStartedAt) / 60000
          if (mins > DUTY_TIMEOUT_MIN) {
            // 卡死超时：强制收掉，让这一轮正常开跑（记一笔，事后能看见）
            log(`上一轮跑了 ${Math.round(mins)} 分钟还没结束（超过 ${DUTY_TIMEOUT_MIN} 分钟）⇒ 判为卡死，已强制结束 pid=${dutyChild.pid}`)
            try { dutyChild.kill() } catch { /* 已经没了 */ }
            try { writeJson(join(stateDir, 'lock-timeout.json'), { at: new Date().toISOString(), pid: dutyChild.pid, mins: Math.round(mins) }) } catch { /* 记账失败不影响 */ }
            dutyChild = null
            dutyStartedAt = 0
          } else {
            log(`这一轮没跑（${why}）：上一轮还没结束（pid=${dutyChild.pid}，已跑 ${Math.round(mins * 60)} 秒）`)
            return { started: false, why, busy: true, error: '上一轮还没跑完' }
          }
        }
        dutyChild = null
      }
      refreshCfg()
      const dsh = resolveDsh()
      if (dsh.missing) {
        log('这一轮没跑：' + dsh.hint)
        stubReportIfMissing(1)
        return { started: false, why, error: dsh.hint }
      }
      const overlay = ensureOverlay()
      const profile = String(cfg.headlessProfile || 'headless')
      const args = [...dsh.args, '--profile', profile]
      if (overlay) args.push('--patch', overlay)
      args.push(promptFor())
      const spawnCmd = dsh.shell ? shellCmd(dsh.command) : dsh.command   // 带空格的路径必须补引号
      log(`刷抖音开跑（${why}）：${spawnCmd} … --profile ${profile}（detached 后台进程）`)
      // ⭐ 2026-10-24：这一轮要**独立跑完**（主人原话「到点就真起一个后台 dsh」）
      //   ⇒ detached = 自成一个进程组，客户端关掉/重启不会把它带走；
      //   ⇒ stdout/stderr 直接写 duty.log 的文件描述符，父子间不经过管道（父进程没了也不会 EPIPE）。
      let logFd = -1
      try { logFd = openSync(logFile, 'a') } catch { logFd = -1 }
      const child = spawn(spawnCmd, args, {
        cwd: stateDir,
        shell: dsh.shell,
        windowsHide: true,
        detached: true,
        stdio: logFd >= 0 ? ['ignore', logFd, logFd] : 'ignore',
        env: {
          ...process.env,
          ...(dsh.env || {}),
          // ⭐ Electron 里 spawn 出去的 node 必须带这个，否则它当"再开一个 Electron"、0.17 秒就退出
          ...(process.versions.electron || dsh.env?.ELECTRON_RUN_AS_NODE ? { ELECTRON_RUN_AS_NODE: '1' } : {}),
          DOUYIN_HOME: stateDir,
        },
      })
      // 子进程已经把 fd 继承走了，父进程这份可以关掉（不关会慢慢漏句柄）
      if (logFd >= 0) { try { closeSync(logFd) } catch { /* 关不掉就算了，不影响这一轮 */ } }
      try { child.unref?.() } catch { /* 不支持就算了 */ }
      child.on('exit', (code) => {
        log(`刷抖音结束（${why}，code=${code}）`)
        const ab = abortLatest()
        try {
          const st = readJson(stateFile, {})
          st.day = dayKey()
          st.lastRunAt = new Date().toISOString()
          st.lastWhy = why
          st.picked = countPicked(outDir)
          if (ab) st.lastAbort = { at: ab.at, reason: ab.reason, url: ab.url || '', shot: ab.shot || '' }
          writeJson(stateFile, st)
        } catch { /* 记账失败不影响 */ }
        if (ab) {
          // ⭐ 被验证/风控拦住 ⇒ 写清原因，并且**不做收藏/评论**（那会继续拿用户账号冒险）
          writeAbortReport(ab)
        } else {
          stubReportIfMissing(code)
        }
        rotateLogIfBig()
        if (!ab) Promise.resolve(runActions(why)).catch((e) => log(`动作异常：${e?.message ?? e}`))
      })
      child.on('error', (e) => log(`刷抖音起不来：${e?.message ?? e}`))
      // ⭐ 起不来/被杀掉也要把锁放开，否则之后每一轮都会被判成"上一轮还没结束" ✗
      child.on('close', () => { if (dutyChild === child) dutyChild = null })
      dutyChild = child
      dutyStartedAt = Date.now()
      return { started: true, why, profile: cfg.headlessProfile, log: logFile }
    } catch (e) {
      log(`刷抖音开跑失败（${why}）：${e?.stack ?? e}`)
      return { started: false, why, error: String(e?.message ?? e) }
    }
  }

  // ─────────────────────── 定时器 ───────────────────────
  /**
   * 🔴 定时器回调**必须自己兜住所有异常**（参考项目真机事故：回调里一个 TypeError
   *    没人接 ⇒ 整个 DSH 宿主被带走，所有会话一起没）。
   */
  const tick = () => {
    try {
      refreshCfg()
      const now = new Date()
      const st = readJson(stateFile, {})
      const today = dayKey(now)

      if (countPicked(outDir, now) >= Number(cfg.perDay || 0)) return
      if (String(cfg.reportLevel || 'full') === 'off' && st.day === today && st.lastRunAt) return

      // ① 每日固定时间 —— ⭐ 2026-10-24 改成「到点或已过点、今天还没跑就跑」
      //    以前是 hhmm(now) === dailyAt 的**分钟字面相等**：客户端 07:31 才打开、
      //    或机器那一分钟睡眠/卡顿，这一天就静悄悄没有了（主人原话「到点就真起一个后台 dsh」）。
      //    现在错过点也补跑，且这一轮是 detached 的后台 dsh，客户端关掉也能跑完。
      if (cfg.dailyAt && /^\d{1,2}:\d{2}$/.test(String(cfg.dailyAt))) {
        const key = `${today}:${cfg.dailyAt}`
        const [dh, dm] = String(cfg.dailyAt).split(':').map((x) => Number(x) || 0)
        const due = (now.getHours() * 60 + now.getMinutes()) >= (dh * 60 + dm)
        if (due && st.dailyKey !== key) {
          const late = hhmm(now) === String(cfg.dailyAt) ? '' : `（已过点，补跑；定的是 ${cfg.dailyAt}）`
          writeJson(stateFile, { ...st, dailyKey: key })
          log(`到点了${late} ⇒ 起一个后台 dsh 跑今天这一轮`)
          runDuty('daily')
          return
        }
      }

      // ② 谷时窗口
      if (cfg.peakValley) {
        for (const k of ['noon', 'night']) {
          if (!cfg[k]) continue
          if (!inWindow(now, WINDOWS[k])) continue
          const key = `${today}:${k}`
          if (st.windows?.[key]) continue
          const nst = { ...st, windows: { ...(st.windows || {}), [key]: true } }
          writeJson(stateFile, nst)
          runDuty(`window:${k}`)
          return
        }
      }
    } catch (e) {
      log(`定时器这一跳出错（已兜住，不影响宿主）：${e?.stack ?? e}`)
    }
  }
  try {
    const timer = setInterval(tick, 60_000)
    timer.unref?.()
    ctx.effect(() => () => clearInterval(timer), 'douyin-duty: 定时器')
  } catch (e) { log(`定时器没起来：${e?.message ?? e}`) }

  // ③ 开 dsh 时补跑（今天没跑过 + 现在在谷时）
  try {
    setTimeout(() => {
      try {
        refreshCfg()
        if (!cfg.onStart) return
        const st = readJson(stateFile, {})
        if (st.day === dayKey() && st.lastRunAt) return
        if (isPeak(new Date())) return
        if (countPicked(outDir) >= Number(cfg.perDay || 0)) return
        log('今天还没跑过、现在是谷时 ⇒ 补跑一轮')
        runDuty('onStart')
      } catch (e) { log(`开跑补跑出错（已兜住）：${e?.message ?? e}`) }
    }, 25_000).unref?.()
  } catch { /* 忽略 */ }

  // ─────────────────────── 宿主侧工具（主人在聊天里直接使唤） ───────────────────────
  const safe = (v) => {
    if (v === undefined || v === null || typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') return v
    try { return JSON.parse(JSON.stringify(v)) } catch { return String(v) }
  }
  // 🔧 适配 dsh 0.2.x defineTool：
  //  - parameters 由「整张 JSON Schema（{type:'object',properties:…}）」改为「每参数一张表」
  //    （根 object 隐式，必填用 { …, required: true } 标在属性上）
  //  - output 由「裸 schema」改为 { schema, render }；render 返回内容部件数组
  const tool = (spec) => {
    const old = (spec.parameters && spec.parameters.type === 'object') ? spec.parameters : { properties: spec.parameters || {} }
    const requiredSet = new Set(old.required || [])
    const parameters = {}
    for (const [k, v] of Object.entries(old.properties || {})) {
      parameters[k] = requiredSet.has(k) ? { ...v, required: true } : { ...v }
    }
    return ctx.tools.register(defineTool({
      name: spec.name,
      description: spec.description,
      parameters,
      output: {
        schema: { type: 'json' },
        render: (_args, value) => [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }],
      },
      async execute(args, exec) { return safe(await spec.execute(args, exec)) },
    }))
  }

  tool({
    name: 'douyin_run',
    description: '**立刻跑一轮刷抖音**（不等定时）：起一个 headless 会话去刷、写日报。报告在插件家目录的 out/<日期>.md。',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    async execute() { const r = runDuty('manual'); return { ok: true, ...r } },
  })

  tool({
    name: 'douyin_whoami',
    description: '看抖音那边登录的是谁。没登录要先去设置页点「登录抖音」。',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    async execute() { const d = await ensureDy(); return await d.whoami() },
  })

  tool({
    name: 'douyin_look',
    description: '随手看一眼抖音（不跑完整一轮）：keyword=搜关键词 / hot=看热榜 / following=看关注 / feed=看推荐。',
    parameters: {
      type: 'object',
      properties: {
        what: { type: 'string', description: 'hot / following / feed / search' },
        keyword: { type: 'string', description: 'what=search 时的关键词' },
        n: { type: 'number', description: '几条（默认 8）' },
      },
      additionalProperties: false,
    },
    async execute(a) {
      const d = await ensureDy()
      const n = Number(a?.n) || 8
      const what = String(a?.what || 'hot')
      if (what === 'search') return await d.search(String(a?.keyword || ''), n)
      if (what === 'following') return await d.following(n)
      if (what === 'feed') return await d.feed(n)
      return await d.hot(n)
    },
  })

  tool({
    name: 'douyin_state',
    description: '看它今天的状态：挑了几条、额度剩多少、报告在哪、登录没、下次什么时候跑。',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    async execute() {
      refreshCfg()
      const st = readJson(stateFile, {})
      const picks = readJson(picksFile, {})[dayKey()] || []
      return {
        ok: true,
        today: dayKey(),
        pickedToday: countPicked(outDir),
        perDay: Number(cfg.perDay) || 5,
        picksLogged: Array.isArray(picks) ? picks.length : 0,
        report: existsSync(join(outDir, `${dayKey()}.md`)) ? join(outDir, `${dayKey()}.md`) : '',
        lastRunAt: st.lastRunAt || '',
        peakNow: isPeak(new Date()),
        sources: cfg.sources,
        log: logFile,
      }
    },
  })

  // ─────────────────────── HTTP：设置页用 ───────────────────────
  const readBody = async (req) => {
    let raw = ''
    for await (const chunk of req) raw += chunk
    try { return raw ? JSON.parse(raw) : {} } catch { return {} }
  }
  const sendJson = (res, code, obj) => {
    try {
      const body = JSON.stringify(obj)
      res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
      res.end(body)
    } catch { /* 管道断了 */ }
  }

  // ═══════════════════ 加固：本地 API 护栏（2026-10-23）═══════════════════
  // 审查结论：这些端点原来既不看 Origin 也不看 Content-Type，任意网页都能用
  //   text/plain 的"简单请求"改配置（开 autoComment + favOn、填 mentionName）
  //   再 POST /run —— 等于用主人账号公开发评论。所以这里补四道：
  //   1) 只认回环 Host（127.0.0.1 / localhost / [::1]）；
  //   2) 带 Origin / Sec-Fetch-Site 的，必须同源；
  //   3) 非 GET 必须 `Content-Type: application/json`（挡简单请求 CSRF）；
  //   4) 三个改状态的入口（/config、/run、/login/start）还要带 `x-douyin-token`：
  //      token 每次启动随机生成，只经同源 `GET /token` 交给设置页，不落盘。
  const apiToken = randomBytes(24).toString('hex')
  const LOOPBACK = /^(127\.0\.0\.1|localhost|\[::1\]|::1)$/i
  const TOKEN_ROUTES = new Set([
    '/api/douyin-duty/config', '/api/douyin-duty/run', '/api/douyin-duty/login/start',
    '/api/douyin-duty/outbox/approve', '/api/douyin-duty/outbox/discard',
  ])
  const apiGuard = (req, path) => {
    try {
      const host = String(req.headers.host || '').replace(/:\d+$/, '')
      if (!LOOPBACK.test(host)) return '只允许本机访问'
      const origin = req.headers.origin
      if (origin) {
        let oh = ''
        try { oh = new URL(String(origin)).hostname } catch { return 'Origin 不合法' }
        if (!LOOPBACK.test(oh)) return '跨源请求被拒'
      }
      const site = String(req.headers['sec-fetch-site'] || '')
      if (site && site !== 'same-origin' && site !== 'none') return '跨站请求被拒'
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        if (!String(req.headers['content-type'] || '').toLowerCase().includes('application/json')) return '只收 application/json'
        if (TOKEN_ROUTES.has(path) && String(req.headers['x-douyin-token'] || '') !== apiToken) return '缺少或错误的 x-douyin-token'
      }
      return ''
    } catch { return '护栏异常' }
  }

  // ⭐ 配置字段白名单：只认 config.json 里真有的键，且只收原始值 / 字符串数组 / 布尔表。
  //   以前是 `saveCfg(body)` 原样并进去 ⇒ 任何键都能落盘（`dshBin` 会被当成可执行文件启动）。
  const CFG_EXTRA_KEYS = ['sources', 'keywords', 'userUrls', 'reportLevel', 'visionLang', 'logLevel', 'visionBackups', 'dmWhitelist', 'groupWhitelist', 'personaPrompt']
  const CFG_KEYS = new Set([...Object.keys(DEFAULT_CFG), ...CFG_EXTRA_KEYS])
  const LIST_KEYS = new Set(['keywords', 'userUrls', 'dmWhitelist', 'groupWhitelist'])
  const pickCfg = (body) => {
    const out = {}
    const rejected = []
    if (!body || typeof body !== 'object' || Array.isArray(body)) return { out, rejected: ['body'] }
    for (const [k, v] of Object.entries(body)) {
      if (!CFG_KEYS.has(k)) { rejected.push(k); continue }
      if (k === 'sources') {
        if (!v || typeof v !== 'object' || Array.isArray(v)) { rejected.push(k); continue }
        const s = {}
        for (const [sk, sv] of Object.entries(v)) { if (typeof sv === 'boolean') s[sk] = sv; else rejected.push('sources.' + sk) }
        out.sources = s
        continue
      }
      // ⭐ P3：备用视觉每行一条 `接口 | 模型 | 密钥` —— 只按换行拆，别把 `|` 也拆了
      if (k === 'visionBackups') {
        const arr = Array.isArray(v) ? v : (typeof v === 'string' ? v.split(/\r?\n/) : null)
        if (!arr || arr.some((x) => typeof x !== 'string')) { rejected.push(k); continue }
        out[k] = arr.map((s) => s.trim()).filter(Boolean).slice(0, 2)
        continue
      }
      // ⭐ 人设提示词：一长串文字（也允许是一个文件/目录路径），限 8000 字
      if (k === 'personaPrompt') {
        if (typeof v !== 'string') { rejected.push(k); continue }
        out[k] = v.slice(0, 8000)
        continue
      }
      if (LIST_KEYS.has(k)) {
        const arr = Array.isArray(v) ? v : (typeof v === 'string' ? [v] : null)
        if (!arr || arr.some((x) => typeof x !== 'string')) { rejected.push(k); continue }
        out[k] = splitList(arr, k === 'keywords' ? KW_RE : URL_RE)
        continue
      }
      if (typeof v === 'string' || typeof v === 'boolean') { out[k] = v; continue }
      if (typeof v === 'number' && Number.isFinite(v)) { out[k] = v; continue }
      rejected.push(k)
    }
    return { out, rejected }
  }

  const handle = async (req, res) => {
    const u = new URL(req.url, 'http://127.0.0.1')
    const path = u.pathname

    const guardErr = apiGuard(req, path)
    if (guardErr) {
      log(`挡下一个 API 请求（${guardErr}）：${req.method} ${path}`)
      return sendJson(res, 403, { ok: false, error: guardErr })
    }

    // 设置页启动时先来拿 token（同源才给）
    if (req.method === 'GET' && path === '/api/douyin-duty/token') {
      return sendJson(res, 200, { ok: true, token: apiToken })
    }

    if (req.method === 'GET' && path === '/api/douyin-duty/config') {
      refreshCfg()
      return sendJson(res, 200, { ok: true, cfg, version: myVer, home: stateDir })
    }

    if (req.method === 'POST' && path === '/api/douyin-duty/config') {
      const body = await readBody(req)
      const { out, rejected } = pickCfg(body)
      const prevMode = String(cfg.browserMode || 'auto')
      saveCfg(out)
      log('设置已改：' + Object.keys(out).join(',') + (rejected.length ? `（拒收：${rejected.join(',')}）` : ''))
      // ⭐ 2026-10-24 真机：「浏览器窗口」这一项以前只在第一次建 session 时读一次 cfg，
      //   之后再改 headless/visible 都不会动，主人以为"设了没生效"。改成当场切。
      const newMode = String(cfg.browserMode || 'auto')
      if (session && newMode !== prevMode) {
        try {
          await session.setMode(newMode)
          log(`浏览器窗口已切到 ${newMode}`)
        } catch (e) { log(`切浏览器窗口失败（不影响下一轮）：${e?.message ?? e}`) }
      }
      return sendJson(res, 200, { ok: true, cfg, rejected, browserMode: newMode })
    }

    if (req.method === 'GET' && path === '/api/douyin-duty/status') {
      refreshCfg()
      const st = readJson(stateFile, {})
      // ⭐ P0：**只探活，不起浏览器** —— 以前面板一刷新就把浏览器拉起来（用户：点开插件就开浏览器、很烦）
      let me = { loggedIn: false }
      let binfo = { alive: false, port: 0, mode: String(cfg.browserMode || 'auto') }
      try {
        if (session) binfo = { ...binfo, ...(await session.aliveInfo()) }
        if (binfo.alive) me = await (await ensureDy()).whoami()
      } catch { /* 探不到就当没开 */ }
      return sendJson(res, 200, {
        ok: true,
        version: myVer,
        home: stateDir,
        today: dayKey(),
        pickedToday: countPicked(outDir),
        perDay: Number(cfg.perDay) || 5,
        lastRunAt: st.lastRunAt || '',
        loggedIn: Boolean(me?.loggedIn),
        who: me?.name || '',
        peakNow: isPeak(new Date()),
        browser: binfo,
        lastAbort: st.lastAbort || null,
        outbox: {
          pending: listOutbox(stateDir, { status: 'pending', limit: 100 }).length,
          mode: String(cfg.outboxMode || 'review'),
          sentToday: sentToday(stateDir, dayKey(), 'comment'),
          quota: Number(cfg.dailyCommentQuota) || 5,
        },
        report: existsSync(join(outDir, `${dayKey()}.md`)) ? join(outDir, `${dayKey()}.md`) : '',
        log: logFile,
      })
    }

    // 登录：开一个**看得见的**浏览器窗口，让主人在里面扫码
    if (req.method === 'POST' && path === '/api/douyin-duty/login/start') {
      try {
        await ensureDyFresh('visible')   // ⭐ 登录必须让人看见窗口：关掉复用的那个、重开一个真窗口
        const t = await session.tab('https://www.douyin.com/')
        try { await session.show() } catch { /* 有些窗口不让切，不影响扫码 */ }
        log('已打开登录窗口，等主人扫码')
        return sendJson(res, 200, { ok: true, hint: '浏览器窗口已打开 —— 在里面扫码登录抖音，登完这边会自动变成"已登录"' })
      } catch (e) { return sendJson(res, 200, { ok: false, error: String(e?.message ?? e) }) }
    }

    if (req.method === 'GET' && path === '/api/douyin-duty/login/poll') {
      try {
        const me = await (await ensureDy()).whoami()
        return sendJson(res, 200, { ok: true, state: me.loggedIn ? 'ok' : 'wait', who: me.name || '' })
      } catch (e) { return sendJson(res, 200, { ok: false, state: 'wait', error: String(e?.message ?? e) }) }
    }

    if (req.method === 'POST' && path === '/api/douyin-duty/run') {
      const r = runDuty('manual')
      return sendJson(res, 200, { ok: true, ...r })
    }

    // 「测一下」：登录 + 各来源各取一条，直接回答"能不能用"
    if (req.method === 'GET' && path === '/api/douyin-duty/test') {
      const out = { ok: true, steps: [] }
      try {
        const d = await ensureDy()
        const me = await d.whoami()
        out.steps.push({ name: '登录', ok: me.loggedIn, msg: me.loggedIn ? `已登录：${me.name}` : '没登录' })
        if (me.loggedIn) {
          const s = await d.search((Array.isArray(cfg.keywords) && cfg.keywords[0]) || 'AI', 3)
          out.steps.push({ name: '搜索', ok: Boolean(s?.ok && s.count), msg: `${s?.count || 0} 条` })
          const h = await d.hot(5)
          out.steps.push({ name: '热榜', ok: Boolean(h?.ok && h.count), msg: `${h?.count || 0} 条` })
          const f = await d.following(3)
          out.steps.push({ name: '关注', ok: Boolean(f?.ok && f.count), msg: `${f?.count || 0} 条` })
          if (s?.items?.[0]) {
            const fr = await d.frames(s.items[0].id, 1)
            out.steps.push({ name: '截帧', ok: Boolean(fr?.ok), msg: fr?.ok ? `${fr.frames.length} 帧` : (fr?.error || '失败') })
          }
        }
      } catch (e) { out.ok = false; out.error = String(e?.message ?? e) }
      return sendJson(res, 200, out)
    }

    if (req.method === 'GET' && path === '/api/douyin-duty/reports') {
      try {
        const files = (await import('node:fs')).readdirSync(outDir).filter((f) => f.endsWith('.md')).sort().reverse().slice(0, 30)
        return sendJson(res, 200, { ok: true, files })
      } catch { return sendJson(res, 200, { ok: true, files: [] }) }
    }

    if (req.method === 'GET' && path === '/api/douyin-duty/report') {
      const day = String(u.searchParams.get('day') || dayKey())
      // ⭐ 只认 YYYY-MM-DD：以前直接 join(outDir, day + '.md') ⇒ `..\..\..\x` 能读任意 .md
      if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return sendJson(res, 400, { ok: false, error: 'day 只接受 YYYY-MM-DD' })
      try {
        const txt = readFileSync(join(outDir, `${day}.md`), 'utf8')
        return sendJson(res, 200, { ok: true, day, md: txt })
      } catch { return sendJson(res, 200, { ok: false, error: '没有这一天的报告' }) }
    }

    if (req.method === 'GET' && path === '/api/douyin-duty/log') {
      try {
        const txt = readFileSync(logFile, 'utf8')
        return sendJson(res, 200, { ok: true, tail: txt.slice(-4000) })
      } catch { return sendJson(res, 200, { ok: true, tail: '（还没有日志）' }) }
    }

    // ⭐ P4：待发件箱（模型只能往这里写草稿，真发要过批准 + 白名单 + 配额）
    if (req.method === 'GET' && path === '/api/douyin-duty/outbox') {
      refreshCfg()
      return sendJson(res, 200, {
        ok: true,
        today: dayKey(),
        mode: String(cfg.outboxMode || 'review'),
        pending: listOutbox(stateDir, { status: 'pending', limit: 100 }).length,
        sentToday: sentToday(stateDir, dayKey(), 'comment'),
        quota: { comment: Number(cfg.dailyCommentQuota) || 5, dm: Number(cfg.dmDailyQuota) || 1, group: Number(cfg.groupDailyQuota) || 1 },
        items: listOutbox(stateDir, { limit: 40 }),
      })
    }

    if (req.method === 'POST' && path === '/api/douyin-duty/outbox/approve') {
      refreshCfg()
      const body = await readBody(req)
      const ids = (Array.isArray(body?.ids) ? body.ids : [body?.id]).map(String).filter(Boolean).slice(0, 10)
      if (!ids.length) return sendJson(res, 400, { ok: false, error: '没给 ids' })
      const results = []
      for (const id of ids) {
        const o = readOutbox(stateDir).find((x) => x.id === id)
        if (!o) { results.push({ id, ok: false, error: '没有这条' }); continue }
        setOutboxStatus(stateDir, id, 'approved', '面板批准')
        const r = await deliverOutboxItem({ ...o, status: 'approved' })
        results.push({ id, kind: o.kind, ok: Boolean(r?.ok), msg: r?.msg || r?.error || '' })
      }
      return sendJson(res, 200, { ok: true, results })
    }

    if (req.method === 'POST' && path === '/api/douyin-duty/outbox/discard') {
      const body = await readBody(req)
      const ids = (Array.isArray(body?.ids) ? body.ids : [body?.id]).map(String).filter(Boolean).slice(0, 50)
      if (!ids.length) return sendJson(res, 400, { ok: false, error: '没给 ids' })
      const results = ids.map((id) => ({ id, ...setOutboxStatus(stateDir, id, 'rejected', '面板丢弃') }))
      return sendJson(res, 200, { ok: true, results })
    }

    // 测视觉：主 + 各备用各打一发，看鉴权/模型名对不对（不验看图能力）
    if (req.method === 'GET' && path === '/api/douyin-duty/test-vision') {
      refreshCfg()
      try {
        const r = await probeVision({
          apiBase: cfg.visionApiBase, apiKey: cfg.visionApiKey, model: cfg.visionModel, backups: cfg.visionBackups,
        })
        return sendJson(res, 200, { ok: r.ok, steps: r.steps })
      } catch (e) { return sendJson(res, 200, { ok: false, steps: [], error: String(e?.message ?? e) }) }
    }

    return sendJson(res, 404, { ok: false, error: `unknown ${req.method} ${path}` })
  }

  try {
    ctx.effect(() => ctx.webServer.register({
      kind: 'prefix',
      path: '/api/douyin-duty',
      handler: async (req, res) => {
        try { await handle(req, res) } catch (e) { sendJson(res, 500, { ok: false, error: e?.message ?? String(e) }) }
      },
    }), 'douyin-duty: /api/douyin-duty 路由')
  } catch (e) { log(`HTTP 路由没挂上：${e?.message ?? e}`) }

  ctx.effect(() => () => { try { session?.stop() } catch { /* 收摊 */ } }, 'douyin-duty: 收浏览器')
  // ⭐（2.0.4）卸载/重载插件时把正在跑的那一轮也收掉，别让它变成没人管的孤儿进程
  ctx.effect(() => () => {
    try { if (dutyChild && dutyChild.exitCode === null) dutyChild.kill() } catch { /* 收摊 */ }
  }, 'douyin-duty: 收跑一轮的子进程')
  log('已挂载')
}
