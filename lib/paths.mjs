/**
 * lib/paths.mjs —— 目录约定 + **自动探测**（使用者 2026-11-09：自己找，别让我配）。
 *
 * 找的东西只有三样：
 *   · 人格底座（soul core）—— 三端共用那一份
 *   · QQ 角色卡 —— 「跟 QQ 一样」的正文来源
 *   · mnemon 共享记忆库 —— MEMORY.md / USER.md 所在
 * 每一件都按候选路径顺序找，第一个存在的就用；全都没有就返回空，不报错。
 */
import { existsSync, mkdirSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

const DSH_HOME = process.env.DSH_HOME || join(homedir(), '.dsh')

/** 插件自己的家：配置、词表、日志都放这儿 */
export const FISH_HOME = process.env.DSH_FISH_HOME || join(DSH_HOME, 'fish')

export const PATHS = {
  home: FISH_HOME,
  config: join(FISH_HOME, 'config.json'),
  lexicon: join(FISH_HOME, 'lexicon.json'),
  log: join(FISH_HOME, 'fish.log'),
}

const firstExisting = (list) => list.filter(Boolean).find((p) => { try { return existsSync(p) && statSync(p).isFile() } catch { return false } }) || ''

/** 人格底座：环境变量 > 三端约定位置 > DSH 家目录 > 插件自带 */
export function soulCorePath() {
  return firstExisting([
    process.env.DSH_SOUL_CORE,
    'C:\\_setup\\soul\\core.md',
    join(DSH_HOME, 'soul', 'core.md'),
    join(FISH_HOME, 'soul', 'core.md'),
  ])
}

/** QQ 角色卡：环境变量 > qq-bridge 约定 > 家目录镜像；目录里挑「最像主卡」的那份 */
export function qqRolePath() {
  const env = process.env.DSH_QQ_ROLE
  if (env && existsSync(env)) return env
  const fixed = 'C:\\qq-bridge\\roles\\使用者的小鲸鱼.md'
  if (existsSync(fixed)) return fixed
  for (const dir of ['C:\\qq-bridge\\roles', join(DSH_HOME, 'qq-bridge', 'roles')]) {
    try {
      const files = readdirSync(dir).filter((f) => f.toLowerCase().endsWith('.md')).map((f) => join(dir, f))
      if (!files.length) continue
      // 优先名字里带「小鲸鱼」的，否则取最大那份（角色卡通常最全）
      const named = files.find((f) => /小鲸鱼|鲸鱼|soul|persona/i.test(f))
      if (named) return named
      return files.sort((a, b) => { try { return statSync(b).size - statSync(a).size } catch { return 0 } })[0]
    } catch { /* 目录不存在就继续找 */ }
  }
  return ''
}

/** mnemon 共享记忆库：环境变量 > Y 盘 > 家目录 > DSH 家；要求里面有 runtime 或 memories.json */
export function mnemonDir() {
  const candidates = [
    process.env.MNEMON_DATA_DIR,
    'Y:\\mnemon',
    join(homedir(), '.mnemon'),
    join(DSH_HOME, 'mnemon'),
  ].filter(Boolean)
  for (const dir of candidates) {
    if (existsSync(join(dir, 'runtime', 'MEMORY.md')) || existsSync(join(dir, 'memories.json'))) return dir
  }
  return candidates[0] || join(homedir(), '.mnemon')
}

/** 兼容旧名字（代码里之前直接 import 常量） */
export const SOUL_CORE = soulCorePath()

/** 三样东西实际用的是哪份——给状态接口和日志看 */
export function discovery() {
  const soul = soulCorePath()
  const role = qqRolePath()
  const mem = mnemonDir()
  return {
    soulCore: { path: soul, found: Boolean(soul) },
    qqRole: { path: role, found: Boolean(role) },
    memory: {
      dir: mem,
      found: existsSync(join(mem, 'runtime', 'MEMORY.md')),
      memoryMd: join(mem, 'runtime', 'MEMORY.md'),
      userMd: join(mem, 'runtime', 'USER.md'),
    },
  }
}

/** 自己写的人设 / 记忆（本插件私有，可随时改） */
export const LOCAL_PERSONA = join(FISH_HOME, 'persona.md')
export const LOCAL_MEMORY = join(FISH_HOME, 'memory.md')

export function ensureHome() {
  if (!existsSync(FISH_HOME)) mkdirSync(FISH_HOME, { recursive: true })
  return FISH_HOME
}
