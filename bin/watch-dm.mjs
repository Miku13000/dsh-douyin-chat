/**
 * bin/watch-dm.mjs —— 私信监听：读未读 → 生成回复 → 就地发出去。
 *
 *   node bin/watch-dm.mjs --once --dry     # 只看会回什么，不发
 *   node bin/watch-dm.mjs --peers "Sora"   # 指定监听谁（默认读 prefs.dmPeers）
 *
 * 规矩（跟群聊对齐）：
 *   · 只回**对方发来的新消息**，自己发的不理
 *   · 每条消息只回一次（靠 anchor 去重）
 *   · 同一人两次回复之间隔 replyGapSec（默认 3 秒，私信可以快一点）
 *   · 私信里可以叫「宝宝」，群里不行（reply.mjs 的 kind 管着）
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Browser, readCookieString } from '../lib/cdp.mjs'
import { openChat, openConversation, readRecent, sendInPlace } from '../lib/douyin.mjs'
import { draftReply, sanitize } from '../lib/reply.mjs'
import { cookieFile, selfNick } from '../lib/account.mjs'
import { ensureHome, PATHS } from '../lib/paths.mjs'
import { load as loadPrefs } from '../lib/prefs.mjs'
import { arg, flag, sleep } from '../lib/util.mjs'

const ONCE = flag('--once') || flag('--dry')
const DRY = flag('--dry')
const INTERVAL = Math.max(4, Number(arg('--interval', '8')) || 8)
const STATE = join(PATHS.home, 'watch-dm-state.json')
const LOG = join(PATHS.home, 'watch-dm.log')

const prefs = loadPrefs()
const SELF = selfNick() || '小鲸鱼deepseek'

/** 自己最近发过的话（私信 DOM 里「我/对方」的类名不可靠，用文本比对兜底） */
const SENT_KEEP = 30
function sentList(state) {
  return Array.isArray(state.sent) ? state.sent : []
}
function rememberSent(state, text) {
  const t = String(text || '').trim()
  if (!t) return
  const list = sentList(state).concat([t]).slice(-SENT_KEEP)
  state.sent = list
}
const peers = (arg('--peers') || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)
const watchPeers = peers.length
  ? peers
  : (Array.isArray(prefs.dmPeers) ? prefs.dmPeers.map((p) => (typeof p === 'string' ? p : p?.nick)).filter(Boolean) : [])

if (!watchPeers.length) {
  console.log(JSON.stringify({ ok: false, error: '没有要监听的私信对象：配 prefs.dmPeers 或用 --peers' }))
  process.exit(2)
}

const loadState = () => { try { return existsSync(STATE) ? JSON.parse(readFileSync(STATE, 'utf8')) : {} } catch { return {} } }
const saveState = (s) => { ensureHome(); try { writeFileSync(STATE, JSON.stringify(s, null, 2), 'utf8') } catch { /* 记不下来不挡回话 */ } }
function log(line) {
  const s = `[${new Date().toISOString()}] ${line}`
  if (!DRY) { try { ensureHome(); writeFileSync(LOG, (existsSync(LOG) ? readFileSync(LOG, 'utf8') : '') + s + '\n') } catch { /* 日志写不了不挡主流程 */ } }
  console.log(s)
}

const sig = (m) => `${m.who || ''}|${String(m.text || '').slice(0, 120)}`

async function main() {
  const state = loadState()
  const b = await new Browser().launch({ headless: true })
  try {
    await b.setCookies(readCookieString(cookieFile()))
    await openChat(b)
    log(`私信监听开始：${watchPeers.join('、')}（每 ${INTERVAL}s 一轮）`)

    for (;;) {
      for (const peer of watchPeers) {
        const st = (state[peer] = state[peer] || { anchor: '', replied: 0 })
        try {
          await openConversation(b, peer)
          await sleep(800)
          const msgs = await readRecent(b, 12)
          if (!msgs.length) { log(`[${peer}] 读不到消息`); continue }

          const newest = sig(msgs[msgs.length - 1])
          if (!st.anchor) {
            st.anchor = newest
            log(`[${peer}] 首次接上，锚点 = ${newest.slice(0, 40)}`)
            saveState(state)
            continue
          }
          const idx = msgs.map(sig).lastIndexOf(st.anchor)
          const fresh = idx >= 0 ? msgs.slice(idx + 1) : msgs.slice(-3)
          // 只挑对方发来的
          const isSelf = (m) => !m.who || m.who === SELF || m.who === '__self__'
          const mine = new Set(sentList(state).map((t) => String(t).trim()))
          const isOurs = (m) => {
            const t = String(m.text || '').trim()
            if (mine.has(t)) return true                       // 文本能对上 ⇒ 自己刚发的
            return m.who === SELF || m.who === ''              // 有昵称且是自己，或读不到发送者
          }
          const incoming = fresh.filter((m) => m.text && !isOurs(m))
          st.anchor = newest
          saveState(state)
          if (!incoming.length) { log(`[${peer}] 无新的对方消息`); continue }

          const last = incoming[incoming.length - 1]
          const draft = await draftReply({ who: last.who, text: last.text, context: msgs.slice(-6), kind: 'dm' })
          const text = sanitize(draft.text, 'dm')
          if (DRY) { log(`[dry][${peer}] 会回：${text}`); continue }
          const sent = await sendInPlace(b, { text })
          if (sent.ok) { rememberSent(state, text); saveState(state) }
          log(`[${peer}] 回 ${last.who}：${text} → sent=${sent.sent}${sent.error ? ' error=' + sent.error : ''}`)
          if (sent.ok) { st.replied += 1; st.lastReplyAt = Date.now() }
          await sleep(1500)
        } catch (e) {
          log(`[${peer}] 出错：${String(e?.message ?? e)}`)
        }
      }
      if (ONCE) break
      await sleep(INTERVAL * 1000)
    }
  } finally {
    saveState(state)
    await b.close()
  }
}

main().catch((e) => { log(`崩了：${String(e?.message ?? e)}`); process.exit(1) })
