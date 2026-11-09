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
 *   · 私信里可以叫「昵称」，群里不行（reply.mjs 的 kind 管着）
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
const SELF = selfNick() || '小鲸鱼'

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

          // ⭐ 指纹表代替锚点：不依赖"读到哪儿"，每条消息只处理一次
          //    指纹 = 发送者 + 正文（截断）；同一条消息 2 小时内不再触发模型
          const fpOf = (m) => String(m.who || '') + '|' + String(m.text || '').replace(/\s+/g, '').slice(0, 60)
          const seenList = Array.isArray(st.seen) ? st.seen : []
          const seenMap = new Map(seenList.map((x) => [x.fp, x.at]))
          const seenFresh = (fp) => {
            const at = seenMap.get(fp)
            return at && Date.now() - at < 2 * 3600_000
          }

          if (!st.seen) {
            // 首次接上：把当前已有的消息全部标记为"已看过"，避免一上来就回一堆
            st.seen = msgs.map((m) => ({ fp: fpOf(m), at: Date.now() })).slice(-200)
            saveState(state)
            log(`[${peer}] 首次接上，已记录 ${st.seen.length} 条`)
            continue
          }

          const fresh = msgs.filter((m) => !seenFresh(fpOf(m)))
          // 只挑对方发来的
          const isSelf = (m) => !m.who || m.who === SELF || m.who === '__self__'
          const mine = new Set(sentList(state).map((t) => String(t).trim()))
          const isOurs = (m) => {
            // 🔴 先看标记：读消息时用自己的气泡位置判定，__self__ = 我发的
            if (m.who === '__self__') return true
            if (m.who === '__peer__') return false
            const t = String(m.text || '').trim()
            if (mine.has(t)) return true                       // 文本能对上 ⇒ 自己刚发的
            const w = String(m.who || '')
            if (w && (w === SELF || w === selfNick() || w.indexOf('小鲸鱼') >= 0)) return true
            // 认不出发送者：当对方处理（标记缺失说明是对方消息）
            return false
          }
          const incoming = fresh.filter((m) => m.text && !isOurs(m))

          // 记入指纹表（只留最近 200 条）
          for (const m of msgs) {
            const fp = fpOf(m)
            if (!seenMap.has(fp)) seenMap.set(fp, Date.now())
          }
          st.seen = [...seenMap.entries()]
            .map(([fp, at]) => ({ fp, at }))
            .filter((x) => Date.now() - x.at < 2 * 3600_000)
            .slice(-200)
          saveState(state)
          if (!incoming.length) { log(`[${peer}] 无新的对方消息`); continue }

            // ⭐ 记住对方最近发来的视频 id（后面说「评论区 @ 我」时用它当目标）
            for (const m of incoming) {
              const t = String(m.text || '')
              const idHit = t.match(/(?:video\/|\/share\/video\/|modal_id=)(\d{15,25})/)
              if (idHit) { state.lastVideo = idHit[1]; saveState(state); log(`[${peer}] 记下视频 ${idHit[1]}`) }
            }

            // ⭐ 任务指令：真去干活（评论里 @ 你 / 找视频 / 分享卡片），不是嘴上说说
            const joinText = incoming.map((m) => String(m.text || '')).join(' ')
            const allowCommentAt = prefs.allowCommentAt === true
            const askedComment = /评论区|评论/.test(joinText) && /@|艾特/.test(joinText)
            // 上次因为限速/失败没做完的活，这次说「试试/现在/再来」就接着干
            const retryWords = /试试|再试|现在|可以了|弄吧|搞吧|继续|来吧/.test(joinText)
            const pending = state.pendingTask && (Date.now() - (state.pendingTask.at || 0) < 6 * 3600_000) ? state.pendingTask : null
            const wantsComment = allowCommentAt && (askedComment || (pending && pending.comment && retryWords))
            const wantsShare = /分享|发给我|转给我|发过来/.test(joinText) || Boolean(pending && pending.share && retryWords)
            const wantsVideo = /视频/.test(joinText) && /找|随便|推荐|挑|来一个/.test(joinText)
            if (wantsComment || (wantsVideo && wantsShare)) {
              const ownerNick = String((prefs.owner && (prefs.owner.nick || prefs.owner.douyinNick)) || 'Sora')
              let vid = (pending && pending.vid) || state.lastVideo || ''
              let title = ''
              let didComment = false
              let commentMsg = ''
              try {
                // 没有指定视频 → 自己去推荐流里挑一条
                if (!vid) {
                  const rr = await fetch('http://127.0.0.1:3110/recommend', {
                    method: 'POST', headers: { 'content-type': 'application/json' },
                    body: JSON.stringify({ top: 3, pages: 2 }),
                  })
                  const rj = await rr.json()
                  const pick = (rj && rj.list && rj.list[0]) || null
                  if (pick) { vid = String(pick.aweme_id || ''); title = String(pick.desc || '').slice(0, 30) }
                  log(`[${peer}] 自己挑了视频 ${vid}（${title}）`)
                }
                if (!vid) {
                  commentMsg = '我这边没拉到视频，等我下次刷到了再弄' 
                } else if (wantsComment) {
                  const cr = await fetch('http://127.0.0.1:3110/comment/mention', {
                    method: 'POST', headers: { 'content-type': 'application/json' },
                    body: JSON.stringify({ aweme: vid, name: ownerNick, text: '来啦，看到你说的了', confirm: true }),
                  })
                  const cj = await cr.json()
                  didComment = !!(cj && cj.ok && (cj.sent !== false))
                  commentMsg = didComment ? `评论里 @ 你了（《${title || vid}》底下）` : ('评论没发出去：' + ((cj && cj.error) || '原因不明'))
                  log(`[${peer}] 评论结果：${commentMsg}`)
                }
                // 要分享就发卡片
                let shareMsg = ''
                if (vid && wantsShare) {
                  const sr = await fetch('http://127.0.0.1:3110/share', {
                    method: 'POST', headers: { 'content-type': 'application/json' },
                    body: JSON.stringify({ aweme: vid, to: peer, reason: '这个刷到了，觉得你会喜欢' }),
                  })
                  const sj = await sr.json()
                  const inner = sj && (sj.sent || sj)
                  shareMsg = inner && inner.sent ? '卡片也发你了' : ('卡片没发出去：' + ((inner && (inner.error || inner.reason)) || '未知原因'))
                  log(`[${peer}] 分享结果：${shareMsg}`)
              if (didComment || (inner && inner.sent)) {
                delete state.pendingTask
                saveState(state)
              }
                }
                // 没做成 → 记成待办，等对方说「现在试试」再继续
    if (vid && (!didComment || /没发出去|失败|先别发|上限/.test(commentMsg)) && allowCommentAt) {
      state.pendingTask = { vid, title, comment: true, share: wantsShare, at: Date.now() }
      saveState(state)
      log(`[${peer}] 记下待办：评论${wantsShare ? '+分享' : ''}（等下次"试试"）`)
    }
    const closedNote = (askedComment && !allowCommentAt) ? '评论里@你那件事我先关着（怕@错人），' : ''
              const replyText = (closedNote + [commentMsg, shareMsg].filter(Boolean).join('，')).replace(/^，|，$/, '') || '弄好了' 
                if (!DRY) { const s4 = await sendInPlace(b, { text: replyText }); if (s4.ok) { rememberSent(state, replyText); saveState(state) } }
              } catch (e) {
                log(`[${peer}] 任务指令失败：${String(e?.message ?? e)}`)
                if (!DRY) await sendInPlace(b, { text: '刚才没弄成，稍等再试' })
              }
              continue
            }

          const last = incoming[incoming.length - 1]

          // ⭐ 触发去重：同一条消息 30 分钟内不再回（不花 token，也不会重复说话）
          const trigSig = String(last.who || '') + '|' + String(last.text || '').slice(0, 80)
          const recentTrig = Array.isArray(state.recentTriggers) ? state.recentTriggers : []
          const seenTrig = recentTrig.find((x) => x && x.sig === trigSig && Date.now() - x.at < 1_800_000)
          if (seenTrig) {
            log(`[${peer}] 这条刚回过了（${Math.round((Date.now() - seenTrig.at) / 60000)} 分钟前），跳过`)
            continue
          }

          const draft = await draftReply({ who: last.who, text: last.text, context: msgs.slice(-6), kind: 'dm' })
          const text = sanitize(draft.text, 'dm')

          // ⭐ 内容去重：30 分钟内说过类似的话就不再发
          const norm = (t2) => String(t2 || '').replace(/[\s\p{P}\p{S}]/gu, '')
          const nowNorm = norm(text)
          if (state.lastNorm && state.lastNorm === nowNorm && Date.now() - (state.lastNormAt || 0) < 1_800_000) {
            log(`[${peer}] 这句话刚说过，跳过`)
            continue
          }

          if (DRY) { log(`[dry][${peer}] 会回：${text}`); continue }
          // ③ 发送前回读校验：如果最近几条里已经有这句，就不再发（幂等）
          try {
            const recent = await readRecent(b, 3)
            if (recent.some((m) => norm(m.text) === nowNorm)) {
              log(`[${peer}] 回读发现这句已经发过，跳过`)
              continue
            }
          } catch { /* 读失败就照发 */ }

          const sent = await sendInPlace(b, { text })
          if (sent.ok) {
            rememberSent(state, text)
            state.lastNorm = norm(text)
            state.lastNormAt = Date.now()
            state.recentTriggers = (Array.isArray(state.recentTriggers) ? state.recentTriggers : [])
              .concat([{ sig: trigSig, at: Date.now() }])
              .filter((x) => x && Date.now() - x.at < 1_800_000)
              .slice(-30)
            saveState(state)
          }
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
