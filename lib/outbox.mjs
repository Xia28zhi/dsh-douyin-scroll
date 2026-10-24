/**
 * lib/outbox.mjs —— **对外发言的待发件箱**（评论 @ / 私聊 / 群）
 * ============================================================================
 * 🔴 为什么要有这一层（P4 的安全底线）：
 *   1. **模型永远不能直接发** —— MCP 工具白名单里只有「写草稿」，没有「发送」；
 *   2. 每条发言先落 `outbox.jsonl`，默认 `outboxMode='review'`（半自动）：
 *      轮末只入队，**等你（主人）在设置页点批准**，宿主才按配额去发；
 *   3. 私聊 / 群 **默认全关**，且白名单为空时**一律不发**（宁可不动，也不乱发给人）；
 *   4. 每天有硬配额（`dailyCommentQuota` / `dmDailyQuota` / `groupDailyQuota`），
 *      配额按「今天真的发出去的条数」算，不按草稿数算；
 *   5. 每条都有 `status` + `note`，发失败不吞，写清楚原因。
 *
 * ⚠️ 这一版里**私聊 / 群只入队、不自动发送**：抖音私信页的 DOM 还没在真机上核对过，
 *    硬写一个没测过的点击链比不发更糟。等实机核过再打开 `outboxMode='auto'`。
 * ============================================================================
 */
import { readFileSync, writeFileSync, existsSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'

const KINDS = ['comment', 'dm', 'group']
export const OUTBOX_KINDS = KINDS

function fileOf(home) { return join(home, 'outbox.jsonl') }

/** 读全部（一行一条；坏行跳过，不炸） */
export function readOutbox(home) {
  const f = fileOf(home)
  if (!existsSync(f)) return []
  const out = []
  for (const line of readFileSync(f, 'utf8').split(/\r?\n/)) {
    const s = line.trim()
    if (!s) continue
    try { const o = JSON.parse(s); if (o && o.id) out.push(o) } catch { /* 坏行跳过 */ }
  }
  return out
}

/** 整文件重写（原子）：条数不多（一天几十条），简单可靠 */
function writeOutbox(home, list) {
  const f = fileOf(home)
  const tmp = f + '.tmp'
  writeFileSync(tmp, list.map((o) => JSON.stringify(o)).join('\n') + '\n', 'utf8')
  renameSync(tmp, f)
}

/** 追加一条草稿（不重写整个文件，快） */export function addDraft(home, { kind, target = '', videoId = '', text = '', why = '', by = 'model' }) {
  const k = String(kind || '').trim()
  if (!KINDS.includes(k)) return { ok: false, error: `kind 只认 ${KINDS.join(' / ')}` }
  const t = String(text || '').trim()
  if (!t) return { ok: false, error: '正文是空的' }
  if (t.length > 300) return { ok: false, error: '正文太长（>300 字），收一收' }
  const item = {
    id: 'ob_' + Date.now().toString(36) + '_' + randomBytes(3).toString('hex'),
    at: new Date().toISOString(),
    kind: k,
    target: String(target || '').trim().slice(0, 80),
    videoId: String(videoId || '').trim(),
    text: t,
    why: String(why || '').trim().slice(0, 200),
    by: String(by || 'model'),
    status: 'pending',
    note: '',
  }
  const f = fileOf(home)
  const line = JSON.stringify(item) + '\n'
  try {
    writeFileSync(f, line, { encoding: 'utf8', flag: 'a' })
    return { ok: true, item }
  } catch (e) {
    return { ok: false, error: String(e?.message ?? e) }
  }
}

/** 改状态（approve / reject / sent / failed） */
/**
 * 记一条「已经发出去了」的账（不经过草稿流程的那些也要记，否则配额统计永远归零）。
 * 2026-10-24 真机发现：走 `autoComment + mentionName` 兜底路径发的评论**不进 outbox**，
 * 于是 `sentToday` 一直是 0 —— 日志里明明「评论已发 4 条」，收尾却写「今日评论已发 0 条」，
 * 配额等于没有。这里就是补那一笔。
 */
export function recordSent(home, { kind, target = '', videoId = '', text = '', why = '', note = '' }) {
  const k = String(kind || '').trim()
  if (!KINDS.includes(k)) return { ok: false, error: `kind 只认 ${KINDS.join(' / ')}` }
  const item = {
    id: 'ob_' + Date.now().toString(36) + '_' + randomBytes(3).toString('hex'),
    at: new Date().toISOString(),
    kind: k,
    target: String(target || '').trim().slice(0, 80),
    videoId: String(videoId || '').trim(),
    text: String(text || '').trim().slice(0, 300),
    why: String(why || '').trim().slice(0, 200),
    by: 'host',
    status: 'sent',
    note: String(note || '').slice(0, 200),
  }
  try {
    writeFileSync(fileOf(home), JSON.stringify(item) + '\n', { encoding: 'utf8', flag: 'a' })
    return { ok: true, item }
  } catch (e) {
    return { ok: false, error: String(e?.message ?? e) }
  }
}

export function setStatus(home, id, status, note = '') {
  const all = readOutbox(home)
  let hit = null
  for (const o of all) {
    if (o.id !== id) continue
    o.status = String(status)
    o.note = String(note || '').slice(0, 200)
    o.touchedAt = new Date().toISOString()
    hit = o
  }
  if (!hit) return { ok: false, error: '没有这条' }
  try { writeOutbox(home, all) } catch (e) { return { ok: false, error: String(e?.message ?? e) } }
  return { ok: true, item: hit }
}

/** 列表（默认只给最近 50 条；可按状态/日期过滤） */
export function listOutbox(home, { status = '', day = '', limit = 50 } = {}) {
  let list = readOutbox(home)
  if (status) list = list.filter((o) => o.status === status)
  if (day) list = list.filter((o) => String(o.at || '').startsWith(day))
  return list.slice(-Math.max(1, Math.min(Number(limit) || 50, 200))).reverse()
}

/** 今天真正发出去的条数（配额按这个算） */
export function sentToday(home, day, kind) {
  return readOutbox(home).filter((o) => o.status === 'sent' && String(o.at || '').startsWith(day) && (!kind || o.kind === kind)).length
}

/** 白名单命中：空名单 ⇒ 不命中（私聊/群一律不发）；`*` ⇒ 全放行 */
export function hitWhitelist(whitelist, target) {
  const t = String(target || '').trim().toLowerCase()
  const wl = (Array.isArray(whitelist) ? whitelist : []).map((s) => String(s || '').trim().toLowerCase()).filter(Boolean)
  if (!wl.length) return false
  if (!t) return false
  return wl.some((w) => w === '*' || t === w || t.includes(w))
}

/** 配额里还剩几条 */
export function quotaLeft(home, day, kind, quota) {
  const q = Math.max(0, Math.min(Number(quota) || 0, 50))
  return Math.max(0, q - sentToday(home, day, kind))
}
