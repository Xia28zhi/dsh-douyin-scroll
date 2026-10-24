/**
 * tools/probe6.mjs —— 最终通道验证：在登录页上下文里直取全部数据接口
 * node tools/probe6.mjs
 */
import { launchBrowser, openTab, evaluate } from '../lib/cdp.mjs'
import { writeFileSync } from 'node:fs'

const HOME = process.env.DOUYIN_DUTY_HOME || join(homedir(), '.dsh', 'douyin-duty')
const PROFILE = HOME + '/browser'
const log = (...a) => console.log('[probe6]', ...a)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const alive = async (port) => { try { const r = await fetch(`http://127.0.0.1:${port}/json/version`); return r.ok } catch { return false } }

const BASE = 'device_platform=webapp&aid=6383&channel=channel_pc_web'

const APIS = {
  feed:    `/aweme/v1/web/tab/feed/?${BASE}&count=10`,
  search:  `/aweme/v1/web/search/item/?${BASE}&keyword=%E7%BC%96%E7%A8%8B&count=5&offset=0`,
  hotlist: `/aweme/v1/web/hot/search/list/?${BASE}&detail_list=1`,
  hotfeed: `/aweme/v1/web/hotspot/feed/?${BASE}&count=10`,
  follow:  `/aweme/v1/web/follow/feed/?${BASE}&count=10`,
  detail:  null, // 动态填
  post:    null, // 动态填
}

async function main() {
  setTimeout(() => { log('硬超时'); process.exit(0) }, 100_000).unref?.()
  if (!(await alive(9333))) { await launchBrowser({ userDataDir: PROFILE, port: 9333, url: 'about:blank' }) }

  const { cdp } = await openTab({ port: 9333, url: 'https://www.douyin.com/' })
  await sleep(6_000)  // 等 cookie / sdk 就绪

  // 先取 feed，拿 aweme_id 和 sec_uid 供 detail/post 用
  const fetchApi = (path) => evaluate(cdp,
    `fetch(${JSON.stringify(path)}, {credentials:'include', headers:{accept:'application/json'}}).then(r=>r.text()).then(t=>t).catch(e=>'ERR:'+e.message)`,
    30_000)

  log('─ feed ─')
  const feedTxt = await fetchApi(APIS.feed)
  let awemeId = '', secUid = ''
  try {
    const j = JSON.parse(feedTxt)
    log('  status_code=', j.status_code, '| aweme_list=', Array.isArray(j.aweme_list) ? j.aweme_list.length : j.aweme_list)
    awemeId = j.aweme_list?.[0]?.aweme_id || ''
    secUid = j.aweme_list?.[0]?.author?.sec_uid || ''
  } catch { log('  非JSON:', String(feedTxt).slice(0, 200)) }
  log('  拿到 aweme_id:', awemeId, '| sec_uid:', secUid ? secUid.slice(0, 25) + '…' : '')

  const jobs = [
    ['search', APIS.search, (j) => `data=${Array.isArray(j.data) ? j.data.length : j.data}`],
    ['hotlist', APIS.hotlist, (j) => `data=${Array.isArray(j.data) ? j.data.length : j.data}`],
    ['hotfeed', APIS.hotfeed, (j) => `aweme_list=${Array.isArray(j.aweme_list) ? j.aweme_list.length : j.aweme_list}`],
    ['follow', APIS.follow, (j) => `aweme_list=${Array.isArray(j.aweme_list) ? j.aweme_list.length : j.aweme_list}`],
  ]
  if (awemeId) jobs.push(['detail', `/aweme/v1/web/aweme/detail/?${BASE}&aweme_id=${awemeId}`, (j) => `desc=${String(j.aweme_detail?.desc || '').slice(0, 30)}`])
  if (secUid) jobs.push(['post', `/aweme/v1/web/aweme/post/?${BASE}&sec_user_id=${encodeURIComponent(secUid)}&count=10&max_cursor=0&publish_video_strategy_type=2`, (j) => `aweme_list=${Array.isArray(j.aweme_list) ? j.aweme_list.length : j.aweme_list}`])

  const summary = {}
  for (const [name, path, summarize] of jobs) {
    const txt = await fetchApi(path)
    try {
      const j = JSON.parse(txt)
      log(`─ ${name} ─  status_code=${j.status_code}  status_msg=${j.status_msg || ''}  ${summarize(j)}`)
      summary[name] = { ok: j.status_code === 0, msg: j.status_msg || '' }
    } catch {
      log(`─ ${name} ─  非JSON:`, String(txt).slice(0, 180))
      summary[name] = { ok: false, msg: '非JSON' }
    }
    await sleep(600) // 礼貌一点，别刷接口
  }

  writeFileSync(HOME + '/probe/api-summary.json', JSON.stringify(summary, null, 2), 'utf8')
  log('汇总 → api-summary.json', JSON.stringify(summary))
  log('探测结束')
}

main().catch((e) => { console.error('[probe6] 失败:', e?.stack ?? e); process.exit(1) })
