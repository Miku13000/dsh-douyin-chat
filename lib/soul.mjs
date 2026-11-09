/**
 * lib/soul.mjs —— 读共享的人格与记忆（**只读**）。
 *
 * 约定（2026-11-09 老大定「按 QQ 为主」）：
 *   · 人格单一源在 soul 底座；各端分线自己保留，但改名/称呼这类不许漂。
 *   · 记忆是 mnemon 的 runtime 快照（MEMORY.md / USER.md），三端同一份。
 *
 * 路径全部走 paths.mjs 的自动探测 —— 换机器/换盘符不用改代码。
 * 这个模块只负责读出来，不写别人的文件。
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { discovery, mnemonDir, qqRolePath, soulCorePath, LOCAL_PERSONA, LOCAL_MEMORY } from './paths.mjs'
import { writeFileSync } from 'node:fs'
import { load as loadPrefs } from './prefs.mjs'

/** 当前用哪条通道：qq（共享）/ local（自己写）/ both（共享 + 自己写在前） */
export function identityMode() {
  try {
    const m = loadPrefs().identity?.mode
    return m === 'local' || m === 'both' ? m : 'qq'
  } catch { return 'qq' }
}

/** 自己写的人设 / 记忆（本插件私有） */
export function localPersona() { return read(LOCAL_PERSONA) }
export function localMemory() { return read(LOCAL_MEMORY) }
export function saveLocalPersona(text) { try { writeFileSync(LOCAL_PERSONA, String(text || ''), 'utf8'); return true } catch { return false } }
export function saveLocalMemory(text) { try { writeFileSync(LOCAL_MEMORY, String(text || ''), 'utf8'); return true } catch { return false } }

const read = (p) => { try { return p && existsSync(p) ? readFileSync(p, 'utf8') : '' } catch { return '' } }

/** 底座（身份 / 称呼 / 语气底线 / 红线） */
export function soulCore() {
  return read(soulCorePath())
}

/** QQ 那份角色卡 —— 「跟 QQ 一样」的正文来源 */
export function roleCard() {
  return read(qqRolePath())
}

/** 共享热记忆：MEMORY.md（工作记忆）+ USER.md（用户画像） */
export function runtimeMemory() {
  const mode = identityMode()
  const dir = mnemonDir()
  const qqMemory = read(join(dir, 'runtime', 'MEMORY.md'))
  const qqUser = read(join(dir, 'runtime', 'USER.md'))
  const mine = localMemory()

  if (mode === 'local') return { memory: mine, user: '', dir, mode }
  if (mode === 'both') {
    return {
      memory: [mine, qqMemory].filter(Boolean).join('\n\n---\n\n'),
      user: qqUser,
      dir,
      mode,
    }
  }
  return { memory: qqMemory, user: qqUser, dir, mode }
}

/**
 * 完整人格包：底座 + QQ 角色卡。
 * ⚠️ 关键：QQ 那张卡是「按 QQ 号认人」的，搬到抖音会变成「你号不对就别装」——
 *    所以注入前要把号码换成抖音这边的认法（昵称 Sora），并删掉那几句审问式的话。
 */
export function personaBundle(limit = 8000) {
  const mode = identityMode()
  const mine = localPersona()

  if (mode === 'local') {
    const text = mine || soulCore()
    return text.length > limit ? text.slice(0, limit) : text
  }

  const minePart = mode === 'both' && mine ? mine.trim() + '\n\n' : ''
  const core = soulCore()
  let card = roleCard()
  if (card) {
    // 主人身份从偏好读（prefs.owner），没有就原样保留
    const owner = (() => { try { return loadPrefs().owner || {} } catch { return {} } })()
    const ownerLabel = owner.alias || '主人'
    if (owner.qq) card = card.replace(new RegExp(String(owner.qq), 'g'), ownerLabel)
    if (owner.douyinNick) card = card.replace(/Sora/g, owner.douyinNick)
    card = card.split(/\r?\n/).filter((l) => !/号都不对|装什么老大|报别的号|号不是\s*\d{6,}/.test(l)).join('\n')
  }
  let out = minePart
  if (core) out += core.trim() + '\n\n'
  if (card) out += card.trim()
  if (out.length > limit) out = out.slice(0, limit)
  return out
}

/** 给状态接口看：人格/记忆各自从哪读的、多大、有没有读到 */
export function soulStatus() {
  const mode = identityMode()
  const mineP = localPersona()
  const mineM = localMemory()
  const d = discovery()
  const core = soulCore()
  const card = roleCard()
  const mem = runtimeMemory()
  return {
    soulCore: { path: d.soulCore.path, found: d.soulCore.found, chars: core.length },
    qqRole: { path: d.qqRole.path, found: d.qqRole.found, chars: card.length },
    memory: {
      dir: mem.dir,
      memoryMd: { found: Boolean(mem.memory), chars: mem.memory.length },
      userMd: { found: Boolean(mem.user), chars: mem.user.length },
    },
    personaChars: personaBundle().length,
    missing: {
      soulCore: !d.soulCore.found,
      qqRole: !d.qqRole.found,
      memory: !d.memory.found,
    },
    hint: (() => {
      const noCore = !d.soulCore.found
      const noRole = !d.qqRole.found
      const noMem = !d.memory.found
      if (!noCore && !noRole && !noMem) return ''
      const parts = []
      if (noCore) parts.push('人格底座')
      if (noRole) parts.push('QQ 角色卡')
      if (noMem) parts.push('共享记忆')
      return '这台机器没找到：' + parts.join('、') + '。可以切到「自己写」通道，直接用面板里的人格和记忆。'
    })(),
    mode,
    local: {
      persona: { path: LOCAL_PERSONA, chars: mineP.length },
      memory: { path: LOCAL_MEMORY, chars: mineM.length },
    },
  }
}
