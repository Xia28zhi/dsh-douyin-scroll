/**
 * lib/hostdeps.mjs —— 从宿主那棵树里取 `@deepseek-ai/*`（拿不到就退到降级）
 * ============================================================================
 * 🔴 这条是**参考项目 dsh-bili-scroll 用真机事故换来的**，原样继承（MIT，已署名）：
 *    桌面版 DSH 的 profile 是 `autoInstallPeers: false`，而 `@deepseek-ai/schemastery`
 *    和 `@deepseek-ai/dsh-tools` 是 **optional peer** ⇒ 永远不装 ⇒
 *    **在 index.js 顶部裸 import 会让整条插件不激活**，DSH 只留一句
 *    `warning: 1 entry did not activate … failed to import`，装了跟没装一样 ✗。
 *
 * ⇒ 策略：先去宿主树里找，找不到就 bare import（靠自己的 dependencies），
 *    再找不到就**降级**（Config 变成 undefined / defineTool 用本地等价实现）——
 *    **绝不因为一个 import 让整条插件躺下**。
 * ============================================================================
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'

const SELF_MODULES = join(dirname(fileURLToPath(import.meta.url)), '..', 'node_modules', '@deepseek-ai')

/** 可能藏着宿主 `@deepseek-ai` 包的地方（按可能性排序，不写死某一台机器） */
export function candidateRoots() {
  const out = []
  const push = (p) => { if (p && !out.includes(p)) out.push(p) }
  push(process.env.DSH_HOST_MODULES)

  const appdata = process.env.APPDATA
  if (appdata) {
    const npm = join(appdata, 'npm', 'node_modules')
    push(join(npm, '@deepseek-ai', 'dsh', 'node_modules', '@deepseek-ai'))
    push(join(npm, '@deepseek-ai'))
    try {
      for (const n of readdirSync(join(npm, '@deepseek-ai'))) push(join(npm, '@deepseek-ai', n, 'node_modules', '@deepseek-ai'))
    } catch { /* 没有就算了 */ }
  }
  push('/usr/local/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai')
  push('/usr/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai')
  push('/usr/local/lib/node_modules/@deepseek-ai')
  push('/usr/lib/node_modules/@deepseek-ai')

  // profile 树：有些机器上这些包是被别的插件 hoist 到 profile 根上的
  try {
    const dshHome = process.env.DSH_HOME || join(homedir(), '.dsh')
    for (const p of readdirSync(join(dshHome, 'profiles'))) push(join(dshHome, 'profiles', p, 'node_modules', '@deepseek-ai'))
  } catch { /* 没有就算了 */ }

  push(SELF_MODULES)
  return out
}

/** 按 package.json 的 exports['.'] 找入口 */
function entryUrlFor(root, name) {
  try {
    const dir = join(root, name)
    const pkgFile = join(dir, 'package.json')
    if (!existsSync(pkgFile)) return null
    const pkg = JSON.parse(readFileSync(pkgFile, 'utf8'))
    const dot = pkg.exports?.['.']
    const rel = typeof dot === 'string' ? dot : (dot?.import || dot?.default || pkg.module || pkg.main)
    if (!rel) return null
    const file = join(dir, String(rel).replace(/^\.\//, ''))
    return existsSync(file) ? pathToFileURL(file).href : null
  } catch { return null }
}

async function fromHostTree(name, log) {
  const fails = []
  for (const root of candidateRoots()) {
    if (root === SELF_MODULES) continue
    const url = entryUrlFor(root, name)
    if (!url) continue
    try {
      const mod = await import(url)
      log(`${name}：从宿主树取到`)
      return mod
    } catch (e) { fails.push(`${e?.code || 'ERR'}:${root}`) }
  }
  if (fails.length) log(`${name}：宿主树里都不行（${fails.slice(0, 3).join(' ')}）`)
  return null
}

/** 拿不到宿主 defineTool 时的本地等价实现：我们的 schema 本来就是标准 JSON Schema */
function localDefineTool(options, log) {
  const check = (schema, where) => {
    if (!schema || typeof schema !== 'object') return
    if (schema.type === 'object' && schema.additionalProperties === undefined) {
      throw new Error(`defineTool(${options.name}): ${where} 是 object 却没写 additionalProperties`)
    }
    for (const [k, v] of Object.entries(schema.properties || {})) check(v, `${where}.properties.${k}`)
  }
  check(options.parameters, 'parameters')
  check(options.output?.schema, 'output.schema')
  log?.(`dsh-tools 拿不到 —— 本地等价实现顶上（${options.name}）`)
  return options
}

export async function loadHostDeps() {
  const notes = []
  const log = (m) => notes.push(m)

  let zMod = await fromHostTree('schemastery', log)
  if (!zMod) {
    try { zMod = await import('@deepseek-ai/schemastery'); log('schemastery：用自己依赖里那份') }
    catch { log('⚠️ schemastery 彻底拿不到 —— 设置页降级（插件本体照常跑）') }
  }
  const z = zMod?.default ?? zMod ?? null

  let dtMod = await fromHostTree('dsh-tools', log)
  if (!dtMod) {
    try { dtMod = await import('@deepseek-ai/dsh-tools'); log('dsh-tools：用自己依赖里那份') }
    catch { log('dsh-tools 拿不到 —— 本地等价实现顶上'); dtMod = null }
  }
  const defineTool = dtMod?.defineTool || ((options) => localDefineTool(options, log))

  return { z, defineTool, notes }
}
