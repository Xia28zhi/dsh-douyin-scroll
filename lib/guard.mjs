/**
 * lib/guard.mjs —— 中途"卡住"的中止闸（2026-10-24 新增，P1）
 * ============================================================================
 * 用户的要求（原话）：**"刷的过程中如果弹验证/点了什么东西偏离了，停止刷，
 * 并写出提示，别把 0 条伪装成正常，然后有个提示页，这次不刷了。"**
 *
 * 所以这里只做一件事：**每走一步之前看一眼页面**——
 *   · 出现了验证码 / 安全验证 / 滑块 / 访问频繁 / 账号风险
 *   · 或者网址跳到 passport / verify / captcha / login
 * ⇒ 立刻：截一张图 + 落一份 `abort-<时间>.json`（证据：网址、标题、页面文字片段）
 *         + 抛 `DouyinAbort`，让上层停下来写"没刷成，原因是什么"。
 *
 * 不做什么：**不自动去点验证码**（那是拿用户账号冒险，也可能违反平台规则）。
 * 命中了就停下来等主人处理 —— 这跟"半自动"的规矩一致。
 * ============================================================================
 */
import { evaluate, screenshot } from './cdp.mjs'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export class DouyinAbort extends Error {
  constructor(reason, evidence = {}) {
    super(`ABORT：${reason}`)
    this.name = 'DouyinAbort'
    this.reason = reason
    this.evidence = evidence
  }
}

/** 网址特征（跳到这些地方基本就是被拦了 / 掉登录了） */
const URL_RULES = [
  [/\/verify/i, '跳到了安全验证页'],
  [/captcha/i, '跳出验证码'],
  [/passport/i, '跳到了登录页（多半掉登录了）'],
  [/\/login/i, '跳到了登录页（多半掉登录了）'],
]
/** 页面文字特征（抖音的风控提示语） */
const TEXT_RULES = [
  [/访问频繁/, '提示"访问频繁"'],
  [/操作过频|操作频繁/, '提示"操作过频"'],
  [/请完成(安全)?验证|安全验证/, '要求做安全验证'],
  [/拖[动拽]?滑块|滑块验证/, '要求拖滑块验证'],
  [/请输入?验证码/, '要求输入验证码'],
  [/账号(存在|异常)风险/, '提示账号风险'],
  [/网络请求异常/, '提示网络请求异常'],
]

export function inspect(snap = {}) {
  const url = String(snap.url || '')
  const text = String(snap.text || '')
  for (const [re, why] of URL_RULES) if (re.test(url)) return { reason: why, matched: String(re), kind: 'url' }
  for (const [re, why] of TEXT_RULES) if (re.test(text)) return { reason: why, matched: String(re), kind: 'text' }
  return null
}

/** 抓一眼当前页面 */
export async function snapshot(cdp, timeout = 10_000) {
  const expr = `(() => ({
    url: String(location.href || ''),
    title: String(document.title || ''),
    text: String((document.body && document.body.innerText) || '').slice(0, 4000),
  }))()`
  return await evaluate(cdp, expr, timeout)
}

/**
 * 检查一次；命中就存证并返回 { ok:false }，没命中返回 { ok:true }
 * @param {{cdp:object}} page 页面级 CDP
 * @param {{dir?:string, log?:Function, phase?:string}} opts
 */
export async function check(page, { dir = '', log = () => {}, phase = '' } = {}) {
  let snap
  try { snap = await snapshot(page.cdp) } catch { return { ok: true, skipped: true } }
  const hit = inspect(snap)
  if (!hit) return { ok: true, url: snap.url }
  const rec = {
    at: new Date().toISOString(),
    phase,
    reason: hit.reason,
    matched: hit.matched,
    url: String(snap.url || ''),
    title: String(snap.title || ''),
    text: String(snap.text || '').slice(0, 1500),
    shot: '',
  }
  if (dir) {
    try {
      mkdirSync(join(dir, 'frames'), { recursive: true })
      const stamp = rec.at.replace(/[:.]/g, '-')
      try {
        const b64 = await screenshot(page.cdp)
        if (b64) {
          const file = join(dir, 'frames', `abort-${stamp}.png`)
          writeFileSync(file, Buffer.from(b64, 'base64'))
          rec.shot = file
        }
      } catch { /* 截不到图也要留下文字证据 */ }
      writeFileSync(join(dir, `abort-${stamp}.json`), JSON.stringify(rec, null, 2), 'utf8')
      writeFileSync(join(dir, 'abort-latest.json'), JSON.stringify(rec, null, 2), 'utf8')
    } catch (e) { log(`中止存证没写成：${e?.message ?? e}`) }
  }
  log(`⚠ 中止这一轮：${hit.reason}（${rec.url}）${rec.shot ? '，截图：' + rec.shot : ''}`)
  return { ok: false, hit, rec }
}

/** 命中就抛（上层 catch 后写"这轮没刷成"的报告） */
export function throwIfHit(res) {
  if (res && res.ok === false) throw new DouyinAbort(res.hit.reason, res.rec)
  return res
}
