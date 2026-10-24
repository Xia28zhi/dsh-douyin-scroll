// 证据脚本 ③：真给某个人/某个群分享一条视频卡片（走插件的 lib/act.mjs）
//
// 用法：
//   set DOUYIN_DUTY_HOME=C:\Users\你\.dsh\douyin-duty
//   node proof/verify-share.mjs <视频id> <分享给谁>
//
// 前提：浏览器已登录抖音。
// 输出：{ ok, msg } —— 面板消失 + 出现提示条才算成功。
import { BrowserSession } from '../lib/browser.mjs'
import { share } from '../lib/act.mjs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const HOME = process.env.DOUYIN_DUTY_HOME || join(homedir(), '.dsh', 'douyin-duty')
const PORT = Number(process.env.DOUYIN_CDP_PORT || 9333)
const VIDEO = process.argv[2]
const TO = process.argv[3]

if (!VIDEO || !TO) {
  console.error('用法：node proof/verify-share.mjs <视频id> <分享给谁>')
  process.exit(2)
}

const s = new BrowserSession({ dir: join(HOME, 'browser'), port: PORT, mode: 'visible', log: (m) => console.log('  ·', m) })
await s.start()
const r = await share(s, VIDEO, TO, { dryRun: false })
console.log('分享结果 =', JSON.stringify(r))
await s.stop()
process.exit(0)
