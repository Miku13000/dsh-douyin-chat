/**
 * bin/login.mjs —— 网页登录（最省事的一种）：打开浏览器，你自己登，登完我自动存 Cookie 并关掉。
 *
 *   node bin/login.mjs                    # 默认可见窗口（这样你才点得到）
 *   node bin/login.mjs --mode offscreen   # 屏幕外（看不到窗口，只适合扫码另开图）
 *   node bin/login.mjs --timeout 600
 *
 * 只做三件事：开窗口 → 轮询登录票据 → 存 Cookie + 关窗口。
 * 不点页面、不猜二维码（之前按尺寸找二维码会误抓"下载 APP"推广卡）。
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Browser } from '../lib/cdp.mjs'
import { ensureHome, PATHS } from '../lib/paths.mjs'
import { add as addAccount, use as useAccount } from '../lib/account.mjs'
import { load as loadPrefs } from '../lib/prefs.mjs'
import { arg, emit, sleep } from '../lib/util.mjs'

const timeoutSec = Math.max(60, Number(arg('--timeout', '600')) || 600)
const mode = arg('--mode', (loadPrefs().browser || {}).loginMode || 'visible')
// 想去哪个页面由 --url 决定；--fresh 表示先不带旧 Cookie（这样才会看到登录界面）
const loginUrl = arg('--url', 'https://www.douyin.com/user/self')
const fresh = process.argv.includes('--fresh')

const launchOpts = mode === 'headless'
  ? { headless: true }
  : mode === 'offscreen'
    ? { headless: false, extraArgs: ['--window-position=-2400,-1400', '--window-size=1200,900'] }
    : { headless: false }

const b = await new Browser().launch(launchOpts)
let out
try {
  // 海外区 douyin.com 会被重定向到 tiktok.com；先注入现有 Cookie 把它留在抖音这边
  try {
    const prefs = loadPrefs()
    const cur = prefs.account?.cookieFile
    if (cur) {
      const { readCookieString } = await import('../lib/cdp.mjs')
      await b.setCookies(readCookieString(cur))
    }
  } catch { /* 没有旧登录态就直接开 */ }
  await b.goto(loginUrl, 6000)
  const landed = await b.eval('location.href')
  emit({ ok: false, stage: 'opened', url: landed, mode, hint: '浏览器已打开；如果你看到的是 TikTok，说明被地区重定向了，告诉我我换入口' })
  emit({
    ok: false,
    stage: 'waiting-login',
    mode,
    hint: '浏览器已打开，请自行登录（扫码/验证码都行）；登录成功后我会自动保存并关闭浏览器',
  })

  let hasSession = false
  const started = Date.now()
  while ((Date.now() - started) / 1000 < timeoutSec) {
    await sleep(3000)
    const cookies = await b.getCookies()
    hasSession = cookies.some((c) => /^(sessionid|sessionid_ss|sid_tt|sid_guard)$/.test(c.name) && c.value)
    if (hasSession) break
  }

  if (!hasSession) {
    out = { ok: false, stage: 'timeout', error: `等了 ${timeoutSec} 秒没检测到登录` }
  } else {
    // 登录后再给几秒，让 Cookie 全部落地
    await sleep(2500)
    const header = await b.cookieHeader()
    ensureHome()
    const dir = join(PATHS.home, 'accounts')
    mkdirSync(dir, { recursive: true })
    const file = join(dir, `cookie-${Date.now()}.txt`)
    writeFileSync(file, header, 'utf8')
    const acc = addAccount({ id: '', nick: '', cookieFile: file, note: '网页登录' })
    if (acc?.account) useAccount(acc.account.cookieFile)
    out = { ok: true, cookieFile: file, hasSession: true, account: acc?.account || null, hint: '已保存登录态，浏览器即将关闭' }
  }
} catch (e) {
  out = { ok: false, error: String(e?.message ?? e) }
} finally {
  await b.close()
}
emit(out)
process.exit(out?.ok ? 0 : 1)
