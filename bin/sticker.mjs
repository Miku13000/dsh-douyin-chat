/**
 * bin/sticker.mjs —— 发表情（两种）：
 *   node bin/sticker.mjs --to "Sora" --emoji 比心      # 抖音内置表情
 *   node bin/sticker.mjs --to "Sora" --image <图片路径> # 自己的图（自定义表情包）
 *   node bin/sticker.mjs --to "Sora" --random           # 从 stickers/ 里随机抽一张发
 */
import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { Browser, readCookieString } from '../lib/cdp.mjs'
import { sendSticker, sendImage } from '../lib/douyin.mjs'
import { cookieFile } from '../lib/account.mjs'
import { load as loadPrefs } from '../lib/prefs.mjs'

const arg = (n, d = '') => { const i = process.argv.indexOf(n); return i < 0 ? d : (process.argv[i + 1] ?? d) }
const has = (f) => process.argv.includes(f)
const to = arg('--to')
if (!to) { console.log(JSON.stringify({ ok: false, error: '用法: --to <昵称/群名> [--emoji 比心 | --image 路径 | --random]' })); process.exit(2) }

const prefs = loadPrefs()
const STICKER_DIR = (prefs.stickerDir && String(prefs.stickerDir).trim()) || join(process.cwd(), 'stickers')
function pickLocal() {
  if (arg('--image')) return arg('--image')
  const files = (() => { try { return readdirSync(STICKER_DIR).filter((f) => /\.(png|jpe?g|gif|webp)$/i.test(f)) } catch { return [] } })()
  if (!files.length) return ''
  return join(STICKER_DIR, files[Math.floor(Math.random() * files.length)])
}

const b = await new Browser().launch({ headless: true })
let out
try {
  await b.setCookies(readCookieString(cookieFile()))
  // 只有明确要本地图（--image / --random）才发图；否则一律发抖音内置表情
  const wantLocal = Boolean(arg('--image')) || process.argv.includes('--random')
  const local = wantLocal ? pickLocal() : ''
  if (wantLocal && !local) out = { ok: false, error: 'stickers/ 里没有可用图片' }
  else if (local) out = await sendImage(b, { to, file: local })
  else out = await sendSticker(b, { to, keyword: arg('--emoji') })
} catch (e) { out = { ok: false, error: String(e?.message ?? e) } } finally { await b.close() }
console.log(JSON.stringify(out, null, 2))
process.exit(out?.ok ? 0 : 1)