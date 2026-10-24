/**
 * lib/mcp-server.mjs —— 给"值班那一轮"用的 MCP stdio 服务端
 * ============================================================================
 * 为什么要有它：**某个 profile 能拿到什么工具，取决于它自己那一层的 patch**。
 * 值班跑在 `headless` profile 里，它不一定加载本插件 ⇒ 那一轮的模型手里就会空空如也。
 * ⇒ 我们学参考项目的做法：**跑的时候 `--patch` 一份一次性 overlay**，
 *    overlay 里挂 `@deepseek-ai/dsh-mcp-client`（宿主自带，一定能解析）→ 它来起**本文件**。
 *
 * 🔴 工具白名单 = 安全边界（只在白名单里的才注册，**名字都不给它看见**）：
 *   · 给的是"读 + 写报告/记录"：feed / search / hot / following / user_posts / detail / frames / pick / report / status
 *   · **不给**的是"会动你账号的手"：收藏、发评论 ✗
 *     ⇒ 那两只手只在**宿主侧**按 `picks.json` + 开关执行，模型说什么都碰不到。
 *
 * 环境：由 overlay 传入 `DOUYIN_HOME`（家目录）、`DOUYIN_PORT`（浏览器调试端口）。
 * ============================================================================
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, appendFileSync } from 'node:fs'
import { join } from 'node:path'
import { BrowserSession } from './browser.mjs'
import { Douyin } from './douyin.mjs'
import { ocrFiles } from './ocr.mjs'
import { describeFrames } from './vision.mjs'
import { dayKey, readJson, writeJson, loadSeen, markSeen, ensureDirs, DEFAULT_CFG } from './state.mjs'
import { addDraft, listOutbox, quotaLeft, hitWhitelist, OUTBOX_KINDS } from './outbox.mjs'

const HOME = process.env.DOUYIN_HOME || ''
const PORT = Number(process.env.DOUYIN_PORT || 9333)
ensureDirs(HOME)

/**
 * ⭐ 配置要跟默认值合一遍再用：家目录里 `config.json` 可能还没生成（第一次跑），
 *    直接用空对象会把 `useOcr` 这类**默认开**的开关读成关 ✗（实测踩到）。
 */
const readCfg = () => {
  const c = { ...DEFAULT_CFG, ...readJson(join(HOME, 'config.json'), {}) }
  c.sources = { ...DEFAULT_CFG.sources, ...(c.sources || {}) }
  return c
}
let CFG = readCfg()

const log = (m) => { try { appendFileSync(join(HOME, 'duty.log'), `${new Date().toISOString()}  [mcp] ${m}\n`, 'utf8') } catch { /* 写不进去就算了 */ } }

let session = null
let dy = null
// ⭐ P1（2026-10-24）：这一轮被"验证 / 风控 / 掉登录"拦住之后的标记 —— 置上以后不再刷
let ABORTED = ''
const dyReady = async () => {
  if (!session) session = new BrowserSession({ dir: HOME, port: Number(PORT) || 0, mode: String((CFG && CFG.browserMode) || 'auto'), log })
  if (!dy) { await session.start(); dy = new Douyin(session, { log, dir: HOME }) }
  return dy
}

const safe = (v) => { try { return JSON.parse(JSON.stringify(v)) } catch { return String(v) } }

// ─────────────────────────── 工具实现 ───────────────────────────

async function tWhoami() {
  const d = await dyReady()
  return safe(await d.whoami())
}

// ─────────────────────── 本轮扫描预算（2026-10-24） ───────────────────────
// 起因：一轮把 5 个关键词 × 10~20 条 + 关注 + 推荐 全刷一遍，候选能到 150 条 ——
//   报告里"今天刷了 150 条"owner 看着就头大，扫描越密也越容易招风控。
//   现在：单次默认 6 条，且**全轮累计**超过 cfg.scanLimit（默认 60）就拦住后面的刷取，让模型直接收尾。
const SCAN = { n: 0 }
const scanLimit = () => Math.max(10, Math.min(Number(CFG.scanLimit) || 60, 400))
const scanLeft = () => scanLimit() - SCAN.n
const scanTaken = (k) => { const n = Number(k) || 0; SCAN.n += Math.max(0, n); return SCAN.n }
function budget(a) {
  const left = scanLeft()
  if (left <= 0) {
    return { stop: true, res: safe({ ok: false, error: `本轮的扫描额度用完了（上限 ${scanLimit()} 条）—— 别再刷了，把已经看到的写成报告收尾`, scanned: SCAN.n, limit: scanLimit() }) }
  }
  const want = Number(a?.n) || 6
  return { stop: false, n: Math.max(1, Math.min(want, left)) }
}

async function tFeed(a) {
  const b = budget(a)
  if (b.stop) return b.res
  const d = await dyReady()
  const r = await d.feed(b.n)
  const out = prune(r, b.n)
  scanTaken(out?.items?.length || out?.count)
  return safe(out)
}

async function tSearch(a) {
  const b = budget(a)
  if (b.stop) return b.res
  const d = await dyReady()
  const r = await d.search(String(a?.keyword || ''), b.n)
  const out = prune(r, b.n)
  scanTaken(out?.items?.length || out?.count)
  return safe(out)
}

async function tHot(a) {
  const b = budget(a)
  if (b.stop) return b.res
  const d = await dyReady()
  const r = await d.hot(b.n)
  return safe(r)
}

async function tFollowing(a) {
  const b = budget(a)
  if (b.stop) return b.res
  const d = await dyReady()
  const r = await d.following(b.n)
  const out = prune(r, b.n)
  scanTaken(out?.items?.length || out?.count)
  return safe(out)
}

async function tUserPosts(a) {
  const b = budget(a)
  if (b.stop) return b.res
  const d = await dyReady()
  const r = await d.userPosts(String(a?.secUid || a?.user || ''), b.n)
  const out = prune(r, b.n)
  scanTaken(out?.items?.length || out?.count)
  return safe(out)
}

async function tDetail(a) {
  const d = await dyReady()
  return safe(await d.detail(String(a?.id || '')))
}

/** 截帧 →（可选）OCR →（可选）视觉模型 → 返回**文字** */
async function tFrames(a) {
  const d = await dyReady()
  CFG = readCfg()
  const id = String(a?.id || '')
  const n = Math.max(1, Math.min(Number(a?.n) || CFG.framesPerVideo || 3, 6))
  if (!id) return { ok: false, error: '没给我视频 id' }
  const fr = await d.frames(id, n)
  if (!fr.ok) return { ok: false, error: fr.error || '截帧失败', id }
  const out = { ok: true, id, frames: fr.frames.map((f) => f.file), shots: fr.frames.length }
  if (CFG.useOcr) {
    const o = await ocrFiles(fr.frames.map((f) => f.file), { lang: CFG.visionLang || 'zh-Hans-CN', tmpDir: join(HOME, 'tmp') })
    out.ocrText = o.ok ? o.text : ''
    if (!o.ok) out.ocrError = o.errors?.[0] || o.error || ''
  }
  if (CFG.useVision) {
    const v = await describeFrames(fr.frames.map((f) => f.file), {
      apiBase: CFG.visionApiBase, apiKey: CFG.visionApiKey, model: CFG.visionModel,
      backups: Array.isArray(CFG.visionBackups) ? CFG.visionBackups : [],
    })
    out.visionText = v.ok ? v.text : ''
    if (v.ok) out.visionVia = v.via || ''
    if (!v.ok) out.visionError = v.error || ''
  }
  return safe(out)
}

/** 挑中一条（写进 picks.json，宿主拿它去收藏/评论） */
async function tPick(a) {
  CFG = readCfg()      // 每轮开始都可能被设置页改过，读最新的
  const id = String(a?.id || '')
  if (!id) return { ok: false, error: '没给我视频 id' }
  const f = join(HOME, 'picks.json')
  const all = readJson(f, {})
  const today = dayKey()
  const list = Array.isArray(all[today]) ? all[today] : []
  if (list.some((p) => String(p.id) === id)) return { ok: true, dup: true, today: list.length }
  const perDay = Number(CFG.perDay) || 5
  if (list.length >= perDay) {
    return { ok: false, error: `今天已经挑满 ${perDay} 条了（设置页的「每天最多挑几条」），别再挑了，去写报告` }
  }
  list.push({ id, reason: String(a?.reason || '').slice(0, 200), url: String(a?.url || `https://www.douyin.com/video/${id}`), at: new Date().toISOString() })
  all[today] = list
  writeJson(f, all)
  return { ok: true, today: list.length, perDay }
}

/**
 * 写今天的日报。
 * ⭐ 2026-10-24 修：以前只有"整篇覆盖" —— 模型分批写（先写 2 条、再补 3 条）就把前面的**整段冲掉**。
 *    现在 `mode` 默认 `append`（追加，不丢东西），要整篇重写就显式传 `mode:'overwrite'`。
 *    追加时会自动补一个空行分隔；`overwrite` 会先留一份 `.bak` 上一次的内容，防手滑。
 */
/**
 * ⭐ 2026-10-24：日报尾巴上越堆越多的「这一轮被拦了」说明
 *   —— 同一天被抖音风控拦了 4 轮，就追加了 4 段几乎一样的说明，日报被撑得很丑。
 *   约定：这类说明块**必须以 `<!-- douyin-note -->` 开头**，写到这里时整段替换旧的，只更新时间。
 *   （普通条目不带这个标记，照旧追加，不动。）
 */
const NOTE_MARKERS = ['<!-- douyin-note -->', '<!-- 拦截说明 -->']
function markerIn(text) {
  for (const m of NOTE_MARKERS) if (String(text).includes(m)) return m
  return ''
}
function upsertNoteSection(prev, md) {
  const marker = markerIn(md)
  if (!marker || !prev.includes(marker)) return null
  const idx = prev.indexOf(marker)
  // 说明段之前的内容（去掉尾巴上多余的分隔线/空白）
  const head = prev.slice(0, idx).replace(/\n-{3,}[ \t]*\n?$/, '').replace(/\s*$/, '')
  // 说明段到哪里结束：下一个 `---` 分隔行，或文件末尾
  const rest = prev.slice(idx)
  const cut = rest.match(/\n-{3,}[ \t]*\n/)
  const tailStart = cut ? idx + cut.index + cut[0].length : prev.length
  const tail = prev.slice(tailStart).replace(/^\s+/, '').replace(/\s*$/, '')
  const body = md.trim()
  const merged = head ? `${head}\n\n---\n\n${body}\n` : `${body}\n`
  return tail ? `${merged}\n---\n\n${tail}\n` : merged
}

async function tReport(a) {
  const md = String(a?.md || '')
  if (!md.trim()) return { ok: false, error: '报告是空的' }
  const mode = String(a?.mode || 'append').toLowerCase() === 'overwrite' ? 'overwrite' : 'append'
  const f = join(HOME, 'out', `${dayKey()}.md`)
  try {
    if (mode === 'append' && existsSync(f)) {
      const prev = readFileSync(f, 'utf8')
      // 已经写过的内容不再重复追加（模型重试/同一段写两遍时也不重复）
      if (prev.includes(md.trim().slice(0, 80))) return { ok: true, file: f, mode, dup: true }
      // 「这一轮被拦了」这类说明：当天只留一段，整段覆盖
      const replaced = upsertNoteSection(prev, md)
      if (replaced) {
        writeFileSync(f, replaced, 'utf8')
        return { ok: true, file: f, mode, replaced: true }
      }
      writeFileSync(f, prev.replace(/\s*$/, '') + '\n\n' + md + '\n', 'utf8')
      return { ok: true, file: f, mode }
    }
    if (mode === 'overwrite' && existsSync(f)) {
      try { writeFileSync(f + '.bak', readFileSync(f, 'utf8'), 'utf8') } catch { /* 备份失败不影响正文 */ }
    }
    writeFileSync(f, md, 'utf8')
    return { ok: true, file: f, mode }
  } catch (e) { return { ok: false, error: String(e?.message ?? e) } }
}

/** 看一眼今天的状态 */
async function tStatus() {
  const st = readJson(join(HOME, 'state.json'), {})
  const picks = readJson(join(HOME, 'picks.json'), {})[dayKey()] || []
  const kws = Array.isArray(CFG.keywords) ? CFG.keywords.filter(Boolean) : []
  const urls = Array.isArray(CFG.userUrls) ? CFG.userUrls.filter(Boolean) : []
  return safe({
    ok: true,
    today: dayKey(),
    // ⭐ 值班那一轮没有 shell（也不该为了一行时间戳去调命令 —— 2026-10-24 那轮想用 pwsh 取时间、
    //   结果 pwsh 整个不可用，说明块里只能写"刚才"）。时间从这里拿。
    now: new Date().toISOString(),

    // ⭐ 本轮已刷条数 / 上限：模型据此判断"该收尾了"（2026-10-24 加）
    scanned: SCAN.n,
    scanLimit: scanLimit(),
    pickedToday: Array.isArray(picks) ? picks.length : 0,
    perDay: Number(CFG.perDay) || 5,
    reportExists: existsSync(join(HOME, 'out', `${dayKey()}.md`)),
    sources: CFG.sources || {},
    /** ⭐ 一定要把主人填的关键词带出来：不带出来，那一轮就只能用章程里的默认组，
     *  设置页填的和实际刷的会对不上（2026-10-24 真机踩到的）*/
    keywords: kws,
    userUrls: urls,
    mentionName: String(CFG.mentionName || ''),
    framesPerVideo: Number(CFG.framesPerVideo) || 3,
    useOcr: Boolean(CFG.useOcr),
    useVision: Boolean(CFG.useVision),
    vision: CFG.useVision
      ? { base: String(CFG.visionApiBase || '') ? '已配' : '未配', model: String(CFG.visionModel || '') }
      : '关',
    lastRunAt: st.lastRunAt || '',
  })
}

/** 记"看过了"，避免下一轮又推同一条 */
async function tSeen(a) {
  const ids = Array.isArray(a?.ids) ? a.ids : [a?.id].filter(Boolean)
  if (!ids.length) return { ok: false, error: '没给 id' }
  markSeen(HOME, ids.map(String))
  return { ok: true, count: ids.length }
}

// ─────────────────────────── 对外发言：只能写草稿 ───────────────────────────

/**
 * ⭐ P4：模型**只能写信箱草稿**，不能发。
 *   真发由宿主在轮末（outboxMode=auto）或主人点批准时做 —— 过白名单 + 每日配额。
 *   这样"模型说要发十条"不会发生，也不会把没看过的内容直接发到别人私信里。
 */
async function tDraft(a) {
  CFG = readCfg()
  const kind = String(a?.kind || 'comment').trim()
  if (!OUTBOX_KINDS.includes(kind)) return { ok: false, error: `kind 只认 ${OUTBOX_KINDS.join(' / ')}` }
  const text = String(a?.text || '').trim()
  if (!text) return { ok: false, error: '正文是空的' }
  // comment 必须绑一条真视频，否则发的时候无处可去
  if (kind === 'comment' && !String(a?.videoId || '').trim()) return { ok: false, error: '评论草稿要带 videoId' }
  // 私聊 / 群：白名单为空 ⇒ 直接拒，别攒一堆发不出去的草稿
  if (kind === 'dm' || kind === 'group') {
    if (kind === 'dm' && !CFG.dmEnabled) return { ok: false, error: '私聊开关关着（设置页「对外发言」里打开，且要填白名单）' }
    if (kind === 'group' && !CFG.groupEnabled) return { ok: false, error: '群消息开关关着（设置页「对外发言」里打开，且要填白名单）' }
    const wl = kind === 'dm' ? CFG.dmWhitelist : CFG.groupWhitelist
    if (!hitWhitelist(wl, a?.target)) return { ok: false, error: `目标「${String(a?.target || '')}」不在${kind === 'dm' ? '私聊' : '群'}白名单里` }
  }
  const r = addDraft(HOME, {
    kind,
    target: a?.target,
    videoId: a?.videoId,
    text,
    why: a?.why,
    by: 'model',
  })
  if (!r.ok) return r
  const left = quotaLeft(HOME, dayKey(), kind === 'comment' ? 'comment' : kind, kind === 'comment' ? (Number(CFG.dailyCommentQuota) || 5) : (Number(CFG[kind + 'DailyQuota']) || 1))
  return safe({
    ok: true,
    id: r.item.id,
    kind,
    mode: String(CFG.outboxMode || 'review'),
    note: CFG.outboxMode === 'auto'
      ? `已入队，这一轮结束后宿主会按配额发（今天这类还剩 ${left} 条额度）`
      : `已入队，等主人在设置页点批准才会发（今天这类还剩 ${left} 条额度）`,
  })
}

/** 看自己的待发件箱（只读） */
async function tOutbox(a) {
  CFG = readCfg()
  const status = String(a?.status || 'pending')
  const list = listOutbox(HOME, { status, limit: Number(a?.n) || 20 })
  return safe({
    ok: true,
    mode: String(CFG.outboxMode || 'review'),
    status,
    count: list.length,
    items: list.map((o) => ({ id: o.id, kind: o.kind, target: o.target, videoId: o.videoId, text: o.text, at: o.at, status: o.status, note: o.note })),
  })
}

// ─────────────────────────── 工具清单 ───────────────────────────

const TOOLS = [
  { name: 'douyin_whoami', description: '看抖音那边登录的是谁（没登录就啥也刷不了）。', fn: tWhoami },
  { name: 'douyin_feed', description: '刷一批推荐流视频（开关开着才有必要用）。n 默认 6 —— 一轮总量有上限（设置页「每轮最多扫」），省着点用。', fn: tFeed, params: { n: 'number' } },
  { name: 'douyin_search', description: '按关键词搜一批视频。返回标题/文案/话题/作者/点赞评论收藏数/时长。n 默认 6 —— 一轮总量有上限，5 个关键词就别每个都翻到 20 条。', fn: tSearch, params: { keyword: 'string', n: 'number' } },
  { name: 'douyin_hot', description: '拉今天的抖音热榜词条（看什么在火）。', fn: tHot, params: { n: 'number' } },
  { name: 'douyin_following', description: '看关注的人最近发了什么。n 默认 6（一轮总量有上限）。', fn: tFollowing, params: { n: 'number' } },
  { name: 'douyin_user_posts', description: '看某个博主最近的作品（传 sec_uid 或主页链接都行）。n 默认 6。', fn: tUserPosts, params: { secUid: 'string', n: 'number' } },
  { name: 'douyin_detail', description: '看一条视频的完整信息。', fn: tDetail, params: { id: 'string' } },
  { name: 'douyin_frames', description: '★判断的主力：给这条视频截几帧画面，返回画面里的**文字**（OCR）和**画面描述**（视觉模型）。抖音没有字幕，"画面里写了什么"往往就是它的全部信息。', fn: tFrames, params: { id: 'string', n: 'number' } },
  { name: 'douyin_pick', description: '挑中一条（写进今天的清单）。到「每天最多挑几条」就挑不动了 —— 那是硬闸。', fn: tPick, params: { id: 'string', reason: 'string', url: 'string' } },
  { name: 'douyin_report', description: '把今天的日报写进 out/<日期>.md。默认 **追加**（分批写不会互相覆盖）；要整篇重写就传 mode=overwrite。⭐ 这一轮什么都没取到（被风控/掉登录）时，说明块**第一行必须是 `<!-- douyin-note -->`**：这类说明当天只保留最新一份，工具会整段覆盖旧的，不会越堆越多。', fn: tReport, params: { md: 'string', mode: 'string' } },
  { name: 'douyin_seen', description: '把一批 id 记成"看过了"，下一轮不再推。', fn: tSeen, params: { ids: 'array' } },
  { name: 'douyin_status', description: '看今天挑了几条、额度还剩多少、报告写了没。', fn: tStatus },
  {
    name: 'douyin_draft',
    description: '⭐ 写一条「对外发言」草稿（kind=comment 时必须带 videoId）。**它只是排队，不会真发**：'
      + '主人可以在设置页逐条批准，或开了自动模式后由宿主按白名单+每日配额发。'
      + '私聊(dm)/群(group) 必须先由主人在设置里打开开关并把这些目标写进白名单，否则会被拒。'
      + '别一次写一堆 —— 一天真发出去的就那么几条。',
    fn: tDraft,
    params: { kind: 'string', text: 'string', videoId: 'string', target: 'string', why: 'string' },
  },
  { name: 'douyin_outbox', description: '看自己的待发件箱（只读）：有哪些草稿在排队、批准了没、发成功没。', fn: tOutbox, params: { status: 'string', n: 'number' } },
]

/** 去重 + 限量（别把重复的老视频翻来覆去推给它） */
function prune(r, limit) {
  if (!r?.ok) return r
  const seen = loadSeen(HOME)
  const items = (r.items || []).filter((it) => !seen[String(it.id)])
  return { ok: true, count: items.length, items: items.slice(0, limit) }
}

// ─────────────────────────── JSON-RPC ───────────────────────────

function schemaOf(params = {}) {
  const properties = {}
  const required = []
  for (const [k, t] of Object.entries(params)) {
    properties[k] = t === 'number' ? { type: 'number', description: k }
      : t === 'array' ? { type: 'array', items: { type: 'string' }, description: k }
        : { type: 'string', description: k }
    required.push(k)
  }
  return { type: 'object', properties, required, additionalProperties: false }
}

async function handle(msg) {
  const { id, method, params } = msg || {}
  const send = (result) => writeOut({ jsonrpc: '2.0', id, result })
  const fail = (message) => writeOut({ jsonrpc: '2.0', id, error: { code: -32000, message: String(message).slice(0, 400) } })

  try {
    if (method === 'initialize') {
      return send({ protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'douyin-duty', version: '1.0.0' } })
    }
    if (method === 'notifications/initialized' || String(method || '').startsWith('notifications/')) return
    if (method === 'tools/list') {
      return send({ tools: TOOLS.map((t) => ({ name: t.name, description: t.description, inputSchema: schemaOf(t.params) })) })
    }
    if (method === 'tools/call') {
      const name = String(params?.name || '')
      const tool = TOOLS.find((t) => t.name === name)
      if (!tool) return fail(`没有这个工具：${name}`)
      // 已经被拦住就别再刷了（工具白名单里只有这两个是"不影响账号"的只读查询）
      if (ABORTED && !['douyin_status', 'douyin_seen'].includes(name)) {
        const msg = { ok: false, aborted: true, reason: ABORTED, hint: '这一轮已经被验证/风控拦住了，别再调刷视频的工具；把原因写进报告（douyin_report）然后结束' }
        return send({ content: [{ type: 'text', text: JSON.stringify(msg, null, 1) }], isError: false })
      }
      const args = params?.arguments || {}
      let out
      try {
        out = await tool.fn(args)
      } catch (e) {
        if (e?.name === 'DouyinAbort' || /^ABORT：/.test(String(e?.message || ''))) {
          ABORTED = String(e?.reason || e?.message || '被验证/风控拦住')
          log(`这一轮被中止：${ABORTED}`)
          out = { ok: false, aborted: true, reason: ABORTED, hint: '别继续刷了：把原因写进报告（截图证据在 frames/ 里），这一轮结束' }
        } else throw e
      }
      const text = typeof out === 'string' ? out : JSON.stringify(out, null, 1)
      return send({ content: [{ type: 'text', text }], isError: false })
    }
    if (method === 'ping') return send({})
    return fail(`不认识这个方法：${method}`)
  } catch (e) {
    log(`工具出错 ${method}: ${String(e?.message ?? e)}`)
    return fail(String(e?.message ?? e))
  }
}

function writeOut(obj) {
  try { process.stdout.write(JSON.stringify(obj) + '\n') } catch { /* 管道断了就算了 */ }
}

let buf = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  buf += chunk
  let i
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim()
    buf = buf.slice(i + 1)
    if (!line) continue
    let msg
    try { msg = JSON.parse(line) } catch { continue }
    Promise.resolve(handle(msg)).catch((e) => log(`handle 崩了：${String(e?.message ?? e)}`))
  }
})
process.stdin.on('error', () => { /* 宿主关了管道 */ })

log(`MCP 起来了（home=${HOME}，port=${PORT}，工具 ${TOOLS.length} 个）`)
