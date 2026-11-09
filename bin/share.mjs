/**
 * bin/share.mjs —— 分享一条抖音视频给别人。
 *
 * 两种方式：
 *   card（默认）：用抖音自己的「分享给朋友」发**卡片**（点得开、有封面）
 *   text：退化成私信文本（标题 + 链接 + 理由）
 *
 *   node bin/share.mjs --aweme 7704318738128047400 --reason "这个好看"
 *   node bin/share.mjs --aweme 7704318738128047400 --mode text --force
 *
 * 偏好（lib/prefs.mjs → share）：
 *   enabled / targets / maxPerDay / minGapMin / withReason / mode / toId
 */
import { Browser, readCookieString } from '../lib/cdp.mjs'
import { shareCard } from '../lib/sharecard.mjs'
import { checkQuota, markShared, buildShareText } from '../lib/share.mjs'
import { cookieFile } from '../lib/account.mjs'
import { load as loadPrefs } from '../lib/prefs.mjs'
import { runBin, arg, flag, emit } from '../lib/util.mjs'

const awemeId = arg('--aweme')
const reason = arg('--reason')
const title = arg('--title')
const force = flag('--force')
const dry = flag('--dry')

if (!awemeId) { emit({ ok: false, error: '缺 --aweme（视频 id）' }); process.exit(2) }

const prefs = loadPrefs()
const cfg = prefs.share || {}
const to = arg('--to') || (Array.isArray(cfg.targets) && cfg.targets[0]) || prefs.dmPeers?.[0] || ''
if (!to) { emit({ ok: false, error: '没有分享对象：给 --to，或在 prefs.share.targets 里配' }); process.exit(2) }

const mode = arg('--mode', cfg.mode || 'card')

// 群分享先关掉（使用者 2026-11-09：私聊留着，群聊暂时删除）
const groupNames = (prefs.groupWhitelist || []).map((g) => (typeof g === 'string' ? g : g?.name)).filter(Boolean)
const isGroup = groupNames.includes(to)
if (isGroup && cfg.allowGroups !== true && !flag('--allow-group')) {
  emit({ ok: false, skipped: true, error: '群分享已关闭（prefs.share.allowGroups=false）', to })
  process.exit(0)
}
const text = buildShareText({ awemeId, reason: cfg.withReason === false ? '' : reason, title: title || '' })
// 试运行只看不下单：不占用额度、也不受间隔限制
if (dry) { emit({ ok: true, dry: true, mode, to, text }); process.exit(0) }

const gate = checkQuota()
if (!gate.ok && !force) { emit({ ok: false, skipped: true, reason: gate.reason }); process.exit(0) }

if (mode === 'card') {
  const b = await new Browser().launch({ headless: true })
  try {
    await b.setCookies(readCookieString(cookieFile()))
    const card = await shareCard(b, { awemeId, who: to, toId: cfg.toId || '' })
    if (card.ok) {
      const st = markShared()
      emit({ ok: true, via: 'card', to, awemeId, todayCount: st.count })
      process.exit(0)
    }
    if (cfg.fallbackText === false) { emit({ ok: false, via: 'card', error: card.error, detail: card }); process.exit(1) }
    // 卡片失败就退回文本，不让这次分享白丢
    const sent = await runBin('send.mjs', ['--to', to, '--text', text])
    if (sent?.ok && sent.sent) {
      const st = markShared()
      emit({ ok: true, via: 'text-fallback', to, awemeId, text, cardError: card.error, todayCount: st.count })
      process.exit(0)
    }
    emit({ ok: false, error: '卡片和文本都没发出去', cardError: card.error, textError: sent?.error })
    process.exit(1)
  } finally { await b.close() }
}

const sent = await runBin('send.mjs', ['--to', to, '--text', text])
if (sent?.ok && sent.sent) {
  const st = markShared()
  emit({ ok: true, via: 'text', to, awemeId, text, todayCount: st.count })
} else {
  emit({ ok: false, to, awemeId, text, error: sent?.error || '发送没成功', raw: sent })
  process.exit(1)
}
