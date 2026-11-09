/**
 * bin/look.mjs —— 「看一眼」：打开某个页面，截一张图，返回图片路径和页面摘要。
 *
 *   node bin/look.mjs --url "https://www.douyin.com/video/xxx"
 *   node bin/look.mjs --url "https://www.douyin.com/chat" --name chat
 *
 * 走无头浏览器，不碰桌面；图片存在 ~/.dsh/fish/shots/，上层用读图能力去看。
 */
import { Browser, readCookieString } from '../lib/cdp.mjs'
import { screenshot, pageSummary } from '../lib/eyes.mjs'
import { cookieFile } from '../lib/account.mjs'
import { arg, emit } from '../lib/util.mjs'

const url = arg('--url', 'https://www.douyin.com/')
const name = arg('--name', 'look')

// 默认用屏幕外真 Chrome：无头容易被验证码拦（截图就是一张验证页）
const mode = arg('--mode', 'offscreen')
const launchOpts = mode === 'headless'
  ? { headless: true }
  : mode === 'visible'
    ? { headless: false }
    : { headless: false, extraArgs: ['--window-position=-2400,-1400', '--window-size=1200,900'] }
const b = await new Browser().launch(launchOpts)
let out
try {
  await b.setCookies(readCookieString(cookieFile()))
  await b.goto(url, 9000)
  await new Promise((r) => setTimeout(r, 2500))
  const file = await screenshot(b, { name })
  const info = await pageSummary(b)
  out = { ok: true, file, ...info }
} catch (e) {
  out = { ok: false, error: String(e?.message ?? e) }
} finally {
  await b.close()
}
emit(out)
process.exit(out?.ok ? 0 : 1)
