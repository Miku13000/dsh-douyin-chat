/**
 * lib/account.mjs —— 「用哪个抖音号」这件事只在一个地方管。
 *
 * 使用者 2026-11-09：插件里要能**输入抖音号**，或者**从已有的里面选**。
 * 所以这里维护一份账号表（~/.dsh/fish/accounts.json），当前用哪个写在偏好里。
 *
 * 账号条目：{ id: 抖音号, nick: 显示名, cookieFile: 登录态文件, note }
 * 没配就用回退路径（别的插件那份 cookie），保证老样子还能跑。
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { ensureHome, PATHS } from './paths.mjs'
import { load as loadPrefs, save as savePrefs } from './prefs.mjs'

export const ACCOUNTS = join(PATHS.home, 'accounts.json')
export const FALLBACK_COOKIE = process.env.FISH_COOKIE_FILE || ''

function readJson(p, dflt) {
  try { return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : dflt } catch { return dflt }
}

export function accounts() {
  const j = readJson(ACCOUNTS, { accounts: [] })
  return Array.isArray(j?.accounts) ? j.accounts : []
}

export function saveAccounts(list) {
  ensureHome()
  writeFileSync(ACCOUNTS, JSON.stringify({ accounts: list }, null, 2), 'utf8')
  return list
}

/** 当前账号（偏好里指定；没指定就返回 null） */
export function current() {
  const prefs = loadPrefs()
  const id = prefs?.account?.id || ''
  if (!id) return null
  return accounts().find((a) => a.id === id) || { id, nick: prefs.account.nick || '', cookieFile: prefs.account.cookieFile || '' }
}

/** 真正用的 cookie 文件：当前账号 > 环境变量 > 回退的那份 */
export function cookieFile() {
  const cur = current()
  if (cur?.cookieFile && existsSync(cur.cookieFile)) return cur.cookieFile
  return FALLBACK_COOKIE
}

/** 自己在这个号上的显示名（用来避免回自己） */
export function selfNick() {
  const cur = current()
  return (cur?.nick || '').trim()
}

export function use(id) {
  const hit = accounts().find((a) => a.id === id || a.nick === id)
  if (!hit) return { ok: false, error: `没有这个账号：${id}` }
  const prefs = savePrefs({ account: { id: hit.id, nick: hit.nick || '', cookieFile: hit.cookieFile || '' } })
  return { ok: true, account: prefs.account }
}

export function add({ id = '', nick = '', cookieFile: file = '', note = '' }) {
  const list = accounts()
  const exists = list.find((a) => (id && a.id === id) || (file && a.cookieFile === file))
  if (exists) return { ok: true, existed: true, account: exists }
  const item = { id, nick, cookieFile: file, note, addedAt: new Date().toISOString() }
  list.push(item)
  saveAccounts(list)
  return { ok: true, account: item }
}
