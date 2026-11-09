/**
 * lib/plan.mjs —— 每日额度与自动计划（对标 dsh-douyin-scroll 的那套）。
 *
 *   plan = { enabled, times: ['09:00','20:00'], perDay, autoSend }
 *   额度：每天推荐条数上限（自动 + 手动合计算进 perDay，手动不受自动计划暂停影响）
 *   计数：stats.json 里的 recommend_auto / recommend_manual
 */
import { load as loadPrefs } from './prefs.mjs'

export const DEFAULT_PLAN = {
  enabled: false,
  times: ['09:00', '20:00'],
  perDay: 10,
  /** 每次跑几条（用户定的：3 条就够） */
  perRun: 3,
  autoSend: false,
}

export function getPlan() {
  const prefs = loadPrefs()
  return { ...DEFAULT_PLAN, ...(prefs.plan || {}) }
}

/** 给面板用的：今日额度状况 */
export function quota(todayStats = {}) {
  const plan = getPlan()
  const auto = Number(todayStats.recommend_auto) || 0
  const manual = Number(todayStats.recommend_manual) || 0
  return {
    plan,
    auto,
    manual,
    total: auto + manual,
    perDay: plan.perDay,
    left: Math.max(0, plan.perDay - (auto + manual)),
    paused: plan.enabled !== true,
  }
}

/** 现在这个分钟是不是计划里的时间（HH:MM 精确到分钟） */
export function isPlanTime(now = new Date()) {
  const plan = getPlan()
  if (plan.enabled !== true) return false
  const hh = String(now.getHours()).padStart(2, '0')
  const mm = String(now.getMinutes()).padStart(2, '0')
  return (plan.times || []).includes(hh + ':' + mm)
}

/** 下一次自动运行时间（HH:MM，今天没了就看明天最近的一档） */
export function nextRunAt(now = new Date()) {
  const plan = getPlan()
  if (plan.enabled !== true) return null
  const times = (plan.times || []).filter((t) => /^\d{2}:\d{2}$/.test(t)).sort()
  if (!times.length) return null
  const cur = now.getHours() * 60 + now.getMinutes()
  for (const t of times) {
    const [h, m] = t.split(':').map(Number)
    if (h * 60 + m > cur) return t
  }
  return times[0] + '（明天）'
}
