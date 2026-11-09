/**
 * lib/memes.mjs —— 表情库：按情绪标签随便挑一张。
 *
 * 来源**自动挑**，优先级：
 *   1. QQ 同步的图库   ~/.dsh/meme-packs        （QQ 桥接和 dsh-meme 共用，有就是它）
 *   2. DSH 表情包插件  <profile>/node_modules/dsh-meme/memes
 *   3. 自建目录        ~/.dsh/fish/stickers     （前两个都没有时自动创建）
 * 另外偏好里的 memeDirs 会追加进来。
 *
 * 目录布局两种都认：
 *   <分类>/*.jpg                 直接按文件夹名分类
 *   <包>/memes/<分类>/*.jpg      dsh-meme 的包结构
 */
import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { load as loadPrefs } from './prefs.mjs'

const IMG = /\.(png|jpe?g|gif|webp)$/i

const safeList = (dir) => { try { return readdirSync(dir) } catch { return [] } }
const isDir = (p) => { try { return statSync(p).isDirectory() } catch { return false } }

const dshHome = () => process.env.DSH_HOME || join(homedir(), '.dsh')

/** 自建目录：没有就建一个，放个说明文件 */
export function ensureOwnDir() {
  const dir = join(process.env.DSH_FISH_HOME || join(homedir(), '.dsh', 'fish'), 'stickers')
  if (!isDir(dir)) {
    try { mkdirSync(dir, { recursive: true }) } catch { return dir }
  }
  const readme = join(dir, '把图片放这里.txt')
  if (!existsSync(readme)) {
    try {
      writeFileSync(readme, [
        '把表情图放进这个文件夹，或者在下面新建子文件夹当分类。',
        '例如：',
        '  stickers/happy/xxx.jpg',
        '  stickers/sad/yyy.png',
        '支持 png / jpg / jpeg / gif / webp。',
        '改完不用重启，聊天里点「表情 ▼」就能看到。',
      ].join('\r\n'), 'utf8')
    } catch { /* 写不进去不影响 */ }
  }
  return dir
}

/** 所有候选来源（带标签，按优先级） */
export function sources() {
  const out = []

  // 1) QQ 同步的图库
  const qqDir = join(dshHome(), 'meme-packs')
  if (isDir(qqDir) && safeList(qqDir).length) {
    out.push({ id: 'qq', label: 'QQ 同步图库', dir: qqDir })
  }

  // 2) DSH 表情包插件自带的包
  const profiles = join(dshHome(), 'profiles')
  for (const prof of safeList(profiles)) {
    const p = join(profiles, prof, 'node_modules', 'dsh-meme', 'memes')
    if (isDir(p) && safeList(p).length) out.push({ id: 'dsh-meme', label: 'DSH 表情包插件 · ' + prof, dir: p })
  }

  // 3) 自己配的目录
  const prefs = loadPrefs()
  for (const d of (prefs.memeDirs || [])) {
    if (d && isDir(d)) out.push({ id: 'custom', label: '自定义目录', dir: d })
  }

  // 4) 自建（前面一个都没有才用；有也放最后兜底）
  out.push({ id: 'own', label: '自建目录', dir: ensureOwnDir() })
  return out
}

function countIn(dir) {
  let n = 0
  const walk = (d) => {
    for (const name of safeList(d)) {
      const p = join(d, name)
      if (isDir(p)) walk(p)
      else if (IMG.test(name)) n++
    }
  }
  walk(dir)
  return n
}

export function scan() {
  const prefs = loadPrefs()
  const chosen = prefs.memeSource || 'auto'
  const items = []
  const tags = new Map()
  const bySource = []

  const collect = (dir, tag, srcId) => {
    for (const f of safeList(dir)) {
      const p = join(dir, f)
      if (!IMG.test(f)) continue
      items.push({ tag, name: f, path: p, source: srcId })
      tags.set(tag, (tags.get(tag) || 0) + 1)
    }
  }

  const all = sources()
  // 用户选了具体的库就只扫那一个；选了 auto 或那个库没图就全扫
  const picked = chosen === 'auto' ? all : all.filter((s2) => s2.id === chosen)
  const use = (chosen !== 'auto' && picked.length && picked.some((s2) => {
    let n = 0
    const walk = (d) => { for (const name of safeList(d)) { const p = join(d, name); if (isDir(p)) walk(p); else if (IMG.test(name)) n++ } }
    walk(s2.dir)
    return n > 0
  })) ? picked : all

  for (const src of use) {
    const before = items.length

    for (const name of safeList(src.dir)) {
      const p = join(src.dir, name)
      if (!isDir(p)) continue
      const inner = join(p, 'memes')
      if (isDir(inner)) {
        for (const tag of safeList(inner)) {
          const d = join(inner, tag)
          if (isDir(d)) collect(d, tag, src.id)
        }
      } else if (safeList(p).some((f) => IMG.test(f))) {
        collect(p, name, src.id)
      }
    }

    // 根下直接放图的（自建目录常见）
    collect(src.dir, 'none', src.id)

    const added = items.length - before
    if (added > 0) bySource.push({ ...src, count: added })
  }

  // 只保留真正有图的来源
  const usedSources = bySource.filter((s2) => s2.count > 0)

  return {
    total: items.length,
    tags: [...tags.entries()].map(([tag, count]) => ({ tag, count })).sort((a, b) => b.count - a.count),
    items,
    sources: usedSources,
    primary: usedSources[0] || null,
    chosen,
    ownDir: ensureOwnDir(),
  }
}

export function pick({ tag = '', query = '' } = {}) {
  const lib = scan()
  let pool = lib.items
  if (tag) pool = pool.filter((x) => x.tag === tag)
  if (query) {
    const q = String(query).toLowerCase()
    pool = pool.filter((x) => (x.tag + ' ' + x.name).toLowerCase().includes(q))
  }
  if (!pool.length) return null
  return pool[Math.floor(Math.random() * pool.length)]
}

export { countIn }
