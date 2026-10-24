// 证据脚本 ②：真发一条带 @ 的评论（走插件自己上线的 lib/act.mjs，不是另写一套逻辑）
//
// 用法：
//   set DOUYIN_DUTY_HOME=C:\Users\你\.dsh\douyin-duty
//   node proof/verify-comment.mjs <视频id> <@谁> "评论正文"
//
// 前提：那个浏览器已登录抖音（设置页点「登录抖音」）。
// 输出：{ ok, mention: 'real'|'plain', msg } —— mention=real 才算 @ 成功。
import { BrowserSession } from '../lib/browser.mjs'
import { comment } from '../lib/act.mjs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const HOME = process.env.DOUYIN_DUTY_HOME || join(homedir(), '.dsh', 'douyin-duty')
const PORT = Number(process.env.DOUYIN_CDP_PORT || 9333)
const [VIDEO, WHO, BODY] = [process.argv[2], process.argv[3] || '', process.argv[4] || '来自插件的自检评论']

if (!VIDEO) {
  console.error('用法：node proof/verify-comment.mjs <视频id> <@谁> "评论正文"')
  process.exit(2)
}

const s = new BrowserSession({ dir: join(HOME, 'browser'), port: PORT, mode: 'visible', log: (m) => console.log('  ·', m) })
await s.start()
const r = await comment(s, VIDEO, { text: BODY, mention: WHO }, { dryRun: false })
console.log('结果 =', JSON.stringify(r))
await s.stop()
process.exit(0)
