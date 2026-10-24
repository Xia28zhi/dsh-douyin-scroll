/**
 * lib/vision.mjs —— 画面截帧 → **视觉模型** → 一句人话（P3：支持 2–3 个待选位 + 自动降级）
 * ============================================================================
 * ⭐ 为什么这一层必须由**宿主**做，不能让那一轮的模型自己看图：
 *   DSH 默认模型是 `deepseek-flash`，**纯文本、看不了图**。所以"看图"这件事
 *   只能由插件在宿主侧调一个**多模态接口**，把画面**翻译成文字**再交给它判断。
 *   ⇒ 那一轮的模型拿到的始终是文字，模型换谁来都跑得动 ✓
 *
 * 🆕 P3：一个视觉接口挂了（欠费/401/超时/模型改名）不该让整轮瞎掉。
 *   候选顺序：主（设置页 apiBase/apiKey/model）→ `visionBackups` 里逐行 `接口 | 模型 | 密钥`。
 *   第一个成功的就用它，并把「这轮用的是第几个」记进日志；全挂才报错，且把每家的失败原因都列出来。
 * ============================================================================
 */
import { readFileSync } from 'node:fs'

const PROMPT = `这是抖音视频里的几帧画面（同一条视频的不同时间点）。请用中文回答三件事，控制在 120 字以内：
1) 画面里**实际发生了什么**（人/物/场景/动作）；
2) 画面里的**关键文字**（标题、字幕、PPT、商品名等，没有就写"无"）；
3) 这是一条什么类型的视频（口播/教程/剧情/图文/广告/直播切片/其他）。
不要评论好坏，只描述看到的事实。`

const trimEnd = (s) => String(s || '').trim().replace(/\/+$/, '')

/**
 * 解析一条备用视觉配置：`接口 | 模型 | 密钥`（也容忍逗号/制表符分隔）
 * @returns {{base:string, model:string, key:string}|null}
 */
export function parseBackup(line) {
  const parts = String(line || '').split(/\s*[|｜\t]\s*|\s*,\s*(?=https?:)/).map((s) => s.trim()).filter(Boolean)
  if (parts.length < 3) return null
  const [base, model, key] = parts
  if (!/^https?:\/\//i.test(base)) return null
  return { base: trimEnd(base), model, key }
}

/** 候选列表：[主, 备1, 备2…]（缺 key/model 的跳过） */
export function candidates(cfg = {}) {
  const list = []
  const base = trimEnd(cfg.apiBase)
  const key = String(cfg.apiKey || '').trim()
  const model = String(cfg.model || '').trim()
  if (base && key && model) list.push({ label: '主', base, key, model })
  const backups = Array.isArray(cfg.backups) ? cfg.backups : []
  backups.slice(0, 2).forEach((line, i) => {
    const p = parseBackup(line)
    if (p) list.push({ label: `备${i + 1}`, ...p })
  })
  return list
}

/**
 * 有些模型（如 GLM-5.3-Flash）会先写一大段 reasoning_content，max_tokens 给小了正文会被挤空：
 * 实测 500 → content 空、reasoning 2005 字；3000 → 正常出正文。
 * 所以 3000 起步，正文空但有 reasoning 就加倍到 6000 再试一次。
 */
async function askOnce(cand, content, maxTokens) {
  const res = await fetch(cand.base + '/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + cand.key },
    body: JSON.stringify({
      model: cand.model,
      messages: [{ role: 'user', content }],
      max_tokens: maxTokens,
      temperature: 0.2,
    }),
    signal: AbortSignal.timeout(90_000),
  })
  if (!res.ok) {
    let t = ''
    try { t = (await res.text()).slice(0, 120) } catch { /* 读不出正文就算了 */ }
    return { ok: false, hard: true, error: `HTTP ${res.status}${t ? ' ' + t : ''}` }
  }
  const j = await res.json()
  const msg = j?.choices?.[0]?.message || {}
  const text = String(msg.content || '').trim()
  const reasoning = String(msg.reasoning_content || '').trim()
  return { ok: text.length > 0, text, reasoning, finish: String(j?.choices?.[0]?.finish_reason || '') }
}

/** 依次试每个候选；返回第一个成功的 */
async function tryCandidates(cands, content) {
  const fails = []
  for (const c of cands) {
    try {
      let r = await askOnce(c, content, 3000)
      if (!r.hard && !r.ok && r.reasoning) r = await askOnce(c, content, 6000)
      if (r.ok) return { ok: true, text: r.text.slice(0, 1500), via: c.label, fails }
      fails.push(`${c.label}(${c.model})：${r.hard ? r.error : r.reasoning ? `只回了推理（finish=${r.finish}）` : '没回文字'}`)
    } catch (e) {
      fails.push(`${c.label}(${c.model})：${String(e?.message ?? e).slice(0, 80)}`)
    }
  }
  return { ok: false, text: '', via: '', fails }
}

/**
 * @param {string[]} files 截帧文件（本地路径）
 * @param {{apiBase:string, apiKey:string, model:string, backups?:string[], prompt?:string}} cfg
 * @returns {Promise<{ok:boolean, text:string, via?:string, error?:string, fails?:string[]}>}
 */
export async function describeFrames(files, cfg = {}) {
  const cands = candidates(cfg)
  if (!cands.length) return { ok: false, text: '', error: '没配视觉模型（设置页里填 apiBase / apiKey / model）' }
  if (!files?.length) return { ok: false, text: '', error: '没有可看的画面' }

  const content = [{ type: 'text', text: String(cfg.prompt || PROMPT) }]
  let n = 0
  for (const f of files.slice(0, 6)) {
    try {
      const b64 = readFileSync(f).toString('base64')
      content.push({ type: 'image_url', image_url: { url: `data:image/png;base64,${b64}` } })
      n++
    } catch { /* 这张读不了就看下一张 */ }
  }
  if (!n) return { ok: false, text: '', error: '一张图都没读出来' }

  const r = await tryCandidates(cands, content)
  if (r.ok) return { ok: true, text: r.text, via: r.via, error: '', fails: r.fails }
  return { ok: false, text: '', error: '视觉接口全挂了：' + r.fails.join('；'), fails: r.fails }
}

/** 探一下每个候选通不通（设置页「测视觉」用；只验鉴权/模型名，不验看图能力） */
export async function probeVision(cfg = {}) {
  const cands = candidates(cfg)
  if (!cands.length) return { ok: false, steps: [{ name: '配置', ok: false, msg: '没配视觉模型' }] }
  const steps = []
  for (const c of cands) {
    try {
      const res = await fetch(c.base + '/chat/completions', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: 'Bearer ' + c.key },
        body: JSON.stringify({ model: c.model, messages: [{ role: 'user', content: '回一个字：好' }], max_tokens: 64 }),
        signal: AbortSignal.timeout(30_000),
      })
      const t = await res.text()
      steps.push({
        name: c.label,
        ok: res.ok,
        msg: `${c.model} · HTTP ${res.status}` + (res.ok ? '' : ' · ' + t.slice(0, 90)),
      })
    } catch (e) {
      steps.push({ name: c.label, ok: false, msg: `${c.model} · ${String(e?.message ?? e).slice(0, 90)}` })
    }
  }
  return { ok: steps.some((s) => s.ok), steps }
}
