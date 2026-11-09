/**
 * lib/recommend.mjs —— 拉推荐候选并打分（只读、不签名、不碰写接口）。
 *
 * 借道 dsh-douyin-scroll 的 tools/forward-pick.py：它用的是 web 端**不签名**的只读接口
 *   /aweme/v1/web/tab/feed/        推荐流
 *   /aweme/v1/web/hot/search/list/ 热榜
 * 判断只用 JSON 字段（desc / 作者 / 时长 / 点赞·评论·收藏·转发），不看画面。
 */
import { readFileSync } from 'node:fs'

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36'
const COMMON = 'device_platform=webapp&aid=6383&channel=channel_pc_web&pc_client_type=1'
  + '&version_code=190500&version_name=19.5.0&cookie_enabled=true'
  + '&screen_width=1920&screen_height=1080&browser_language=zh-CN'
  + '&browser_platform=Win32&browser_name=Chrome&browser_version=141.0.0.0'
  + '&engine_name=Blink&engine_version=141.0.0.0&os_name=Windows&os_version=10'
  + '&platform=PC&downlink=10&effective_type=4g&round_trip_time=50'

const readCookie = (file) => {
  try { return readFileSync(file, 'utf8').replace(/^\uFEFF/, '').trim() } catch { return '' }
}

async function getJSON(url, cookie) {
  const res = await fetch(url, {
    headers: {
      'user-agent': UA,
      cookie,
      accept: 'application/json, text/plain, */*',
      'accept-language': 'zh-CN,zh;q=0.9',
      referer: 'https://www.douyin.com/',
      origin: 'https://www.douyin.com',
    },
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return res.json()
}

/** 递归找所有长成 aweme 的对象（有 aweme_id + desc 或 statistics） */
function walkAwemes(obj, bag) {
  if (Array.isArray(obj)) { for (const v of obj) walkAwemes(v, bag); return }
  if (obj && typeof obj === 'object') {
    if (obj.aweme_id && (obj.desc !== undefined || obj.statistics)) { bag.set(String(obj.aweme_id), obj); return }
    for (const v of Object.values(obj)) walkAwemes(v, bag)
  }
}

const stat = (a, k) => { const s = a.statistics || {}; const n = Number(s[k] || 0); return Number.isFinite(n) ? n : 0 }

/** 按「人设 → 视频偏好」调整分数：关键词/分类/作者加分，屏蔽词直接压到底 */
function prefAdjust(desc, author) {
  const prefs = (() => { try { return loadPrefs() } catch { return {} } })()
  const v = prefs.videoPrefs || {}
  const text = String(desc || '') + ' ' + String(author || '')
  let bonus = 0
  for (const k of (v.keywords || [])) if (k && text.includes(k)) bonus += 1.5
  for (const k of (v.channels || [])) if (k && text.includes(k)) bonus += 0.8
  for (const k of (v.authors || [])) if (k && text.includes(k)) bonus += 2
  for (const k of (v.avoid || [])) if (k && text.includes(k)) bonus -= 6
  return bonus
}

export async function recommend({ cookieFile, pages = 3, top = 10, minDescLen = 12, minComments = 3 } = {}) {
  const cookie = readCookie(cookieFile)
  if (!cookie) return { ok: false, error: '没有抖音 Cookie（先 douyin_login_save 或用已有登录态）' }

  const bag = new Map()
  const meta = []
  for (let i = 1; i <= Math.max(1, Math.min(5, pages)); i++) {
    try {
      const j = await getJSON(`https://www.douyin.com/aweme/v1/web/tab/feed/?${COMMON}&count=20&refresh_index=${i}`, cookie)
      const before = bag.size
      walkAwemes(j, bag)
      meta.push({ src: `feed#${i}`, added: bag.size - before })
    } catch (e) { meta.push({ src: `feed#${i}`, error: String(e?.message ?? e) }) }
  }
  try {
    const j = await getJSON(`https://www.douyin.com/aweme/v1/web/hot/search/list/?${COMMON}&detail_list=1`, cookie)
    const before = bag.size
    walkAwemes(j, bag)
    meta.push({ src: 'hot-search', added: bag.size - before })
  } catch (e) { meta.push({ src: 'hot-search', error: String(e?.message ?? e) }) }

  const rows = []
  for (const [id, a] of bag) {
    const desc = String(a.desc || '').trim()
    if (!desc) continue
    const dur = Number(a.duration || a.video?.duration || 0)
    if (dur && dur < 12000) continue // 太短多半是模板/广告
    const digg = stat(a, 'digg_count')
    const comment = stat(a, 'comment_count')
    const collect = stat(a, 'collect_count')
    const share = stat(a, 'share_count')
    if (desc.length < minDescLen && comment < minComments) continue
    // 打分：互动密度为主，评论和收藏加权（愿意聊/愿意存的内容更值得推）
    const score = Math.log10(1 + digg) * 2 + Math.log10(1 + comment) * 3 + Math.log10(1 + collect) * 2 + Math.log10(1 + share)
      + prefAdjust(desc, a.author?.nickname || '')
    rows.push({
      aweme_id: id,
      desc: desc.slice(0, 120),
      author: a.author?.nickname || '',
      duration_s: Math.round(dur / 1000),
      digg, comment, collect, share,
      score: Math.round(score * 100) / 100,
      url: `https://www.douyin.com/video/${id}`,
    })
  }
  rows.sort((a, b) => b.score - a.score)
  return { ok: true, total: bag.size, kept: rows.length, sources: meta, list: rows.slice(0, Math.max(1, top)) }
}
