/**
 * lib/vision.mjs —— 读聊天里的图片/表情包（走 modlens + Antigravity CLI 的视觉）。
 *
 * 实测（2026-11-09）：
 *   · 模型 gemini-3.8-flash-low   → 中文描述，约 20 秒
 *   · 模型 gemini-3.8-flash-medium→ 英文描述，约 13 秒
 * 我们选 low（中文更贴合群聊语境）。
 *
 * 设计：缓存 + 失败降级，绝不挡聊天。
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir, tmpdir } from 'node:os'

const HOME = process.env.DSH_FISH_HOME || join(homedir(), '.dsh', 'fish')
const CACHE = join(HOME, 'vision-cache.json')

const MODLENS_MAIN = process.env.MODLENS_MAIN
  || '\\.dsh\\profiles\\desktop\\node_modules\\@liustack\\modlens\\dist\\main.js'
const AGY_BIN = process.env.AGY_BIN || '\\AppData\\Local\\agy\\bin\\agy.exe'
const MODEL = process.env.VISION_MODEL || 'gemini-3.8-flash-low'

const PROMPT = '这是抖音聊天里对方发的一张表情包或图片。**必须用中文**回答，一句话说清：画的是什么、什么情绪。不要英文，不要客套，30 字以内。'

function loadCache() {
  try { return JSON.parse(readFileSync(CACHE, 'utf8')) } catch { return {} }
}
function saveCache(c) {
  try {
    if (!existsSync(HOME)) mkdirSync(HOME, { recursive: true })
    const keys = Object.keys(c)
    if (keys.length > 300) for (const k of keys.slice(0, keys.length - 300)) delete c[k]
    writeFileSync(CACHE, JSON.stringify(c), 'utf8')
  } catch { /* 缓存失败不影响识别 */ }
}

function run(cmd, args, { timeout = 120_000 } = {}) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { windowsHide: true })
    let out = ''
    let err = ''
    const timer = setTimeout(() => { try { child.kill() } catch { /* 已退 */ } }, timeout)
    child.stdout.on('data', (d) => { out += d.toString() })
    child.stderr.on('data', (d) => { err += d.toString() })
    child.on('error', (e) => { clearTimeout(timer); resolve({ ok: false, error: String(e?.message ?? e) }) })
    child.on('close', (code) => { clearTimeout(timer); resolve({ ok: code === 0, code, out, err }) })
  })
}

async function download(url, tag) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(20_000) })
    if (!res.ok) return ''
    const buf = Buffer.from(await res.arrayBuffer())
    const p = join(tmpdir(), 'dsh-fish-img-' + tag + '.jpg')
    writeFileSync(p, buf)
    return p
  } catch { return '' }
}

/** 从 modlens 的 JSON 里抠出一句人类可读的描述 */
function pickText(j) {
  const r = j.result || j
  const regions = (r.layout && r.layout.regions) || []
  const first = regions.map((x) => String(x.text || '').trim()).filter(Boolean)[0]
  if (first) return first.slice(0, 60)

  const sem = r.semantics || {}
  const ents = (sem.entities || []).map((e) => e.name || e.evidence).filter(Boolean)
  if (ents.length) return ents.slice(0, 2).join('、')

  const desc = r.description || r.summary || sem.summary || sem.description
  if (desc) return String(desc)

  return first || ''
}

/**
 * 识别一张图。src 可以是 http(s) 链接或本地路径。
 * @returns {Promise<string>} 一句中文描述；失败返回 ''
 */
export async function describeImage(src) {
  const key = String(src || '').trim()
  if (!key) return ''

  const cache = loadCache()
  if (cache[key]) return cache[key]

  let localPath = key
  if (/^https?:\/\//i.test(key)) {
    const tag = String(Math.abs(key.split('').reduce((a, c) => (a * 31 + c.charCodeAt(0)) | 0, 7)))
    localPath = await download(key, tag)
    if (!localPath) return ''
  } else if (!existsSync(key)) {
    return ''
  }

  if (!existsSync(MODLENS_MAIN)) return ''

  const r = await run(process.execPath, [
    MODLENS_MAIN, 'analyze',
    '-i', localPath,
    '-p', 'antigravity-cli',
    '--provider-bin', AGY_BIN,
    '-m', MODEL,
    '--prompt', PROMPT,
  ])

  let text = ''
  if (r.ok) {
    try { text = pickText(JSON.parse(r.out)) } catch { text = String(r.out || '').trim() }
  }

  text = String(text || '').replace(/\s+/g, ' ').trim().slice(0, 80)
  if (text) { cache[key] = text; saveCache(cache) }
  return text
}
