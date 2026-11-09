/**
 * bin/comments.mjs —— 读 / 回抖音评论
 *
 *   node bin/comments.mjs read  --url "https://www.douyin.com/video/ID" --n 20
 *   node bin/comments.mjs reply --url "https://www.douyin.com/video/ID" --index 2 --text "…"
 *
 * 走无头浏览器，不碰桌面。
 */
import { Browser, readCookieString } from '../lib/cdp.mjs'
import { readComments, replyComment } from '../lib/comments.mjs'
import { cookieFile } from '../lib/account.mjs'

const arg = (n, d = '') => { const i = process.argv.indexOf(n); return i < 0 ? d : (process.argv[i + 1] ?? d) }
const cmd = (process.argv[2] || 'read').toLowerCase()
const url = arg('--url')
if (!url) { console.log(JSON.stringify({ ok: false, error: '缺 --url' })); process.exit(2) }

const b = await new Browser().launch({ headless: true })
let out
try {
  await b.setCookies(readCookieString(cookieFile()))
  if (cmd === 'reply') {
    const text = arg('--text')
    if (!text) { console.log(JSON.stringify({ ok: false, error: '缺 --text' })); process.exit(2) }
    out = await replyComment(b, { url, index: Number(arg('--index', '0')) || 0, text })
  } else {
    const list = await readComments(b, { url, n: Number(arg('--n', '20')) || 20 })
    out = { ok: true, url, count: list.length, comments: list }
  }
} catch (e) {
  out = { ok: false, error: String(e?.message ?? e) }
} finally {
  await b.close()
}
console.log(JSON.stringify(out, null, 2))
process.exit(out?.ok ? 0 : 1)
