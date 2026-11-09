/**
 * lib/share.mjs —— 分享视频给别人（带偏好控制）。
 *
 * 使用者 2026-11-09 要的「分享视频能力 + 偏好」：
 *   · 发给谁（targets）、每天最多几条（maxPerDay）、两次间隔（minGapMin）
 *   · 带不带一句话理由（withReason）
 *
 * 通道说明：App 的 CDP 端口打不开（启动器只拉托盘，主进程不接 --remote-debugging-port），
 * 所以走无头浏览器 + 会话发送；对外效果是「一条带链接和理由的私信」。
 * 真正的「分享卡片」要等 App 那边能程序化控制再补。
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { ensureHome, PATHS } from './paths.mjs'
import { load as loadPrefs } from './prefs.mjs'

const STATE = join(PATHS.home, 'share-state.json')

const today = () => new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' })

export function loadShareState() {
  try { return existsSync(STATE) ? JSON.parse(readFileSync(STATE, 'utf8')) : {} } catch { return {} }
}

export function saveShareState(s) {
  ensureHome()
  try { writeFileSync(STATE, JSON.stringify(s, null, 2), 'utf8') } catch { /* 记不下来不挡发送 */ }
}

/** 偏好闸门：今天还能不能发、隔了多久 */
export function checkQuota({ now = Date.now() } = {}) {
  const prefs = loadPrefs()
  const cfg = prefs.share || {}
  if (cfg.enabled !== true) return { ok: false, reason: '分享开关没开（prefs.share.enabled）' }
  const st = loadShareState()
  const day = today()
  if (st.date !== day) { st.date = day; st.count = 0 }
  const max = Number(cfg.maxPerDay) || 5
  if ((st.count || 0) >= max) return { ok: false, reason: `今天已经分享 ${st.count} 条，到上限 ${max} 条` }
  const gapMin = Number(cfg.minGapMin) || 30
  if (st.lastAt && (now - st.lastAt) / 60000 < gapMin) {
    return { ok: false, reason: `离上次分享才 ${Math.round((now - st.lastAt) / 60000)} 分钟（下限 ${gapMin}）` }
  }
  return { ok: true, cfg, state: st }
}

/** 记一次成功分享 */
export function markShared() {
  const st = loadShareState()
  const day = today()
  if (st.date !== day) { st.date = day; st.count = 0 }
  st.count = (st.count || 0) + 1
  st.lastAt = Date.now()
  saveShareState(st)
  return st
}

/** 组装分享文本：链接 + 可选的一句话理由 */
export function buildShareText({ awemeId, reason = '', title = '' }) {
  const url = `https://www.douyin.com/video/${awemeId}`
  const bits = []
  if (title) bits.push(title)
  bits.push(url)
  if (reason) bits.push(reason)
  return bits.join('\n')
}
