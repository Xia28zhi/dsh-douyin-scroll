// 发布前自检：把三个包解开，跟源码逐文件比 SHA256，顺便查链接、个人痕迹、版本号。
// 用法（在 ds-github 目录下，或任意目录）：node 发布前自检.mjs
import { readFileSync, readdirSync, statSync, mkdirSync, rmSync, existsSync } from "node:fs"
import { join, relative, dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { createHash } from "node:crypto"
import { execSync } from "node:child_process"

const G = dirname(fileURLToPath(import.meta.url))
const SRC = join(G, "dsh-douyin-scroll")
const VER = JSON.parse(readFileSync(join(SRC, "package.json"), "utf8")).version
const TMP = join(process.env.TEMP || ".", "vfy-" + Date.now())
const hash = (f) => createHash("sha256").update(readFileSync(f)).digest("hex")
const walk = (d, out = []) => {
  for (const n of readdirSync(d)) {
    const p = join(d, n)
    statSync(p).isDirectory() ? walk(p, out) : out.push(p)
  }
  return out
}

const report = []
const ok = (m) => report.push("  ✓ " + m)
const bad = (m) => report.push("  ✗ " + m)

mkdirSync(TMP, { recursive: true })
const tgz = join(G, `dsh-douyin-scroll-${VER}.tgz`)
const cleanZip = join(G, `dsh-douyin-scroll-${VER}-clean.zip`)
const fullZip = join(G, `dsh-douyin-scroll-${VER}-full-clean.zip`)
for (const f of [tgz, cleanZip, fullZip]) if (!existsSync(f)) { console.log("✗ 缺包：" + f); process.exit(1) }

execSync(`tar -xzf "${tgz}" -C "${TMP}"`, { stdio: "ignore" })
const tgzRoot = join(TMP, "package")
for (const [zip, dir] of [[cleanZip, "clean"], [fullZip, "full"]]) {
  mkdirSync(join(TMP, dir), { recursive: true })
  execSync(`powershell -NoProfile -Command "Expand-Archive -LiteralPath '${zip}' -DestinationPath '${join(TMP, dir)}' -Force"`, { stdio: "ignore" })
}
const cleanRoot = join(TMP, "clean", "dsh-douyin-scroll")
const fullRoot = join(TMP, "full", "dsh-douyin-scroll")

const srcFiles = walk(SRC).filter((f) => !/docs[\\/]images/.test(relative(SRC, f)))
for (const [label, root] of [["tgz", tgzRoot], ["clean.zip", cleanRoot], ["full-clean.zip", fullRoot]]) {
  report.push(`【${label}】${walk(root).length} 个文件`)
  const diffs = [], missing = []
  for (const f of srcFiles) {
    const rel = relative(SRC, f).replace(/\\/g, "/")
    if (rel.startsWith(".bak-") && label !== "full-clean.zip") continue
    const r = join(root, rel)
    if (!existsSync(r)) { missing.push(rel); continue }
    if (hash(f) !== hash(r)) diffs.push(rel)
  }
  if (missing.length || diffs.length) bad(`${label} 缺 ${missing.length} 个、内容不同 ${diffs.length} 个 ${[...missing, ...diffs].slice(0, 5).join("、")}`)
  else ok(`${label} 与源码逐文件一致`)

  const banned = walk(root).filter((f) => /docs[\\/]images|node_modules|\.probe/.test(f))
  banned.length ? bad(`${label} 混进了 ${banned.length} 个不该发布的文件`) : ok(`${label} 无个人截图 / node_modules`)

  const broken = []
  for (const f of walk(root).filter((x) => x.endsWith(".md"))) {
    const txt = readFileSync(f, "utf8")
    for (const m of txt.matchAll(/\]\((?!https?:|#)([^)]+)\)/g)) {
      const t = resolve(dirname(f), decodeURI(m[1].split("#")[0]))
      if (!existsSync(t)) broken.push(`${relative(root, f)} → ${m[1]}`)
    }
  }
  broken.length ? bad(`${label} 断链 ${broken.length} 个：${broken.slice(0, 3).join("；")}`) : ok(`${label} 内部链接全部可达`)

  const v = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version
  v === VER ? ok(`${label} 版本 ${v}`) : bad(`${label} 版本 ${v} ≠ ${VER}`)
}

const PAT = /19710|夏至于兮|豆腐店|参大王/
for (const [label, root] of [["源码", SRC], ["tgz", tgzRoot], ["clean.zip", cleanRoot], ["full-clean.zip", fullRoot]]) {
  const hits = []
  for (const f of walk(root)) {
    if (!/\.(js|mjs|md|json|yml|txt)$/.test(f)) continue
    const m = readFileSync(f, "utf8").match(PAT)
    if (m) hits.push(`${relative(root, f)}(${m[0]})`)
  }
  hits.length ? bad(`${label} 有个人痕迹：${hits.join("、")}`) : ok(`${label} 无个人痕迹`)
}

console.log(report.join("\n"))
rmSync(TMP, { recursive: true, force: true })
