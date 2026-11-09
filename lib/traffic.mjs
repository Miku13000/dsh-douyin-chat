/**
 * lib/traffic.mjs —— 实时高峰期 / 空闲期判断。
 *
 * 思路：抖音没有公开的「高峰期」接口，所以用**我们自己观测到的活跃度**来估：
 *   · 群/私信每收到一条消息，就给当前小时记一笔
 *   · 拿最近 7 天同一小时的平均值当基准，比较今天这一刻
 *   · 数据不够（新装、刚装）时退回经验值：0–8 点空闲，12–14、19–23 高峰
 *
 * 数据存在 ~/.dsh/fish/traffic.json，结构：{ "2026-11-09": { "15": 12, ... }, ... }
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { isValley } from './valley.mjs'
import { load as loadPrefs } from './prefs.mjs'

const HOME = process.env.DSH_FISH_HOME || join(process.env.USERPROFILE || '', '.dsh', 'fish')
const FILE = join(HOME, 'traffic.json')

const DEFAULT_IDLE = [0, 1, 2, 3, 4, 5, 6, 7, 8]
const DEFAULT_PEAK = [12, 13, 19, 20, 21, 22, 23]

function read() {
  try { return JSON.parse(readFileSync(FILE, 'utf8')) } catch { return {} }
}
function write(data) {
  try { writeFileSync(FILE, JSON.stringify(data), 'utf8') } catch { /* 写不进去就算了 */ }
}

/** 记一笔活跃度（收到一条消息调用一次） */
export function record(n = 1) {
  const now = new Date()
  const day = now.toISOString().slice(0, 10)
  const hour = String(now.getHours())
  const data = read()
  data[day] = data[day] || {}
  data[day][hour] = (Number(data[day][hour]) || 0) + n
  // 只留最近 14 天
  const days = Object.keys(data).sort().slice(-14)
  const trimmed = {}
  for (const d of days) trimmed[d] = data[d]
  write(trimmed)
}

/** 最近 N 天同一小时的平均条数 */
function avgForHour(hour, days = 7) {
  const data = read()
  const dates = Object.keys(data).sort().slice(-days).filter((d) => d !== new Date().toISOString().slice(0, 10))
  if (!dates.length) return null
  let sum = 0
  for (const d of dates) sum += Number(data[d]?.[String(hour)]) || 0
  return sum / dates.length
}

/**
 * 当前处于什么期：
 *   phase: 'idle' | 'normal' | 'peak'
 *   source: 'measured'（按自己的数据） | 'default'（经验值）
 */
export function phase(hour = new Date().getHours()) {
  const prefs = (() => { try { return loadPrefs() } catch { return {} } })()
  const v = prefs.valley || {}
  const base = avgForHour(hour)
  const todayCount = Number(read()[new Date().toISOString().slice(0, 10)]?.[String(hour)]) || 0

  // ① 没开「按实测」：直接用设好的谷时段（跟面板里那两个时段是同一套）
  if (v.auto !== true) {
    const inValley = isValley(prefs, hour)
    return {
      phase: inValley ? 'idle' : 'peak',
      source: 'window',
      basePerHour: base === null ? null : Math.round(base),
      todayCount,
      hour,
    }
  }

  // ② 开了实测：攒够历史才敢按数据判
  if (base !== null && base >= 5) {
    const ratio = todayCount / Math.max(base, 1)
    const ph = ratio < 0.3 ? 'idle' : 'peak'
    return { phase: ph, source: 'measured', basePerHour: Math.round(base), todayCount, hour }
  }

  // ③ 数据不够就退回谷时段，别拿经验值瞎判
  const inValley = isValley(prefs, hour)
  return { phase: inValley ? 'idle' : 'peak', source: 'window', basePerHour: null, todayCount, hour }
}

/** 给面板看的小时分布（最近 7 天） */
export function hourly() {
  const data = read()
  const dates = Object.keys(data).sort().slice(-7)
  const out = []
  for (let h = 0; h < 24; h++) {
    let sum = 0
    for (const d of dates) sum += Number(data[d]?.[String(h)]) || 0
    out.push({ hour: h, total: sum, avg: dates.length ? Math.round(sum / dates.length * 10) / 10 : 0 })
  }
  return { days: dates.length, hours: out }
}
