/**
 * bin/watch.mjs —— 监听循环：「被 @ 就必须回」，支持多个群、可选参与方式。
 *
 * 2026-11-09 两处修正（实测踩出来的）：
 *   ① 页面不会自己更新 —— 每轮都要重新打开会话，隔几轮整页刷新一次。
 *   ② 去重不能按「谁+原话」—— 改成**按最新一条定位**（锚点之后才算新消息）。
 *
 * 用法：
 *   node bin/watch.mjs --groups "Yuuka的后宫,别的群" --interval 25
 *   node bin/watch.mjs --to "Yuuka的后宫" --once --dry
 *   （不给 --groups/--to 时，读偏好里的 groupWhitelist）
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Browser, readCookieString } from '../lib/cdp.mjs'
import { cookieFile, selfNick } from '../lib/account.mjs'
import { openChat, openConversation, openConversationWithId, listConversations, readRecent, sendMessage, sendInPlace, hasEditor } from '../lib/douyin.mjs'
import { normalize as normalizeGroups, names as groupNames } from '../lib/groups.mjs'
import { save as savePrefs } from '../lib/prefs.mjs'
import { draftReply, sanitize } from '../lib/reply.mjs'
import { speechLevel } from '../lib/valley.mjs'
import { record as recordTraffic, phase as trafficPhase } from '../lib/traffic.mjs'
import { ensureHome, PATHS } from '../lib/paths.mjs'
import { load as loadPrefs } from '../lib/prefs.mjs'

const arg = (n, d = '') => { const i = process.argv.indexOf(n); return i < 0 ? d : (process.argv[i + 1] ?? d) }
const has = (f) => process.argv.includes(f)
const INTERVAL = Math.max(4, Number(arg('--interval', '6')) || 6)
const MAX_REPLY = Math.max(1, Number(arg('--max', '1')) || 1)
const ONCE = has('--once') || has('--dry')
const DRY = has('--dry')
const SELF = selfNick() || process.env.FISH_SELF_NICK || '小鲸鱼'
const COOKIE = cookieFile()
const STATE = join(PATHS.home, 'watch-state.json')
const LOG = join(PATHS.home, 'watch.log')

const prefs = loadPrefs()
const groups = (arg('--groups') || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)
  .concat(arg('--to') ? [arg('--to')] : [])
const watchList = groups.length ? groups : groupNames(prefs.groupWhitelist)
if (!watchList.length) {
  console.log(JSON.stringify({ ok: false, error: '没有要监听的群：用 --groups "A,B" 或 --to "A"，或在偏好里填 groupWhitelist' }))
  process.exit(2)
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const sig = (m) => `${m.who || ''}|${String(m.text || '').slice(0, 120)}`
const ts = () => new Date().toISOString()
function log(line) {
  const s = `[${ts()}] ${line}`
  if (!DRY) { try { ensureHome(); writeFileSync(LOG, (existsSync(LOG) ? readFileSync(LOG, 'utf8') : '') + s + '\n') } catch { /* 日志写不了不挡主流程 */ } }
  console.log(s)
}
const loadState = () => { try { return existsSync(STATE) ? JSON.parse(readFileSync(STATE, 'utf8')) : {} } catch { return {} } }
const saveState = (s) => { ensureHome(); try { writeFileSync(STATE, JSON.stringify(s, null, 2), 'utf8') } catch { /* 记不下来不挡回话 */ } }

/**
 * 群名同步：名字会改，所以以**会话 id**为准。
 * 做法：把可见会话逐个点开、抓 id；已知 id 的名字和现在不一致，就更新。
 */
async function syncGroups(b) {
  const known = normalizeGroups(prefs.groupWhitelist)
  const ids = known.filter((g) => g.id)
  if (!ids.length) return known
  const seen = []
  let names = []
  try { names = await listConversations(b) } catch { return known }
  for (const name of names.slice(0, 12)) {
    const opened = await openConversationWithId(b, name)
    if (opened?.conversationId) seen.push({ id: opened.conversationId, name })
    await sleep(600)
  }
  // 只更新**已知群号**对应的名字；不要把私聊（Sora/Shaula）当成群塞进来
  let changed = false
  for (const s of seen) {
    const hit = known.find((g) => g.id && g.id === s.id)
    if (hit && s.name && hit.name !== s.name) {
      log(`群名同步：${hit.name} → ${s.name}（群号 ${hit.id}）`)
      hit.name = s.name
      changed = true
    }
  }
  if (changed) {
    prefs.groupWhitelist = known
    savePrefs({ groupWhitelist: known })
  }
  return known
}

async function main() {
  const state = loadState()
  const b = await new Browser().launch({ headless: true })
  let ticks = 0
  try {
    await b.setCookies(readCookieString(COOKIE))
    await openChat(b)
    log(`监听开始：${watchList.join('、')}（参与方式=${prefs.participation || 'mention'}，每 ${INTERVAL}s 一轮）`)
  try {
    const synced = await syncGroups(b)
    const fresh = groupNames(synced)
    if (fresh.length) { watchList.length = 0; watchList.push(...fresh) }
  } catch (e) { log('群名同步跳过：' + String(e?.message ?? e)) }

  let currentConv = ''   // 当前浏览器里开着哪个会话（按名字判，别靠"有没有输入框"）
    for (;;) {
      ticks += 1
      if (ticks % 5 === 0) await openChat(b)

      // 谷时判断：只在谷时活动时，非谷时只看不回
      const gate = speechLevel(prefs, new Date().getHours(), trafficPhase())
      const reduced = gate.level === 'reduced'
      if (gate.level === 'silent' && !DRY) { log('当前不出声（' + gate.reason + '）'); await sleep(INTERVAL * 1000); continue }

      for (const g of watchList) {
        const st = (state[g] = state[g] || { anchor: '', replied: 0, lastReplyAt: 0 })
        try {
          // 已经开在这个群就不重复点开（点开一次要 1~2 秒）
          if (true) {   // 每轮都切：靠 currentConv 猜会读到别的群
            currentConv = ''
            const conv = await openConversation(b, g)
            if (!conv || conv.ok === false) {
              log(`[${g}] 打不开这个会话（可能不在会话列表里），本轮跳过`)
              continue
            }
            currentConv = g
            await sleep(600)
          }
          let msgs = await readRecent(b, 15)
      try { if (Array.isArray(msgs) && msgs.length) recordTraffic(msgs.length) } catch { /* 统计失败不影响监听 */ }
          for (let tryI = 0; tryI < 3 && !msgs.length; tryI++) {
            await sleep(1200)
            await openConversation(b, g)
            await sleep(800)
            msgs = await readRecent(b, 15)
          }
          if (!msgs.length) { log(`[${g}] 第 ${ticks} 轮：读不到消息（重试 3 次仍空）`); continue }

          // 锚点只取「最后一条别人说的话」：自己的消息不能当锚点，否则永远判定无新消息
          const isMineMsg = (m) => m.who === SELF || m.who === '__self__' || String(m.who || '').includes('小鲸鱼')
          const mineOrEmpty = msgs.filter((m) => !isMineMsg(m))
          const newest = mineOrEmpty.length ? sig(mineOrEmpty[mineOrEmpty.length - 1]) : sig(msgs[msgs.length - 1])
          if (!st.anchor) {
            // 首次接上：锚点设在「倒数第二条别人说的话」，让最后一条（可能是 @ 我们的）当新消息处理
            const nonSelfMsgs = msgs.filter((m) => m.who !== SELF && m.who !== '__self__' && !String(m.who || '').includes('小鲸鱼'))
            const anchorMsg = nonSelfMsgs.length > 1 ? nonSelfMsgs[nonSelfMsgs.length - 2] : null
            st.anchor = anchorMsg ? sig(anchorMsg) : ''
            saveState(state)
            log(`[${g}] 首次接上，锚点 = ${newest.slice(0, 40)}`)
            if (!st.anchor) { st.anchor = newest; saveState(state); continue }
          }
          if (newest === st.anchor) { log(`[${g}] 第 ${ticks} 轮：无新消息`); continue }

          const idx = msgs.map(sig).lastIndexOf(st.anchor)
          const freshAll = idx >= 0 ? msgs.slice(idx + 1) : msgs.slice(-6)
          const fresh = freshAll.filter((m) => !isMineMsg(m))
          const mode = prefs.participation || 'mention'
          // 有些消息行不带发送者名（同一人连发时省略），回溯最近的具名消息补上，不然 @ 就丢了
          const whoOf = (m) => {
            if (m.who) return m.who
            const i = msgs.indexOf(m)
            for (let k = i - 1; k >= 0 && k >= i - 4; k--) if (msgs[k].who) return msgs[k].who
            return ''
          }
          const isNamed = (m) => /@\s*(小鲸鱼|小鱼|小满)/.test(String(m.text || '')) || /小鲸鱼|小满|鱼鱼/.test(String(m.text || ''))
          // 忙的时候少说：冷却拉长 3 倍
          const coolMs = (Number(prefs.naturalCooldownSec) || 120) * 1000 * (reduced ? 3 : 1)
          const coolOk = () => Date.now() - (st.lastUnsolicited || 0) > coolMs
          const targets = []
          // 先保证：被叫到的必须回
          for (const m of fresh) {
            if (m.who === SELF || m.who === '__self__' || !m.who) continue
            if (isNamed(m)) targets.push({ ...m, who: whoOf(m) })
          }
          // 再考虑：像 QQ 那样，没叫它也能自然插一句（一轮最多一句，且有冷却）
          // 忙的时候不主动插话，只回被叫到的
          if (!targets.length && mode !== 'mention' && !reduced) {
            const cand = fresh.filter((m) => m.who && m.who !== SELF && m.who !== '__self__' && /[?？]|吗|怎么|什么|为啥|是不是|有没有|谁/.test(String(m.text || '')))
            if (cand.length && coolOk() && Math.random() < (Number(prefs.naturalChance) || 0.35)) {
              const pick = cand[cand.length - 1]
              targets.push({ ...pick, who: whoOf(pick), unsolicited: true })
            }
          }
          const picked = targets.slice(-(reduced ? 1 : MAX_REPLY))
          log(`[${g}] 新增 ${fresh.length} 条，其中要回的 ${picked.length} 条`)
          st.anchor = newest
          saveState(state)

          for (const t of picked) {
            // ⭐ 省钱：同样的触发消息 30 分钟内不再调模型（避免"生成完再丢掉"白花 token）
            const trigSig = `${String(t.who || '')}|${String(t.text || '').slice(0, 60)}`
            const recentTrig = Array.isArray(state.recentTriggers) ? state.recentTriggers : []
            const seen = recentTrig.find((x) => x && x.sig === trigSig && Date.now() - x.at < 1_800_000)
            if (seen) { log(`[${g}] 这条消息刚回过了（${Math.round((Date.now() - seen.at) / 60000)} 分钟前），跳过省 token`); continue }
            // 超短消息（一个表情、一个字）且没点名 → 不值得花 token 生成
            const tinyMsg = String(t.text || '').trim().replace(/[\\s\\p{P}\\p{S}]/gu, '').length <= 2
            if (tinyMsg && !isNamed(t)) { log(`[${g}] 超短消息（${t.text}），跳过省 token`); continue }
            const draft = await draftReply({ who: t.who, text: t.text, context: msgs.slice(-6), kind: 'group' })
            // ⭐ 群聊 → 私聊：群里有人明确要私信，就去发一条私信（只对已有会话的人）
            const wantsDm = /私聊|私信|发给我|单独发/.test(String(t.text || ''))
            let dmResult = null
            if (wantsDm && !DRY) {
              const target = (Array.isArray(prefs.dmPeers) && prefs.dmPeers.find((p) => (typeof p === 'string' ? p : p?.nick) === t.who)) || null
              if (target) {
                dmResult = await sendMessage(b, { to: t.who, text: '在，私聊这边说。' })
                log(`[${g}] 群→私聊 ${t.who}：sent=${dmResult.sent}${dmResult.error ? ' error=' + dmResult.error : ''}`)
              } else {
                log(`[${g}] 群→私聊 ${t.who}：没有私信会话，跳过`)
              }
            }
            if (DRY) { log(`[dry][${g}] 会回给 ${t.who}：${draft.text}${wantsDm ? '（并尝试私信）' : ''}`); continue }
            const text = dmResult?.sent ? '私信发了，收一下。' : draft.text
            // 群里一律不 @：像 QQ 那样正常说话，别每句都戳人
            // @ 谁：默认不 @；但使用者说「@一下 / 随便@ / 艾特一下」时，真 @ 一个
            let atWho = ''
            const askText = String(t.text || '')
            const wantsAt = /@|艾特/.test(askText) && /(一下|随便|个|谁|挑)/.test(askText)
            if (wantsAt) {
              const named = askText.match(/[@艾特]+\s*([\u4e00-\u9fa5A-Za-z0-9_]{2,12})/)
              const rawName = named && named[1] ? named[1] : ''
              // 消息里的 @ 很可能是 @ 我们自己的，别把自己当目标
              const isSelfName = rawName && (/小鲸鱼|小满|鱼鱼/.test(rawName) || rawName === String(SELF || '') || rawName.includes('deepseek'))
              const fromMsg = rawName && !isSelfName && !/一下|随便|谁|个|人/.test(rawName) ? rawName : ''
              if (fromMsg) {
                atWho = fromMsg
              } else {
                const selfName = String(SELF || '小鲸鱼deepseek')
                const speakers = [...new Set(fresh.map((m) => whoOf(m)).map((w) => String(w || '').trim()).filter((w) => w && w !== selfName && w !== '__self__' && w !== '__peer__' && !w.includes('小鲸鱼')))]
                // 自己挑：优先挑「不是正在说话的那个人」，别每回都 @ 使用者
                const others = speakers.filter((w) => w !== String(t.who || '').trim())
                const pool = others.length ? others : speakers
                if (pool.length) atWho = pool[Math.floor(Math.random() * pool.length)]
              }
              log(`[${g}] 使用者要求 @ 人 → 选 ${atWho || '(没找到可 @ 的对象)'}`)
            }
            // 同群 60 秒内最多回一条（防止一次读多行时连发；被点名的不拦）
            const namedHere = isNamed(t)
            if (!namedHere && Date.now() - (st.lastReplyAt || 0) < 60_000) {
              log(`[${g}] 60 秒内刚回过，这条先不回`)
              continue
            }
            const safeText = sanitize(draft.text, 'group')
            // 同一句话 5 分钟内别重复说（去掉标点/表情后比较）
            const normText = (t2) => String(t2 || '').replace(/[\s\p{P}\p{S}]/gu, '')
            const safeNorm = normText(safeText)
            if (state.lastNorm && state.lastNorm === safeNorm && Date.now() - (state.lastNormAt || 0) < 1_800_000) {
              log(`[${g}] 这句话刚说过，跳过`)
              continue
            }
            let sent = await sendInPlace(b, { text: safeText, at: atWho })
            if (!sent.ok && atWho) {
              // @ 不成功 → 退一步：先把编辑框清干净，再不带 @ 发一次（避免重复发）
              log(`[${g}] @${atWho} 没成功（${sent.error || '原因不明'}），清空后改成不 @ 发`)
              try {
                await b.eval(`(() => { const ed = [...document.querySelectorAll('div[contenteditable="true"]')].find((e) => /messageEditor/.test(e.className || '')); if (ed) { ed.focus(); document.execCommand('selectAll'); document.execCommand('delete') } return true })()`)
              } catch { /* 清不掉就算了 */ }
              await sleep(400)
              sent = await sendInPlace(b, { text: safeText })
            }
            if (!sent.ok) sent = await sendMessage(b, { to: g, text, at: '' })
            log(`[${g}] 回 ${t.who}：${text} → sent=${sent.sent} appeared=${sent.appeared}${sent.error ? ' error=' + sent.error : ''}`)
            if (sent.ok) { st.replied += 1; st.lastReplyAt = Date.now(); if (t.unsolicited) st.lastUnsolicited = Date.now() }
            state.recentTriggers = (Array.isArray(state.recentTriggers) ? state.recentTriggers : [])
              .concat([{ sig: trigSig, at: Date.now() }])
              .filter((x) => x && Date.now() - x.at < 1_800_000)
              .slice(-30)
            state.lastNorm = normText(safeText)
            state.lastNormAt = Date.now()
            await sleep(2500)
          }
          saveState(state)
        } catch (e) {
          log(`[${g}] 出错：${String(e?.message ?? e)}`)
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
