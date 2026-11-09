/**
 * lib/valley.mjs —— 谷时判断（跟 QQ 那边一套概念：谷时便宜/人少，峰时保守）。
 *
 *   windows: [{ start: 12, end: 14 }, { start: 18, end: 9 }]
 *   跨零点用 start > end 表示（18 点到次日 9 点）。
 */
export function inWindow(hour, { start, end }) {
  const h = Number(hour)
  const s = Number(start)
  const e = Number(end)
  if (!Number.isFinite(h) || !Number.isFinite(s) || !Number.isFinite(e)) return false
  if (s === e) return true
  if (s < e) return h >= s && h < e
  return h >= s || h < e
}

export function isValley(prefs, hour = new Date().getHours()) {
  const v = prefs?.valley || {}
  const wins = Array.isArray(v.windows) ? v.windows : []
  return wins.some((w) => inWindow(hour, w))
}

/**
 * 现在能不能出声：
 *   onlyValley 关着 → 永远能
 *   auto 打开     → 按实测活跃度：只有「空闲期」才出声（高峰期最容易被风控盯上）
 *   否则          → 按设置的谷时时段
 */
export function canSpeak(prefs, hour = new Date().getHours(), measured) {
  const v = prefs?.valley || {}
  if (v.onlyValley !== true) return { ok: true, reason: '' }

  if (v.auto === true && measured) {
    if (measured.phase === 'idle') return { ok: true, reason: '空闲期（实测 ' + measured.todayCount + ' 条/时）' }
    if (measured.phase === 'peak') return { ok: false, reason: '高峰期（实测 ' + measured.todayCount + ' 条/时）' }
    return { ok: false, reason: '普通时段（实测 ' + measured.todayCount + ' 条/时）' }
  }

  if (isValley(prefs, hour)) return { ok: true, reason: '谷时' }
  return { ok: false, reason: '不是谷时（' + hour + ' 点）' }
}

/**
 * 下一个转折点：给面板显示「当前高峰 · 下一空闲 18:00」这种提示用。
 *   mode: 'auto' 按实测历史每小时均值预测；否则按固定时段
 * 返回 { nextIdle: 'HH:00' | null, nextPeak: 'HH:00' | null }
 */
export function nextChange(prefs, now = new Date(), hourly = null) {
  const v2 = prefs?.valley || {}
  const curHour = now.getHours()

  const phaseAt = (h) => {
    if (v2.auto === true && hourly && hourly.days > 0) {
      const row = (hourly.hours || []).find((r) => r.hour === h)
      const avg = row ? row.avg : 0
      // 用历史均值把小时分成三档（阈值跟 lib/traffic 一致，简化成绝对量）
      const max = Math.max(1, ...(hourly.hours || []).map((r) => r.avg || 0))
      const ratio = avg / max
      if (ratio < 0.3) return 'idle'
      return 'peak'
    }
    return isValley(prefs, h) ? 'idle' : 'peak'
  }

  let nextIdle = null
  let nextPeak = null
  for (let step = 1; step <= 24; step++) {
    const h = (curHour + step) % 24
    const p = phaseAt(h)
    if (nextIdle === null && p === 'idle') nextIdle = String(h).padStart(2, '0') + ':00'
    if (nextPeak === null && p === 'peak') nextPeak = String(h).padStart(2, '0') + ':00'
    if (nextIdle !== null && nextPeak !== null) break
  }
  return { nextIdle, nextPeak }
}

/**
 * 说话强度（这就是「空闲多说、高峰少说」的实现）
 *   mode: adaptive（默认）空闲正常说、高峰只回被叫到的
 *         onlyIdle         非空闲完全不出声
 *         always           不分时段
 * 返回 level: full | reduced | silent
 */
export function speechLevel(prefs, hour = new Date().getHours(), measured) {
  const cfg = prefs?.valley || {}
  const mode = cfg.mode || (cfg.onlyValley === true ? 'onlyIdle' : 'adaptive')
  if (mode === 'always') return { mode, level: 'full', reason: '不限制' }

  const idle = measured ? measured.phase === 'idle' : isValley(prefs, hour)

  if (mode === 'onlyIdle') {
    return idle ? { mode, level: 'full', reason: '空闲' } : { mode, level: 'silent', reason: '非空闲' }
  }
  // adaptive：忙的时候少说，不是不说
  return idle
    ? { mode, level: 'full', reason: '空闲，正常回' }
    : { mode, level: 'reduced', reason: '忙，只回被叫到的' }
}
