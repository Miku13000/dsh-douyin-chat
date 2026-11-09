/**
 * lib/vision.mjs —— 读聊天里的图片/表情包（纯文本模型的"眼睛"）。
 *
 * 原理：抖音消息里的表情/图片是 <img>，没有 alt/名字，纯文本读不出来。
 * 这里把图下载下来，交给一个本地视觉工具（modlens + Antigravity CLI）转成一句中文，
 * 再喂给回复模型。
 *
 * 依赖（可选）：
 *   · modlens：`npm i -g @liustack/modlens`
 *   · Antigravity CLI：`irm https://antigravity.google/cli/install.ps1 | iex`
 *   都装好后跑一次 `agy` 登录，再执行 `modlens config set reuse.<harness> true`（如需复用别的视觉）
 *
 * 没装也不影响聊天 —— describeImage 直接返回空字符串，调用方按"发了张图"处理。
 *
 * 环境变量：
 *   MODLENS_MAIN   modlens 的 dist/main.js 全路径
 *   AGY_BIN        agy 可执行文件全路径
 *   VISION_MODEL   模型名（默认 gemini-3.8-flash-low）
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir, tmpdir } from 'node:os'

const HOME = process.env.DSH_FISH_HOME || join(homedir(), '.dsh', 'fish')
const CACHE = join(HOME, 'vision-cache.json')

/** 自动找 modlens（常见安装位置 + 环境变量） */
function findModlens() {
  if (process.env.MODLENS_MAIN && existsSync(process.env.MODLENS_MAIN)) return process.env.MODLENS_MAIN
  const dsh = process.env.DSH_HOME || join(homedir(), '.dsh')
  const guesses = [
    join(dsh, 'profiles', 'desktop', 'node_modules', '@liustack', 'modlens', 'dist', 'main.js'),
    join(dsh, 'profiles', 'web', 'node_modules', '@liustack', 'modlens', 'dist', 'main.js'),
    join(process.env.APPDATA || '', 'npm', 'node_modules', '@liustack', 'modlens', 'dist', 'main.js'),
  ]
  return guesses.find((p) => existsSync(p)) || ''
}

/** 自动找 agy（Antigravity CLI） */
function findAgy() {
  if (process.env.AGY_BIN && existsSync(process.env.AGY_BIN)) return process.env.AGY_BIN
  const guesses = [
    join(process.env.LOCALAPPDATA || '', 'agy', 'bin', 'agy.exe'),
    join(process.env.USERPROFILE || '', '.local', 'bin', 'agy'),
    '/usr/local/bin/agy',
  ]
  return guesses.find((p) => existsSync(p)) || 'agy'
}

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
    const timer = setTimeout(() => { try { child.kill() } catch { /* 已退 */ } }, timeout)
    child.stdout.on('data', (d) => { out += d.toString() })
    child.stderr.on('data', () => { /* 忽略 */ })
    child.on('error', () => { clearTimeout(timer); resolve({ ok: false }) })
    child.on('close', (code) => { clearTimeout(timer); resolve({ ok: code === 0, out }) })
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

/** 从视觉工具的 JSON 里抠出一句人类可读的描述 */
function pickText(j) {
  const r = j.result || j
  const regions = (r.layout && r.layout.regions) || []
  const first = regions.map((x) => String(x.text || '').trim()).filter(Boolean)[0]
  if (first) return first.slice(0, 60)

  const sem = r.semantics || {}
  const ents = (sem.entities || []).map((e) => e.name || e.evidence).filter(Boolean)
  if (ents.length) return ents.slice(0, 2).join('、')

  const desc = r.description || r.summary || sem.summary || sem.description
  return desc ? String(desc) : ''
}

/**
 * 识别一张图。src 可以是 http(s) 链接或本地路径。
 * @returns {Promise<string>} 一句中文描述；没装视觉工具或失败返回 ''
 */
export async function describeImage(src) {
  const key = String(src || '').trim()
  if (!key) return ''

  const cache = loadCache()
  if (cache[key]) return cache[key]

  const modlens = findModlens()
  if (!modlens) return ''

  let localPath = key
  if (/^https?:\/\//i.test(key)) {
    const tag = String(Math.abs(key.split('').reduce((a, c) => (a * 31 + c.charCodeAt(0)) | 0, 7)))
    localPath = await download(key, tag)
    if (!localPath) return ''
  } else if (!existsSync(key)) {
    return ''
  }

  const r = await run(process.execPath, [
    modlens, 'analyze',
    '-i', localPath,
    '-p', 'antigravity-cli',
    '--provider-bin', findAgy(),
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
