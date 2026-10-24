/**
 * lib/ocr.mjs —— 画面截帧的**本地 OCR**（Windows 内置，零依赖）
 * ============================================================================
 * 为什么用它：抖音没有字幕接口，"画面里写了什么"常常就是这条视频的全部信息
 *   （教程 / 图文 / 新闻 / 带字幕的口播）。装 tesseract 太重，能用系统自带的就用自带的。
 *
 * 🔴 三个坑（都踩过，写在前面）：
 *   1. **中文路径会毁掉 PowerShell 命令行** ⇒ 先把图复制到一个**纯英文临时路径**再 OCR；
 *   2. `powershell -Command script - args` 语法**不按你想的那样工作** ⇒ 用 `-File xxx.ps1 -Path ...`；
 *   3. PowerShell 5.1 默认按 GBK 输出 ⇒ 脚本里先钉死 `[Console]::OutputEncoding = UTF8`，
 *      不然 node 侧收到一串方块。
 *
 * 拿不到引擎（比如没装中文 OCR 语言包）时**安静地失败**，返回 ok:false ——
 * 判断链会自动退回"只看元数据"，绝不因此让整轮挂掉。
 * ============================================================================
 */
import { execFile } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'

const PS1 = `
param([string]$Path, [string]$Lang)
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$ErrorActionPreference = 'Stop'
try {
  Add-Type -AssemblyName System.Runtime.WindowsRuntime | Out-Null
  $asTask = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation\`1' })[0]
  function Await($op, $type) {
    $m = $asTask.MakeGenericMethod($type)
    $t = $m.Invoke($null, @($op))
    $t.Wait(-1) | Out-Null
    return $t.Result
  }
  [Windows.Storage.StorageFile,Windows.Storage,ContentType=WindowsRuntime] | Out-Null
  [Windows.Graphics.Imaging.BitmapDecoder,Windows.Foundation,ContentType=WindowsRuntime] | Out-Null
  [Windows.Media.Ocr.OcrEngine,Windows.Foundation,ContentType=WindowsRuntime] | Out-Null

  $engine = $null
  if ($Lang) {
    try { $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage([Windows.Globalization.Language]::new($Lang)) } catch { $engine = $null }
  }
  if (-not $engine) { $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages() }
  if (-not $engine) { Write-Output 'DY_OCR:ERR no-engine'; exit 0 }

  $sf = Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync($Path)) ([Windows.Storage.StorageFile])
  $stream = Await ($sf.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
  $decoder = Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
  $bitmap = Await ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
  $result = Await ($engine.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult])
  Write-Output ('DY_OCR:LANG ' + $engine.RecognizerLanguage.LanguageTag)
  Write-Output 'DY_OCR:TEXT'
  Write-Output $result.Text
} catch {
  Write-Output ('DY_OCR:ERR ' + $_.Exception.Message)
}
`

/**
 * 认一张图里的字
 * @param {string} png 图片（可以是中文路径）
 * @param {{lang?:string, tmpDir?:string}} opts
 * @returns {Promise<{ok:boolean, text:string, lang?:string, error?:string}>}
 */
export async function ocrFile(png, { lang = 'zh-Hans-CN', tmpDir } = {}) {
  const dir = tmpDir || join(process.env.DOUYIN_DUTY_HOME || join(process.env.USERPROFILE || 'C:/Users/Public', '.dsh', 'douyin-duty'), 'tmp')
  try { mkdirSync(dir, { recursive: true }) } catch { /* 建不了就在下面报错 */ }
  if (!existsSync(png)) return { ok: false, text: '', error: '图不存在：' + png }

  // ⭐ 复制到纯英文临时路径（PowerShell 命令行里出现中文路径会被编码搞乱）
  const ascii = join(dir, `ocr_${Date.now()}_${Math.random().toString(36).slice(2, 6)}.png`)
  try { copyFileSync(png, ascii) } catch (e) { return { ok: false, text: '', error: '复制临时图失败：' + String(e?.message ?? e) } }

  const ps1 = join(dir, 'winrt-ocr.ps1')
  try { writeFileSync(ps1, PS1, 'utf8') } catch (e) { return { ok: false, text: '', error: '写 OCR 脚本失败：' + String(e?.message ?? e) } }

  const args = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', ps1, '-Path', ascii, '-Lang', String(lang || '')]
  const out = await new Promise((resolve) => {
    execFile('powershell', args, { encoding: 'utf8', timeout: 60_000, windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
      if (err && !stdout) resolve('')
      else resolve(String(stdout || ''))
    })
  })

  const m = out.match(/DY_OCR:LANG\s+(\S+)/)
  const idx = out.indexOf('DY_OCR:TEXT')
  if (idx < 0) {
    const err = (out.match(/DY_OCR:ERR\s+(.*)/) || [])[1] || 'OCR 没返回文字（可能没装中文 OCR 语言包）'
    return { ok: false, text: '', error: String(err).trim().slice(0, 200) }
  }
  const text = out.slice(idx + 'DY_OCR:TEXT'.length).trim()
  return { ok: text.length > 0, text: text.slice(0, 2000), lang: m?.[1] || '' }
}

/** 一次认多张（串行，别把机器压死），返回拼好的文字 */
export async function ocrFiles(files, opts = {}) {
  const parts = []
  const errs = []
  for (const f of files) {
    const r = await ocrFile(f, opts)
    if (r.ok && r.text) parts.push(String(r.text).replace(/\s+/g, ' ').trim())
    else if (r.error) errs.push(r.error)
  }
  return { ok: parts.length > 0, text: parts.join(' / ').slice(0, 3000), errors: errs.slice(0, 2) }
}
