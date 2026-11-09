/**
 * lib/browsers.mjs —— 「用哪个浏览器跑」这件事统一管。
 *
 * 老大 2026-11-09：浏览器要能选、也要能看见当前用的是哪个。
 * 这里登记本机可能装的 Chromium 系浏览器，按偏好挑一个；挑不到再按顺序回退。
 */
import { existsSync } from 'node:fs'
import { load as loadPrefs } from './prefs.mjs'

const PF = process.env.ProgramFiles || 'C:\\Program Files'
const PF86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)'
const LOCAL = process.env.LOCALAPPDATA || ''

export const KNOWN = [
  { id: 'chrome', name: 'Google Chrome', paths: [`${PF}\\Google\\Chrome\\Application\\chrome.exe`, `${PF86}\\Google\\Chrome\\Application\\chrome.exe`, `${LOCAL}\\Google\\Chrome\\Application\\chrome.exe`] },
  { id: 'edge', name: 'Microsoft Edge', paths: [`${PF86}\\Microsoft\\Edge\\Application\\msedge.exe`, `${PF}\\Microsoft\\Edge\\Application\\msedge.exe`] },
  { id: 'brave', name: 'Brave', paths: [`${PF}\\BraveSoftware\\Brave-Browser\\Application\\brave.exe`, `${PF86}\\BraveSoftware\\Brave-Browser\\Application\\brave.exe`] },
  { id: 'vivaldi', name: 'Vivaldi', paths: [`${LOCAL}\\Vivaldi\\Application\\vivaldi.exe`, `${PF}\\Vivaldi\\Application\\vivaldi.exe`] },
  { id: 'chromium', name: 'Chromium', paths: [`${PF}\\Chromium\\Application\\chrome.exe`, `${LOCAL}\\Chromium\\Application\\chrome.exe`] },
  { id: 'canary', name: 'Chrome Canary', paths: [`${LOCAL}\\Google\\Chrome SxS\\Application\\chrome.exe`] },
]

/** 本机装了哪些（只列存在的） */
export function listBrowsers() {
  return KNOWN.map((b) => {
    const hit = b.paths.find((p) => p && existsSync(p))
    return { id: b.id, name: b.name, path: hit || b.paths[0], exists: Boolean(hit) }
  })
}

/** 当前该用哪个：环境变量 > 偏好 > 第一个装了的 */
export function resolveBrowser() {
  const prefs = (() => { try { return loadPrefs() } catch { return {} } })()
  const want = String(process.env.FISH_BROWSER || prefs.browser?.channel || 'auto').toLowerCase()
  const found = listBrowsers().filter((b) => b.exists)
  if (!found.length) throw new Error('一个 Chromium 系浏览器都没找到（Chrome / Edge / Brave 都行）')
  if (want && want !== 'auto') {
    const hit = found.find((b) => b.id === want)
    if (hit) return { ...hit, source: 'config' }
  }
  return { ...found[0], source: want === 'auto' ? 'auto' : 'fallback' }
}

/** 一句话描述：给状态接口和日志用 */
export function browserSummary() {
  const all = listBrowsers()
  const cur = (() => { try { return resolveBrowser() } catch (e) { return { id: '', name: '', path: '', error: String(e?.message ?? e) } } })()
  return {
    current: { id: cur.id, name: cur.name, path: cur.path, source: cur.source || '' },
    installed: all.filter((b) => b.exists).map((b) => ({ id: b.id, name: b.name })),
    missing: all.filter((b) => !b.exists).map((b) => b.id),
  }
}
