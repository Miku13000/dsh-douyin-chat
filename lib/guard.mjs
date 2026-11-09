/**
 * lib/guard.mjs —— 低风控节奏控制。
 *
 * 把「评论 @」「分享卡片」这类会被平台注意的动作限速，并且加随机抖动，别一分钟连着来。
 * 规则在 prefs.guard。
 *
 * 状态存在 ~/.dsh/fish/guard-state.json：
 *   { comment: { date, count, lastAt }, share: { date, count, lastAt } }
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { load as loadPrefs } from './prefs.mjs'

const HOME = process.env.DSH_FISH_HOME || join(homedir(), '.dsh', 'fish')
const FILE = join(HOME, 'guard-state.json')
const today = () => new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' })

export const DEFAULT_GUARD = {
  commentPerDay: 3,
  commentGapMin: 45,
  sharePerDay: 10,
  shareGapMin: 10,
  jitterMinSec: 3,
  jitterMaxSec: 12,
}

export function guardConfig() {
  try { return { ...DEFAULT_GUARD, ...(loadPrefs().guard || {}) } } catch { return DEFAULT_GUARD }
}

function read() {
  try { return JSON.parse(readFileSync(FILE, 'utf8')) } catch { return {} }
}
function write(d) {
  try { writeFileSync(FILE, JSON.stringify(d, null, 1), 'utf8') } catch { /* 写不进去就不限 */ }
}

/** 现在能不能做这类动作 */
export function check(kind) {
  const cfg = guardConfig()
  const st = read()
  const cur = st[kind] || {}
  const day = today()
  const count = cur.date === day ? Number(cur.count) || 0 : 0
  const perDay = kind === 'comment' ? cfg.commentPerDay : cfg.sharePerDay
  const gapMin = kind === 'comment' ? cfg.commentGapMin : cfg.shareGapMin

  if (count >= perDay) return { ok: false, reason: '今天这类动作已经 ' + count + ' 次（上限 ' + perDay + '）', remaining: 0 }
  if (cur.lastAt) {
    const mins = (Date.now() - Number(cur.lastAt)) / 60000
    if (mins < gapMin) return { ok: false, reason: '离上次才 ' + Math.round(mins) + ' 分钟（下限 ' + gapMin + ' 分钟）', remaining: perDay - count }
  }
  return { ok: true, remaining: perDay - count }
}

/** 记一次动作 */
export function mark(kind) {
  const st = read()
  const day = today()
  const cur = st[kind] && st[kind].date === day ? st[kind] : { date: day, count: 0 }
  st[kind] = { date: day, count: (Number(cur.count) || 0) + 1, lastAt: Date.now() }
  write(st)
  return st[kind]
}

/** 动作前的随机抖动（毫秒） */
export function jitterMs() {
  const cfg = guardConfig()
  const lo = Math.max(0, Number(cfg.jitterMinSec) || 0) * 1000
  const hi = Math.max(lo, (Number(cfg.jitterMaxSec) || 12) * 1000)
  return Math.floor(lo + Math.random() * (hi - lo))
}

export function status() {
  const st = read()
  const cfg = guardConfig()
  const day = today()
  const one = (k) => {
    const c = st[k] || {}
    return { count: c.date === day ? Number(c.count) || 0 : 0, lastAt: c.lastAt || null }
  }
  return { config: cfg, comment: one('comment'), share: one('share') }
}
