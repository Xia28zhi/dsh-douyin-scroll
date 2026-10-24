/**
 * tools/selftest.mjs —— 脱离 dsh 的自测（**不装插件也能验**）
 * 用法：node tools/selftest.mjs
 * 会：起浏览器 → 查登录 → 挨个跑接口 → 截一帧 → 打印结论
 */
import { BrowserSession } from '../lib/browser.mjs'
import { Douyin } from '../lib/douyin.mjs'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'

const HOME = process.env.DOUYIN_DUTY_HOME || join(homedir(), '.dsh', 'douyin-duty')
mkdirSync(join(HOME, 'frames'), { recursive: true })

const log = (...a) => console.log('[selftest]', ...a)
const line = (t) => console.log('\n──── ' + t + ' ────')

async function main() {
  setTimeout(() => { log('硬超时，收工'); process.exit(0) }, 115_000).unref?.()

  const session = new BrowserSession({ dir: HOME, port: 9333, log })
  const dy = new Douyin(session, { log, dir: HOME })

  line('浏览器')
  const started = await session.start()
  log('已就绪（复用 =', !!started.reused, '）| profile 有 cookie:', session.hasProfile)

  line('登录态')
  const me = await dy.whoami()
  log(JSON.stringify(me))
  if (!me.loggedIn) { log('⚠️ 没登录 —— 后面的接口多半拿不到数据（设置页点「登录抖音」即可）') }

  const show = (name, r) => {
    if (!r?.ok) { log(`${name}: ✗ ${r?.msg || r?.error || '失败'}`, r?.raw ? '| raw:' + String(r.raw).slice(0, 120) : ''); return null }
    log(`${name}: ✓ ${r.count ?? 1} 条`)
    const first = r.items?.[0] || r.item
    if (first) log('   首条:', JSON.stringify({
      desc: String(first.desc || first.word || '').slice(0, 40),
      author: first.author?.name || '', like: first.stats?.like, dur: first.durationSec, hot: first.hot,
    }))
    return r
  }

  line('接口')
  const feed = show('推荐流', await dy.feed(6))
  const sr = show('搜索「编程」', await dy.search('编程', 5))
  show('热榜', await dy.hot(8))
  show('关注流', await dy.following(5))

  let secUid = ''
  for (const src of [feed, sr]) {
    const hit = (src?.items || []).find((x) => x.author?.secUid)
    if (hit) { secUid = hit.author.secUid; break }
  }
  if (secUid) {
    show('博主作品', await dy.userPosts(secUid, 5))
  } else log('博主作品: 跳过（没拿到 sec_uid）')

  // 详情 + 截帧：拿一条真视频
  const anyItem = (sr?.items || feed?.items || [])[0]
  if (anyItem) {
    show('详情', await dy.detail(anyItem.id))
    line('截帧')
    const t0 = Date.now()
    const fr = await dy.frames(anyItem.id, 3)
    log('截帧结果:', JSON.stringify(fr), '耗时', ((Date.now() - t0) / 1000).toFixed(1) + 's')
  } else log('截帧: 跳过（没有任何可截的视频）')

  line('结论')
  log('登录:', me.loggedIn ? '✓' : '✗（需要登录）')
  log('浏览器 profile:', session.hasProfile ? '✓ 有 cookie' : '（新 profile）')
  log('浏览器故意留着（下次直接复用，登录态也在里头），端口 9333')
}

main().catch((e) => { console.error('[selftest] 挂了:', e?.stack ?? e); process.exit(1) })
