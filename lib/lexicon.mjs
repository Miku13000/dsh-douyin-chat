/**
 * lib/lexicon.mjs —— 梗 / 黑话词表（自己的，不碰 QQ 桥接那份）。
 *
 * 为什么要有：抖音评论区才是"这词什么意思"的现场。读评论时把反复出现、
 * 又看不懂的词记下来，攒够证据再学；下次聊天能用对地方。
 *
 * 规则：
 *   · 只记**词**和**用法证据**，不记"我觉得"，避免自己编意思。
 *   · 同一个词重复提交 = 加命中数（说明它真的常见），不覆盖已有释义。
 *   · 没释义的词进 pending，等有证据再补。
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { ensureHome, PATHS } from './paths.mjs'

const EMPTY = { version: 1, terms: [], updatedAt: '' }

function load() {
  try {
    if (!existsSync(PATHS.lexicon)) return { ...EMPTY, terms: [] }
    const j = JSON.parse(readFileSync(PATHS.lexicon, 'utf8'))
    return { ...EMPTY, ...j, terms: Array.isArray(j?.terms) ? j.terms : [] }
  } catch { return { ...EMPTY, terms: [] } }
}

function save(db) {
  ensureHome()
  db.updatedAt = new Date().toISOString()
  writeFileSync(PATHS.lexicon, JSON.stringify(db, null, 2), 'utf8')
  return db
}

const norm = (s) => String(s || '').trim()

/** 查询：按词面 / 释义 / 标签做子串匹配，按命中数排 */
export function query(q, limit = 5) {
  const key = norm(q).toLowerCase()
  const db = load()
  if (!key) return db.terms.slice(0, limit)
  return db.terms
    .filter((t) => {
      const hay = [t.term, t.meaning, ...(t.tags || [])].join(' ').toLowerCase()
      return hay.includes(key)
    })
    .sort((a, b) => (b.hits || 0) - (a.hits || 0))
    .slice(0, limit)
}

/**
 * 提交 / 更新一个词。
 * @param {{term:string, meaning?:string, tags?:string[], context?:string, evidence?:string}} input
 */
export function submit(input = {}) {
  const term = norm(input.term)
  if (!term) throw new Error('缺 term')
  const db = load()
  const now = new Date().toISOString()
  const hit = db.terms.find((t) => t.term.toLowerCase() === term.toLowerCase())
  if (hit) {
    hit.hits = (Number(hit.hits) || 0) + 1
    hit.lastSeen = now
    if (input.meaning && !hit.meaning) hit.meaning = norm(input.meaning)
    if (input.context) hit.contexts = [...new Set([...(hit.contexts || []), norm(input.context)])].slice(-5)
    if (input.evidence) hit.evidence = [...new Set([...(hit.evidence || []), norm(input.evidence)])].slice(-5)
    if (Array.isArray(input.tags)) hit.tags = [...new Set([...(hit.tags || []), ...input.tags.map(norm).filter(Boolean)])]
    save(db)
    return { ok: true, updated: true, term: hit }
  }
  const item = {
    term,
    meaning: norm(input.meaning),
    tags: Array.isArray(input.tags) ? input.tags.map(norm).filter(Boolean) : [],
    contexts: input.context ? [norm(input.context)] : [],
    evidence: input.evidence ? [norm(input.evidence)] : [],
    hits: 1,
    firstSeen: now,
    lastSeen: now,
  }
  db.terms.push(item)
  if (db.terms.length > 500) db.terms = db.terms.slice(-500)
  save(db)
  return { ok: true, created: true, term: item }
}

export function stats() {
  const db = load()
  const withMeaning = db.terms.filter((t) => t.meaning).length
  return { total: db.terms.length, withMeaning, pending: db.terms.length - withMeaning, updatedAt: db.updatedAt }
}
