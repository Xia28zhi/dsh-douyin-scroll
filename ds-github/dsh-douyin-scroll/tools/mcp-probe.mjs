/**
 * tools/mcp-probe.mjs —— 真跑一遍 MCP 服务端（模拟"值班那一轮"拿工具的过程）
 * node tools/mcp-probe.mjs
 */
import { spawn } from 'node:child_process'
import { join } from 'node:path'
import { homedir } from 'node:os'

// 家目录不再写死（原来写的是作者机器上那台机的路径 ✗）：优先环境变量，兜底本机 $DSH_HOME/~/.dsh
const HOME = process.env.DOUYIN_HOME
  || join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'douyin-duty')
const PORT = Number(process.env.DOUYIN_PORT || 9333)
const script = join(process.cwd(), 'lib', 'mcp-server.mjs')

const child = spawn(process.execPath, [script], {
  env: { ...process.env, DOUYIN_HOME: HOME, DOUYIN_PORT: String(PORT) },
  stdio: ['pipe', 'pipe', 'inherit'],
  windowsHide: true,
})

let seq = 0
const pending = new Map()
let buf = ''
child.stdout.setEncoding('utf8')
child.stdout.on('data', (chunk) => {
  buf += chunk
  let i
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim()
    buf = buf.slice(i + 1)
    if (!line) continue
    let msg
    try { msg = JSON.parse(line) } catch { continue }
    const p = pending.get(msg.id)
    if (p) { pending.delete(msg.id); p(msg) }
  }
})

const call = (method, params, timeout = 60_000) => new Promise((resolve, reject) => {
  const id = ++seq
  const t = setTimeout(() => { pending.delete(id); reject(new Error(method + ' 超时')) }, timeout)
  pending.set(id, (m) => { clearTimeout(t); resolve(m) })
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
})

const log = (...a) => console.log('[mcp-probe]', ...a)

async function main() {
  setTimeout(() => { log('硬超时'); child.kill(); process.exit(0) }, 115_000).unref?.()

  const init = await call('initialize', {})
  log('initialize →', JSON.stringify(init.result?.serverInfo || init.error || ''))

  const list = await call('tools/list', {})
  const tools = list.result?.tools || []
  log('工具', tools.length, '个：', tools.map((t) => t.name).join(', '))

  const st = await call('tools/call', { name: 'douyin_status', arguments: {} })
  log('douyin_status →', text(st))

  const hot = await call('tools/call', { name: 'douyin_hot', arguments: { n: 5 } })
  log('douyin_hot →', text(hot).slice(0, 400))

  const sr = await call('tools/call', { name: 'douyin_search', arguments: { keyword: 'AI', n: 3 } })
  const sTxt = text(sr)
  log('douyin_search →', sTxt.slice(0, 300))
  let firstId = ''
  try { firstId = JSON.parse(sTxt).items?.[0]?.id || '' } catch {}

  if (firstId) {
    log('截帧测试：', firstId)
    const fr = await call('tools/call', { name: 'douyin_frames', arguments: { id: firstId, n: 2 } }, 90_000)
    log('douyin_frames →', text(fr).slice(0, 700))
  }

  const pick = await call('tools/call', { name: 'douyin_pick', arguments: { id: firstId || 'test', reason: '探测用', url: '' } })
  log('douyin_pick →', text(pick).slice(0, 200))

  const rep = await call('tools/call', { name: 'douyin_report', arguments: { md: '# 探测\n\n> 这是一次自测写的占位报告，可以删。\n' } })
  log('douyin_report →', text(rep).slice(0, 200))

  child.kill()
  log('探测结束')
}

const text = (m) => {
  if (m?.error) return 'ERR: ' + m.error.message
  return String(m?.result?.content?.[0]?.text || JSON.stringify(m?.result || '')).slice(0, 2000)
}

main().catch((e) => { console.error('[mcp-probe] 挂了:', e?.stack ?? e); child.kill(); process.exit(1) })
