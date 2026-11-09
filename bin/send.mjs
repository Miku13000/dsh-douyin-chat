/**
 * bin/send.mjs —— 命令行发抖音私信/群消息（我们自己的实现）
 *   node bin/send.mjs --to "Sora" --text "在吗"
 *   node bin/send.mjs --to "Yuuka的后宫" --text "试一下" --dry
 */
import { Browser, readCookieString } from '../lib/cdp.mjs'
import { cookieFile } from '../lib/account.mjs'
import { sendMessage } from '../lib/douyin.mjs'

const arg = (name, dflt = '') => {
  const i = process.argv.indexOf(name)
  return i < 0 ? dflt : (process.argv[i + 1] ?? dflt)
}
const to = arg('--to')
const text = arg('--text')
const dry = process.argv.includes('--dry')
if (!to || !text) {
  console.log(JSON.stringify({ ok: false, error: '用法: node bin/send.mjs --to <昵称或群名> --text "内容" [--dry]' }))
  process.exit(2)
}

const COOKIE = cookieFile()
const b = await new Browser().launch({ headless: true })
let out
try {
  await b.setCookies(readCookieString(COOKIE))
  out = await sendMessage(b, { to, text, dry, at: arg('--at') })
} catch (e) {
  out = { ok: false, error: String(e?.message ?? e) }
} finally {
  await b.close()
}
console.log(JSON.stringify(out, null, 2))
process.exit(out?.ok ? 0 : 1)
