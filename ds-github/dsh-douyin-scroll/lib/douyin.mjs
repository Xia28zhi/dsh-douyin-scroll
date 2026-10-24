/**
 * lib/douyin.mjs —— 抖音数据层（**本插件的地基**）
 * ============================================================================
 * 🔴 关键发现（本机实测 2026-10-23，写在最前面，免得后人再试一遍错路）：
 *   抖音的 web 接口**不用自己签名**。只要在**已登录的页面上下文**里 `fetch` 同源接口
 *   （cookie 里带 sessionid / ttwid），服务端就认 —— 实测 `search/item`、`tab/feed`、
 *   `aweme/post`、`aweme/detail`、`user/profile/self` 全部 `status_code=0` 正常返回 ✓。
 *   ⇒ 我们**不需要**去逆向 a_bogus / X-Bogus、也不需要 playwright。
 *   ⇒ 唯一的前提：**浏览器里得是登录态**（设置页点一次「登录抖音」即可，长期有效）。
 *
 * 另一条规矩：**给模型看的东西必须先瘦身**。
 *   一个 aweme 原始对象几十 KB，直接丢给模型会把 token 烧光 ⇒
 *   在**页面里**就把它压成下面这个精简结构（normalize），只留判断用得上的字段。
 * ============================================================================
 */
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { check as guardCheck, throwIfHit, DouyinAbort } from './guard.mjs'

export { DouyinAbort }

const BASE = 'device_platform=webapp&aid=6383&channel=channel_pc_web'

/** 页面里执行的归一化函数（字符串注入）—— 把 aweme 对象压成精简结构 */
const NORMALIZE = `(a) => {
  if (!a) return null;
  const s = a.statistics || {};
  const au = a.author || {};
  const v = a.video || {};
  const cover = (v.cover?.url_list || v.origin_cover?.url_list || [])[0] || '';
  const dur = Number(v.duration || a.duration || 0) / 1000;
  const tags = [];
  for (const t of (a.text_extra || [])) { if (t && t.hashtag_name) tags.push(t.hashtag_name); }
  if (a.text_extra) for (const t of (a.text_extra || [])) { if (t && t.user_id) tags.push('@' + (t.user_unique_id || t.user_id)); }
  const ct = Number(a.create_time || 0);
  return {
    id: String(a.aweme_id || ''),
    desc: String(a.desc || '').slice(0, 500),
    author: { name: String(au.nickname || ''), secUid: String(au.sec_uid || ''), uid: String(au.uid || '') },
    stats: { like: s.digg_count|0, comment: s.comment_count|0, fav: s.collect_count|0, share: s.share_count|0, play: s.play_count|0 },
    durationSec: Math.round(dur),
    createdAt: ct ? new Date(ct * 1000).toISOString() : '',
    tags,
    cover,
    url: 'https://www.douyin.com/video/' + String(a.aweme_id || ''),
    isAd: Boolean(a.is_ads || a.is_top || (a.rawdata && a.rawdata.is_ad)),
  };
}`

/** 搜索结果有两种形状：直接 aweme，或包一层 aweme_info */
const NORMALIZE_SEARCH = `(item) => {
  if (!item) return null;
  const a = item.aweme_info || item.aweme || item;
  const n = (${NORMALIZE})(a);
  if (n && item.type !== undefined) n.searchType = item.type;
  return n;
}`

export class Douyin {
  /**
   * @param {BrowserSession} session
   * @param {{log?:Function, dir?:string}} opts
   */
  constructor(session, { log = () => {}, dir = '' } = {}) {
    this.session = session
    this.log = log
    this.dir = dir
    this._page = null       // 常驻的"API 上下文"标签（douyin.com 页面）
  }

  /** 拿到（或新建）一个 douyin.com 的常驻标签 —— 所有接口都在这个上下文里 fetch */
  async ctxPage() {
    if (this._page && this._page.cdp) {
      try { await this._page.cdp.send('Runtime.evaluate', { expression: 'location.origin' }, 5000); return this._page } catch { this._page = null }
    }
    const t = await this.session.tab('https://www.douyin.com/')
    await t.cdp.send('Page.enable')
    await t.cdp.send('Runtime.enable')
    this._page = t
    // 等首屏就绪（cookie / sdk 要就位）
    await new Promise((r) => setTimeout(r, 3500))
    return t
  }

  /** 在页面上下文里 GET 一个接口，返回解析后的 JSON */
  async api(path, { timeout = 30_000 } = {}) {
    const page = await this.ctxPage()
    // ⭐ 每一步之前先看页面：遇到验证码/掉登录/风控提示 ⇒ 抛 DouyinAbort，上层停下来写"没刷成"
    throwIfHit(await guardCheck(page, { dir: this.dir, log: this.log, phase: 'api ' + String(path).slice(0, 40) }))
    const { cdp } = page
    const expr = `fetch(${JSON.stringify(path)}, { credentials: 'include', headers: { accept: 'application/json' } })
      .then(r => r.text()).catch(e => 'ERR:' + e.message)`
    const raw = await cdp.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }, timeout)
    const txt = String(raw?.result?.value ?? '')
    if (txt.startsWith('ERR:')) throw new Error(txt.slice(4))
    try { return JSON.parse(txt) } catch { return { __raw: txt.slice(0, 500), status_code: -1 } }
  }

  /**
   * ⭐ 取一批数据：**转换全在页面里做**，node 只收结果（一个 aweme 原始对象几十 KB，
   *    全传回来既慢又会把模型的 token 烧光）。
   */
  async listAll(path, { kind = 'aweme', limit = 20 } = {}) {
    const page = await this.ctxPage()
    throwIfHit(await guardCheck(page, { dir: this.dir, log: this.log, phase: 'listAll ' + String(path).slice(0, 40) }))
    const { cdp } = page
    const expr = `(async () => {
      const r = await fetch(${JSON.stringify(path)}, { credentials: 'include', headers: { accept: 'application/json' } });
      const txt = await r.text();
      let j; try { j = JSON.parse(txt) } catch (e) { return { ok:false, msg:'非JSON', raw: txt.slice(0,300) } }
      if (j.status_code !== undefined && j.status_code !== 0) return { ok:false, status: j.status_code, msg: j.status_msg || '' };
      let arr = ${kind === 'search' ? `(j.data || j.aweme_list || [])` : `(j.aweme_list || j.data || [])`};
      if (!Array.isArray(arr)) arr = [];
      const NORM = ${NORMALIZE};
      const out = [];
      for (const it of arr) {
        const a = (it && (it.aweme_info || it.aweme)) || it;
        const n = NORM(a);
        if (n && n.id) out.push(n);
        if (out.length >= ${Number(limit) || 20}) break;
      }
      return { ok: true, count: out.length, items: out };
    })()`
    const r = await cdp.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }, 40_000)
    if (r?.exceptionDetails) throw new Error(String(r.exceptionDetails.text || '页面里执行失败').slice(0, 200))
    return r?.result?.value || { ok: false, msg: '没拿到结果' }
  }

  // ─────────────────────────── 具体场景 ───────────────────────────

  /** 我是谁（登录检查）：能拿到自己 = 登录着 */
  async whoami() {
    const j = await this.api(`/aweme/v1/web/user/profile/self/?${BASE}`)
    const u = j?.user
    if (j?.status_code === 0 && u) {
      return {
        ok: true, loggedIn: true,
        name: String(u.nickname || ''),
        uid: String(u.uid || ''),
        secUid: String(u.sec_uid || ''),
        followers: Number(u.follower_count || 0),
        following: Number(u.following_count || 0),
      }
    }
    return { ok: true, loggedIn: false, status: j?.status_code, msg: j?.status_msg || '没登录（去设置页点「登录抖音」）' }
  }

  /**
   * 翻页凑数：tab/feed 一次只给 2–8 条（实测），想要 10 条就得连着要几轮
   * ⚠️ 轮与轮之间留 800ms —— 别把接口当靶子打（也免得触发风控）
   */
  async _collect(makePath, n, rounds = 3) {
    const want = Math.max(1, Math.min(Number(n) || 10, 30))
    const items = []
    const seen = new Set()
    let lastErr = null
    for (let i = 0; i < rounds && items.length < want; i++) {
      const r = await this.listAll(makePath(want), { limit: want })
      if (!r?.ok) { lastErr = r; break }
      for (const it of r.items || []) {
        if (seen.has(it.id)) continue
        seen.add(it.id)
        items.push(it)
      }
      if (items.length < want) await new Promise((res) => setTimeout(res, 800))
    }
    if (!items.length && lastErr) return lastErr
    return { ok: items.length > 0, count: items.length, items: items.slice(0, want) }
  }

  /** 推荐流（主人没选这路，开关留着，想开随时能开） */
  async feed(n = 10) {
    const c = Math.max(1, Math.min(Number(n) || 10, 30))
    return this._collect((want) => `/aweme/v1/web/tab/feed/?${BASE}&count=${want}`, c)
  }

  /** 关键词搜索 */
  async search(keyword, n = 10) {
    const kw = encodeURIComponent(String(keyword || '').slice(0, 60))
    if (!kw) return { ok: false, msg: '关键词是空的' }
    return this.listAll(`/aweme/v1/web/search/item/?${BASE}&keyword=${kw}&count=${Math.max(1, Math.min(Number(n) || 10, 30))}&offset=0`, { kind: 'search', limit: n })
  }

  /** 热榜词条（不带视频，只是"今天什么在火"） */
  async hot(n = 20) {
    const j = await this.api(`/aweme/v1/web/hot/search/list/?${BASE}&detail_list=1`)
    const d = j?.data
    const list = Array.isArray(d) ? d : (d?.word_list || [])
    const out = []
    for (const w of list) {
      out.push({
        word: String(w.word || w.query || ''),
        hot: Number(w.hot_value || w.hot_score || 0),
        label: String(w.sentence_tag || w.label || ''),
        url: 'https://www.douyin.com/search/' + encodeURIComponent(String(w.word || w.query || '')),
      })
      if (out.length >= (Number(n) || 20)) break
    }
    return { ok: true, count: out.length, items: out }
  }

  /** 热榜上的视频（挑前几个词各搜一下，省得一条条翻） */
  async hotVideos(words = 3, n = 6) {
    const h = await this.hot(words)
    const items = []
    for (const w of h.items || []) {
      const s = await this.search(w.word, Math.max(2, Math.ceil((Number(n) || 6) / Math.max(1, words))))
      for (const it of s.items || []) { it.fromHot = w.word; items.push(it) }
      if (items.length >= n) break
    }
    return { ok: true, count: items.length, items: items.slice(0, n) }
  }

  /** 关注流（你关注的博主最近发了什么） */
  async following(n = 10) {
    const c = Math.max(1, Math.min(Number(n) || 10, 30))
    return this._collect((want) => `/aweme/v1/web/follow/feed/?${BASE}&count=${want}`, c)
  }

  /** 某个博主的作品（传 sec_uid 或主页链接都行） */
  async userPosts(secUid, n = 10) {
    let su = String(secUid || '').trim()
    const m = su.match(/\/user\/([A-Za-z0-9_\-]+)/)
    if (m) su = m[1]
    if (!su) return { ok: false, msg: '没给我 sec_uid 或主页链接' }
    return this.listAll(`/aweme/v1/web/aweme/post/?${BASE}&sec_user_id=${encodeURIComponent(su)}&count=${Math.max(1, Math.min(Number(n) || 10, 30))}&max_cursor=0&publish_video_strategy_type=2`, { limit: n })
  }

  /** 单条详情（补字段 / 确认还在） */
  async detail(id) {
    const j = await this.api(`/aweme/v1/web/aweme/detail/?${BASE}&aweme_id=${encodeURIComponent(String(id || ''))}`)
    const a = j?.aweme_detail
    if (!a) return { ok: false, msg: j?.status_msg || '没拿到这条' }
    // 复用归一化：直接在页面里转一次
    const { cdp } = await this.ctxPage()
    const r = await cdp.send('Runtime.evaluate', {
      expression: `(${NORMALIZE})(${JSON.stringify(a).replace(/</g, '\\u003c')})`,
      returnByValue: true,
    }, 20_000)
    return { ok: true, item: r?.result?.value || null }
  }

  /**
   * 截帧：开视频详情页 → 播 → 在 1/(n+1)…n/(n+1) 处各截一张
   * @returns {{ok:boolean, frames:string[], error?:string}}
   */
  async frames(id, n = 3, { dir } = {}) {
    const outDir = dir || join(this.dir || '.', 'frames')
    const shots = []
    let tab = null
    try {
      tab = await this.session.tab(`https://www.douyin.com/video/${encodeURIComponent(String(id))}`)
      const { cdp } = tab
      await cdp.send('Page.enable')
      // 等 video 就绪（最多 12 秒）
      let ok = false
      for (let i = 0; i < 24; i++) {
        await new Promise((r) => setTimeout(r, 500))
        const st = await cdp.send('Runtime.evaluate', {
          expression: `(() => { const v = document.querySelector('video'); return v ? { ready: v.readyState, dur: v.duration || 0, w: v.getBoundingClientRect().width|0, h: v.getBoundingClientRect().height|0 } : null })()`,
          returnByValue: true,
        }, 10_000).catch(() => ({ result: { value: null } }))
        const s = st?.result?.value
        if (s && s.ready >= 2 && s.w > 40) { ok = true; break }
      }
      if (!ok) {
        // ⭐ P1：等不到视频时先看一眼是不是被"验证 / 掉登录"拦了 —— 那是中止，不是"视频下架"
        const g = await guardCheck(tab, { dir: this.dir, log: this.log, phase: 'frames ' + id })
        if (g.ok === false) return { ok: false, aborted: true, error: `中止：${g.hit.reason}` }
        return { ok: false, error: '这个页面里没等到可播放的视频（可能已下架 or 要登录）' }
      }
      // 播之前再看一眼，别在验证页上截出一堆白屏
      throwIfHit(await guardCheck(tab, { dir: this.dir, log: this.log, phase: 'frames ' + id }))

      // 暂停自动播放 + 去掉音量，然后逐点 seek 截图
      const count = Math.max(1, Math.min(Number(n) || 3, 6))
      for (let i = 1; i <= count; i++) {
        const at = i / (count + 1)
        // ⭐ 2026-10-23 实机：`awaitPromise` 等 seeked 会偶发 **"Promise was collected"**
        //    （CDP 里那个 promise 没被引用、被 V8 回收；页面一跳转/重渲染就更容易触发）
        //    ⇒ ① 把 promise 挂到 window 上保活；② 就算它还是被收了，也**退化成"等一会儿再截"**，
        //       绝不因为一次 GC 让整帧全丢 ✗
        let seeked = null
        try {
          seeked = await cdp.send('Runtime.evaluate', {
            expression: `(() => {
              window.__dySeek = new Promise((res) => {
                const v = document.querySelector('video');
                if (!v) return res(false);
                try { v.pause(); } catch (e) {}
                const t = Math.max(0.05, (v.duration || 3) * ${at});
                let done = false;
                const fin = () => { if (!done) { done = true; res(true) } };
                v.addEventListener('seeked', fin, { once: true });
                setTimeout(fin, 2500);
                try { v.currentTime = t } catch (e) { setTimeout(fin, 10) }
              });
              return window.__dySeek;
            })()`,
            returnByValue: true, awaitPromise: true,
          }, 12_000)
        } catch (e) {
          // 被回收 / 超时都无所谓：直接等一下继续截
        }
        if (seeked?.result?.value === false) continue
        await new Promise((r) => setTimeout(r, (seeked?.result?.value ? 400 : 1500)))   // 等画面刷出来

        const rect = await cdp.send('Runtime.evaluate', {
          expression: `(() => { const v=document.querySelector('video'); const r=v.getBoundingClientRect();
            return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) } })()`,
          returnByValue: true,
        }, 10_000)
        const r = rect?.result?.value
        if (!r || r.w < 20) continue
        // ⭐ 裁掉边缘 8%：抖音播放器会在底部/角上压"循环播放""静音"这类浮层
        const pad = (v) => Math.round(v * 0.08)
        const clip = {
          x: r.x + pad(r.w), y: r.y + pad(r.h),
          width: Math.max(20, r.w - pad(r.w) * 2), height: Math.max(20, r.h - pad(r.h) * 2),
          scale: 1,   // ⭐ 必须带：CDP 缺了它直接回 "Invalid parameters"
        }
        const shot = await cdp.send('Page.captureScreenshot', { format: 'png', clip }, 20_000)
        if (shot?.data) {
          const file = join(outDir, `${String(id)}_${i}.png`)
          try {
            writeFileSync(file, Buffer.from(shot.data, 'base64'))
            shots.push({ file, at: Math.round(at * 100) / 100 })
          } catch (e) { /* 写不进去就跳过这张 */ }
        }
      }
      return { ok: shots.length > 0, frames: shots, error: shots.length ? '' : '一帧都没截下来' }
    } catch (e) {
      return { ok: false, error: String(e?.message ?? e) }
    } finally {
      if (tab) { try { await this.session.close(tab.target.id) } catch { /* 关不掉就算了 */ } }
    }
  }
}
