/**
 * lib/stats.mjs —— 今天的动作统计（回话 / 表情 / 分享 / 评论）。
 * 存在 ~/.dsh/fish/stats.json，只留最近 14 天。
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

const HOME = process.env.DSH_FISH_HOME || join(homedir(), '.dsh', 'fish')
const FILE = join(HOME, 'stats.json')

function read() {
  try { return JSON.parse(readFileSync(FILE, 'utf8')) } catch { return {} }
}
function write(d) {
  try { writeFileSync(FILE, JSON.stringify(d), 'utf8') } catch { /* 写不进去就算 */ }
}

/** 记一次动作：kind = reply / sticker / share / comment */
export function bump(kind, n = 1) {
  const day = new Date().toISOString().slice(0, 10)
  const d = read()
  d[day] = d[day] || {}
  d[day][kind] = (Number(d[day][kind]) || 0) + n
  d[day].lastAt = new Date().toISOString()
  const days = Object.keys(d).sort().slice(-14)
  const trimmed = {}
  for (const k of days) trimmed[k] = d[k]
  write(trimmed)
  return trimmed[day]
}

export function today() {
  const day = new Date().toISOString().slice(0, 10)
  const d = read()
  return d[day] || {}
}

export function recent(days = 7) {
  const d = read()
  return Object.keys(d).sort().slice(-days).map((k) => ({ day: k, ...d[k] }))
}
