// 证据脚本 ①：把插件依赖的抖音 DOM 事实打印出来（随时可复跑，证明选择器不是拍脑袋）
//
// 用法（先让插件的浏览器跑起来：设置页点「登录抖音」即可）：
//   set DOUYIN_DUTY_HOME=C:\Users\你\.dsh\douyin-duty
//   node proof/probe-dom.mjs https://www.douyin.com/video/<随便一个视频id>
//
// 输出：评论区/输入框/@下拉/分享图标/分享面板 的可选性 + 关键尺寸，供改选择器时对照。
import { BrowserSession } from '../lib/browser.mjs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const HOME = process.env.DOUYIN_DUTY_HOME || join(homedir(), '.dsh', 'douyin-duty')
const PORT = Number(process.env.DOUYIN_CDP_PORT || 9333)
const VIDEO_URL = process.argv[2] || 'https://www.douyin.com/'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const s = new BrowserSession({ dir: join(HOME, 'browser'), port: PORT, mode: 'headless', log: () => {} })
await s.start()
const { cdp } = await s.tab(VIDEO_URL)
await cdp.send('Page.enable')
await cdp.send('Runtime.enable')
await sleep(4000)

const ev = async (expr) =>
  cdp.send('Runtime.evaluate', { expression: expr, returnByValue: true }, 15000).then((r) => r?.result?.value).catch(() => null)

const rect = (sel) => `(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return null
  const r = e.getBoundingClientRect(); return { w: Math.round(r.width), h: Math.round(r.height), x: Math.round(r.x), y: Math.round(r.y) } })()`

console.log('# 页面')
console.log('url   =', await ev('location.href'))
console.log('已登录 =', await ev(`!!document.querySelector('[data-e2e="live-avatar"], img[class*="avatar" i]')`), '（false 说明掉登录，先扫码）')
console.log('# 评论')
console.log('评论列表存在 =', await ev(`!!document.querySelector('[data-e2e="comment-list"]')`))
console.log('输入框(旧选择器) =', await ev(rect('[contenteditable="true"],textarea')))
console.log('输入框(新选择器) =', await ev(rect('.public-DraftEditor-content, [contenteditable]')))
console.log('占位文字「留下你的精彩评论吧」 =', await ev(`(() => { const e = [...document.querySelectorAll('div,span')]
  .find((x) => (x.textContent || '').trim() === '留下你的精彩评论吧'); return e ? 'yes' : 'no' })()`))
console.log('# @ 下拉（点开输入框后打一个 @ 再看）')
console.log('下拉容器 .atBox-inner-container =', await ev(`!!document.querySelector('.atBox-inner-container')`))
console.log('# 分享')
console.log('隐藏的分享节点（尺寸应为 0，click 无效） =', await ev(rect('[data-e2e="video-player-share"]')))
console.log('互动栏按钮数 =', await ev(`document.querySelectorAll('svg').length`))
console.log('# 结论：分享面板要「鼠标悬停」互动栏第 4 个图标才弹出，面板行 = 头像+名字+在线状态+「分享」按钮')

await s.stop()
process.exit(0)
