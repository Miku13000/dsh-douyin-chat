/**
 * bin/proactive.mjs —— 主动开口：隔一阵没人叫，也自己说一句。
 *
 * 老大要的「像 QQ 那样主动聊天」，落到抖音的私信和群聊两边。
 * 规矩（防刷屏）：
 *   · 两次主动之间至少隔 minGapMin 分钟（默认 90）
 *   · 每天最多 maxPerDay 条（默认 6）
 *   · quietHours 里闭嘴（默认 0-7 点）
 *   · 只在 dm 名单 / groupWhitelist 里挑对象
 *
 * 用法：
 *   node bin/proactive.mjs --once --dry     # 看它会说什么，不发
 *   node bin/proactive.mjs                  # 常驻
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Browser, readCookieString } from '../lib/cdp.mjs'
import { cookieFile } from '../lib/account.mjs'
import { openChat, openConversation, readRecent, sendMessage } from '../lib/douyin.mjs'
import { draftOpener } from '../lib/reply.mjs'
import { ensureHome, PATHS } from '../lib/paths.mjs'
import { load as loadPrefs } from '../lib/prefs.mjs'

const has = (f) => process.argv.includes(f)
const DRY = has('--dry')
const ONCE = DRY || has('--once')
const COOKIE = cookieFile()
const STATE = join(PATHS.home, 'proactive-state.json')
const LOG = join(PATHS.home, 'proactive.log')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const prefs = loadPrefs()
const P = prefs.proactive || {}
const ENABLED = P.enabled === true
const MIN_GAP = Math.max(5, Number(P.minGapMin) || 90)
const MAX_DAY = Math.max(1, Number(P.maxPerDay) || 6)
const QUIET = Array.isArray(P.quietHours) ? P.quietHours : [0, 1, 2, 3, 4, 5, 6, 7]
// 没显式配就用主配置里的私信对象 / 群（不然会去说一个不存在的群）
const DMS = (Array.isArray(P.dm) && P.dm.length ? P.dm : (prefs.dmPeers || [])).filter(Boolean)
const GROUPS = (Array.isArray(P.groups) && P.groups.length
  ? P.groups
  : (Array.isArray(prefs.groups) ? prefs.groups.map((g) => (typeof g === 'string' ? g : g && g.name)).filter(Boolean) : [])
).filter(Boolean)

const loadState = () => { try { return existsSync(STATE) ? JSON.parse(readFileSync(STATE, 'utf8')) : {} } catch { return {} } }
const saveState = (s) => { ensureHome(); try { writeFileSync(STATE, JSON.stringify(s, null, 2), 'utf8') } catch { /* ignore */ } }
const today = () => new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' })
function log(line) {
  const s = `[${new Date().toISOString()}] ${line}`
  if (!DRY) { try { ensureHome(); writeFileSync(LOG, (existsSync(LOG) ? readFileSync(LOG, 'utf8') : '') + s + '\n') } catch { /* ignore */ } }
  console.log(s)
}

async function main() {
  if (!ENABLED && !DRY && !has('--force')) {
    console.log('主动聊天没开（偏好里 proactive.enabled=false）；要试就加 --dry 或 --force')
    return
  }
  const state = loadState()
  if (state.date !== today()) { state.date = today(); state.count = 0 }
  const nowH = Number(new Date().toLocaleString('en-US', { hour: '2-digit', hour12: false, timeZone: 'Asia/Shanghai' }))
  if (QUIET.includes(nowH) && !DRY && !has('--force')) { log(`现在 ${nowH} 点在安静时段，不开口`); return }
  if ((state.count || 0) >= MAX_DAY && !DRY) { log(`今天已经主动说了 ${state.count} 条，到上限`); return }
  const sinceMin = state.lastAt ? (Date.now() - state.lastAt) / 60000 : Infinity
  if (sinceMin < MIN_GAP && !DRY) { log(`离上次主动才 ${Math.round(sinceMin)} 分钟（下限 ${MIN_GAP}）`); return }

  const targets = []
  for (const d of DMS) targets.push({ kind: 'dm', to: d })
  for (const g of GROUPS) targets.push({ kind: 'group', to: g })
  if (!targets.length) { log('没有可主动说话的对象（proactive.dm / groupWhitelist 都空）'); return }

  const pick = targets[(state.count || 0) % targets.length]
  const b = await new Browser().launch({ headless: true })
  try {
    await b.setCookies(readCookieString(COOKIE))
    await openChat(b)
    await openConversation(b, pick.to)
    await sleep(1200)
    const ctx = await readRecent(b, 6)
    const opener = await draftOpener({ target: pick.to, context: ctx, kind: pick.kind })
    if (DRY) { log(`[dry] 会对 ${pick.to}（${pick.kind}）说：${opener.text}`); return }
    const sent = await sendMessage(b, { to: pick.to, text: opener.text })
    log(`主动对 ${pick.to}（${pick.kind}）：${opener.text} → sent=${sent.sent} appeared=${sent.appeared}${sent.error ? ' error=' + sent.error : ''}`)
    if (sent.ok) { state.count = (state.count || 0) + 1; state.lastAt = Date.now(); saveState(state) }
  } finally {
    await b.close()
  }
}

main().catch((e) => { log(`崩了：${String(e?.message ?? e)}`); process.exit(1) })
