/**
 * bin/account.mjs —— 管「用哪个抖音号」。
 *
 *   node bin/account.mjs list                 # 看有哪些账号 + 当前用哪个
 *   node bin/account.mjs add --id xiaoyu_2026 --nick 小鲸鱼 --cookie <文件>
 *   node bin/account.mjs use --id xiaoyu_2026  # 切过去（--nick 也行）
 *   node bin/account.mjs show                 # 当前用哪个、cookie 从哪来
 */
import { existsSync } from 'node:fs'
import { accounts, add, use, current, cookieFile, FALLBACK_COOKIE, ACCOUNTS } from '../lib/account.mjs'
import { load as loadPrefs } from '../lib/prefs.mjs'

const arg = (n, d = '') => { const i = process.argv.indexOf(n); return i < 0 ? d : (process.argv[i + 1] ?? d) }
const cmd = (process.argv[2] || 'show').toLowerCase()

if (cmd === 'list') {
  const list = accounts()
  const cur = current()
  console.log(JSON.stringify({
    ok: true,
    current: cur ? { id: cur.id, nick: cur.nick } : null,
    accounts: list.map((a) => ({
      id: a.id, nick: a.nick, cookie: a.cookieFile,
      cookieExists: a.cookieFile ? existsSync(a.cookieFile) : false,
      active: cur ? a.id === cur.id : false,
    })),
    fallbackCookie: FALLBACK_COOKIE,
    fallbackExists: existsSync(FALLBACK_COOKIE),
    store: ACCOUNTS,
  }, null, 2))
} else if (cmd === 'add') {
  const r = add({ id: arg('--id'), nick: arg('--nick'), cookieFile: arg('--cookie'), note: arg('--note') })
  console.log(JSON.stringify(r, null, 2))
} else if (cmd === 'use') {
  const id = arg('--id') || arg('--nick')
  if (!id) { console.log(JSON.stringify({ ok: false, error: '用法: use --id <抖音号|昵称>' })); process.exit(2) }
  console.log(JSON.stringify(use(id), null, 2))
} else {
  const prefs = loadPrefs()
  console.log(JSON.stringify({
    ok: true,
    account: prefs.account || null,
    cookieInUse: cookieFile(),
    cookieExists: existsSync(cookieFile()),
  }, null, 2))
}
