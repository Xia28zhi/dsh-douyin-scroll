/**
 * lib/state.mjs —— 插件的"家"与状态
 * ============================================================================
 * 规矩（跟参考项目一致）：**配置、凭证、报告、日志、截帧都放插件自己的家**
 * `$DSH_HOME/douyin-duty/`，**绝不写进插件包目录**（装进 node_modules 后可能只读、升级也会被覆盖）。
 *
 * 家里都有什么：
 *   config.json   用户配置（设置页写这里，**这一份是权威**）
 *   state.json    今天跑了几轮 / 挑了几条 / 上次跑的时间
 *   seen.json     看过的 aweme_id（去重，别老推同一条）
 *   picks.json    这一轮挑中的（宿主侧拿它去做收藏 / 评论 —— 模型碰不到这只手）
 *   out/<日期>.md 日报
 *   frames/       截帧落盘
 *   duty.md       一轮要做的事（判定口径 + 红线，**用户可以改**）
 *   duty.log      日志
 *   browser/      浏览器 profile（登录态就存在这儿，重启也在）
 * ============================================================================
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, copyFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { homedir } from 'node:os'

/**
 * 谷时窗口（北京时间）—— 想改就改这一处。
 * 口径同参考项目：DeepSeek **工作日 9–12 / 14–18 是高峰**，其余（含整个周末）都是谷时。
 */
export const WINDOWS = {
  noon: { label: '中午谷时', start: '12:00', end: '14:00' },
  night: { label: '晚上/夜间谷时', start: '18:00', end: '09:00' },
}

/**
 * ⭐ `ctx.get('dshHomePath')` 返回的是**函数**不是字符串（参考项目真机踩过：
 *    当字符串用 ⇒ 路径变成"函数源码 + 目录名" ⇒ mkdir ENOENT ⇒ apply 抛错 ⇒ 插件不激活）。
 */
export function stateDirOf(ctx) {
  let dir = ''
  try {
    const p = ctx?.get?.('dshHomePath')
    if (typeof p === 'function') dir = String(p('douyin-duty') || '')
    else if (typeof p === 'string' && p) dir = join(p, 'douyin-duty')
  } catch { /* 拿不到就用兜底 */ }
  if (!dir) dir = join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'douyin-duty')
  mkdirSync(dir, { recursive: true })
  return dir
}

export const DEFAULT_CFG = {
  // ── 刷什么 ──
  sources: {
    feed: false,          // 推荐流（用户最终没选，默认关；开了也能用）
    search: true,         // 关键词搜索
    following: true,      // 关注列表
    hot: true,            // 热榜
    users: true,          // 指定博主
  },
  keywords: [],           // 留空 = 用章程里的默认那几组
  userUrls: [],           // 博主主页链接（支持 https://www.douyin.com/user/xxx 或纯 sec_uid）

  // ── 怎么判 ──
  perDay: 5,              // 每天最多挑几条
  framesPerVideo: 3,      // 每条截几帧
  useVision: false,       // 画面截帧 + 视觉模型（要填视觉 API）
  useOcr: true,           // 画面截帧 + 本地 OCR（Windows 内置，零依赖）
  visionApiBase: '',
  visionApiKey: '',
  visionModel: '',
  visionBackups: [],      // ⭐ P3：备用视觉，每行 `接口 | 模型 | 密钥`（最多 2 条），主挂了自动顶上去
  visionLang: 'zh',       // OCR 语言

  // ── 产出 ──
  reportLevel: 'full',    // full=完整 / brief=每条一两行 / off=不写
  favOn: false,           // 自动收藏（默认关）
  autoComment: false,     // 评论 @ 你（默认关 —— 拿你的号公开说话）
  mentionName: '',        // 要 @ 的抖音昵称（留空 = 不发）
  commentPerRound: 1,     // 每轮最多几条（0–5）

  // ── ⭐ P4：对外发言（默认全关；发之前一律先进 outbox）──
  commentAtEnabled: false,   // 评论时走"真 @"（先弹下拉再点人）；关着就是正文里写 @名字
  dailyCommentQuota: 5,      // 每天最多发几条评论（按"真发出去的"算）
  outboxMode: 'review',      // review=轮末只入队，等你批准（默认）/ auto=过白名单+配额就自动发
  dmEnabled: false,          // 私聊（默认关；这一版只入队不自动发，见 lib/outbox.mjs 头注释）
  dmWhitelist: [],           // 只给名单里的人发（空 = 一个都不发）
  dmDailyQuota: 1,
  groupEnabled: false,       // 群消息（同上）
  groupWhitelist: [],
  groupDailyQuota: 1,

  // ── 什么时候跑 ──
  peakValley: false,      // 谷时自动跑（总开关）
  noon: true,
  night: true,
  dailyAt: '',            // 每日固定时间 HH:mm（留空=不启用）
  onStart: false,         // 开 dsh 时补跑（今天没跑过 + 在谷时内）

  // ── 环境 ──
  // ⭐ 2026-10-24（P0/P2）：显示方式 + 截帧保留天数
  browserMode: 'auto',    // auto=先 hidden，起不来退 headless / hidden=真窗口挪屏幕外+最小化 / headless=无窗口 / visible=正常窗口（登录用）
  retentionDays: 7,       // frames 里超过这么多天的截帧，启动时清掉，别无声长到几 GB
  scanLimit: 60,          // 一轮最多刷多少条候选（超过就拦住后面的刷取、直接收尾）
  // ⭐ 2026-10-24（对齐 dsh-bili-scroll）：人设提示词 —— 写草稿/评论/日报时按它说话；
  //    也可以填一个文件（或目录，读里面的 AGENTS.md）路径，每轮现读。留空 = 中性说话。
  personaPrompt: '',
  headlessProfile: 'headless',
  dshBin: '',
  logLevel: 'normal',
}

export function readJson(file, fallback) {
  try { return JSON.parse(readFileSync(file, 'utf8')) } catch { return fallback }
}

/**
 * ⭐（对齐 dsh-bili-scroll 2.0.4）：**原子写** —— 先写临时文件再 rename。
 *    以前直接 writeFileSync：写到一半进程被杀 / 磁盘忙（EBUSY）⇒ config.json / state.json
 *    留下半截 JSON，下次 readJson 静默回退默认值 ⇒ 用户的设置无声丢了 ✗
 */
export function writeJson(file, value) {
  try {
    const tmp = file + '.tmp'
    writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf8')
    try { renameSync(tmp, file) } catch { try { copyFileSync(tmp, file) } catch { return false } }
    return true
  } catch { return false }
}

/**
 * ⭐（对齐 dsh-bili-scroll 2.0.x M6）：值班章程升级改**记账制** —— 上次铺的是哪一版（sha256）
 *    记在 `charter.sha256`：
 *      · 家里那份 === 我们上次铺的 ⇒ 他没动过 ⇒ 直接覆盖（插件升级时章程改进能进来 ✓）
 *      · 家里那份改过           ⇒ 一个字都不动，新版另存 `duty.md.new` 让他自己合 ✓
 *      · 没有账本（第一次带账本的版本）⇒ 分不清"没改只是旧"和"改过"，按改过处理，宁可手动合一次 ✓
 *    以前的规矩是"只在缺失时铺一次" ⇒ 插件后续版本改进的章程**永远进不来** ✗
 */
export function ensureCharter(pluginDir, stateDir, log = () => {}) {
  const shipped = join(pluginDir, 'prompts', 'duty.md')
  const home = join(stateDir, 'duty.md')
  const ledger = join(stateDir, 'charter.sha256')
  const fresh = join(stateDir, 'duty.md.new')
  const readIf = (f) => { try { return readFileSync(f, 'utf8') } catch { return '' } }
  try {
    if (!existsSync(shipped)) { log(`缺文件：${shipped}`); return }
    const sha = (s) => createHash('sha256').update(s, 'utf8').digest('hex')
    const newText = readFileSync(shipped, 'utf8')
    const hShip = sha(newText)
    const hLast = readIf(ledger).trim()
    if (!existsSync(home)) {
      writeFileSync(home, newText, 'utf8'); writeFileSync(ledger, hShip, 'utf8')
      log('已铺好值班章程（你可以改它）')
      return
    }
    const hHome = sha(readFileSync(home, 'utf8'))
    if (hHome === hShip) {                              // 家里那份就是最新版
      if (hLast !== hShip) writeFileSync(ledger, hShip, 'utf8')
      return
    }
    if (!hLast || hHome !== hLast) {                    // 他改过（或没账本）⇒ 只另存新版
      if (hShip !== hLast && readIf(fresh) !== newText) {
        writeFileSync(fresh, newText, 'utf8')
        log(`值班章程有新版、但家里那份你改过 ⇒ 新版另存为 ${fresh}，自己合一下`)
      }
      return
    }
    writeFileSync(home, newText, 'utf8'); writeFileSync(ledger, hShip, 'utf8')   // 他没动过 ⇒ 直接升级
    log('值班章程已更新到插件里这一版')
  } catch (e) { log(`铺值班章程失败：${e?.message ?? e}`) }
}

/** 北京时间 yyyy-mm-dd（**按本地时区**，跟使用者手表上的"今天"一致） */
export function dayKey(d = new Date()) {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

export function hhmm(d = new Date()) {
  return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0')
}

const toMin = (s) => {
  const [h, m] = String(s || '0:0').split(':').map((n) => Number(n) || 0)
  return h * 60 + m
}

/** 现在是谷时吗（工作日 9–12 / 14–18 是高峰） */
export function isPeak(now = new Date()) {
  const wd = now.getDay()
  if (wd === 0 || wd === 6) return false              // 周末全是谷时
  const m = now.getHours() * 60 + now.getMinutes()
  return (m >= toMin('09:00') && m < toMin('12:00')) || (m >= toMin('14:00') && m < toMin('18:00'))
}

/** 在某个窗口内（支持跨夜，如 18:00–09:00） */
export function inWindow(now, w) {
  const m = now.getHours() * 60 + now.getMinutes()
  const s = toMin(w.start)
  const e = toMin(w.end)
  return s <= e ? (m >= s && m < e) : (m >= s || m < e)
}

/** 今天挑了几条：从今天的报告里数 `### ` 段首（报告是事实来源） */
export function countPicked(outDir, now = new Date()) {
  try {
    const f = join(outDir, `${dayKey(now)}.md`)
    if (!existsSync(f)) return 0
    const txt = readFileSync(f, 'utf8')
    return (txt.match(/^###\s+\S+/gm) || []).length
  } catch { return 0 }
}

/** 去重表：见过的 aweme_id */
export function seenFile(dir) { return join(dir, 'seen.json') }

export function loadSeen(dir) {
  return readJson(seenFile(dir), {})
}

export function markSeen(dir, ids) {
  const s = loadSeen(dir)
  const today = dayKey()
  for (const id of ids) s[String(id)] = today
  // 只留最近 30 天，别让它无声地长
  const cut = new Date(Date.now() - 30 * 86400_000)
  const cutKey = dayKey(cut)
  for (const [k, v] of Object.entries(s)) if (String(v) < cutKey) delete s[k]
  writeJson(seenFile(dir), s)
  return s
}

export function ensureDirs(dir) {
  for (const sub of ['out', 'frames']) mkdirSync(join(dir, sub), { recursive: true })
}
