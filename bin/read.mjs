/**
 * bin/read.mjs —— 读某个会话最近的消息（谁说的 + 内容）
 *
 *   node bin/read.mjs --to "DeepSleep" --n 10
 *
 * 输出：{ ok, to, count, messages: [{ who, text }] } —— 时间正序（旧→新）
 */
import { Browser, readCookieString } from '../lib/cdp.mjs'
import { openChat, openConversation, readRecent } from '../lib/douyin.mjs'
import { cookieFile } from '../lib/account.mjs'
import { arg, emit, sleep } from '../lib/util.mjs'

const to = arg('--to')
const n = Math.max(1, Number(arg('--n', '10')) || 10)
if (!to) { emit({ ok: false, error: '缺 --to（昵称或群名）' }); process.exit(2) }

const b = await new Browser().launch({ headless: true })
let out
try {
  await b.setCookies(readCookieString(cookieFile()))
  await openChat(b)
  const conv = await openConversation(b, to)
  if (!conv?.ok) {
    out = { ok: false, to, error: `找不到会话「${to}」`, seen: conv?.names || [] }
  } else {
    await sleep(1200)
    let msgs = await readRecent(b, n)
    for (let i = 0; i < 2 && !msgs.length; i++) {
      await sleep(1000)
      await openConversation(b, to)
      await sleep(800)
      msgs = await readRecent(b, n)
    }
    out = { ok: true, to, count: msgs.length, messages: msgs }
  }
} catch (e) {
  out = { ok: false, to, error: String(e?.message ?? e) }
} finally {
  await b.close()
}
emit(out)
process.exit(out?.ok ? 0 : 1)
