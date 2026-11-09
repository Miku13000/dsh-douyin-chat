/**
 * lib/prefs.mjs —— 自己的偏好配置（不碰别人的 config.json）。
 *
 * 设计：默认值写死在代码里，用户改的落盘到 ~/.dsh/fish/config.json；
 *       读取时做一次浅合并，坏文件就当默认，绝不让插件起不来。
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { ensureHome, PATHS } from './paths.mjs'

export const DEFAULTS = {
  /** 允许自动接话的群（群名，字符串数组；空 = 不监任何群） */
  groupWhitelist: [],
  /** 允许自动接话的私信对象（昵称） */
  dmPeers: [],
  /**
   * 参与方式（选择式）：
   *   'mention' = 只在被 @ 时回（默认）
   *   'named'   = 被 @ 或叫名字（小满/小鲸鱼/鱼鱼）时回
   *   'auto'    = 群里聊到相关话题也主动接（最吵，慎用）
   */
  participation: 'mention',
  /** 监听轮询秒数 */
  watchIntervalSec: 25,
  /** 后台服务里监听是否处于开启状态（service.mjs 用） */
  watchEnabled: false,
  /** 'natural' 模式下，群里没点你也偶尔接话的概率（0-1） */
  naturalChance: 0.35,
  /** 主动插话冷却（秒）：两次没叫它的主动发言之间至少隔这么久 */
  naturalCooldownSec: 120,
  /** 🔁 QQ ↔ 抖音 互发开关（默认关；开了才允许跨平台发） */
  crossPlatform: false,
  /** 回话时 @ 对方 */
  mentionOnReply: true,
  /** 🔴 2026-11-09 老大定：有人 @ 就必须回，不许装看不见 */
  mustReplyToMention: true,
  /** 允许发表情包 */
  stickerEnabled: true,
  /**
   * 刷视频的偏好（跟 dsh-douyin-scroll 那套字段对齐）
   *   keywords  想看的（命中加分）
   *   channels  分类（游戏/美食/搞笑…）
   *   authors   指定作者
   *   avoid     不想看的（命中直接降权）
   *   perDay    每天最多推荐几条
   */
  /** 每日额度 + 自动计划（跟刷视频插件那套对齐） */
  /** 主人身份（QQ 号 / 抖音昵称 / 对外称呼）—— 开源版由使用者在面板里填 */
  owner: { qq: '', douyinNick: '', alias: '主人' },
  plan: { enabled: false, times: ['09:00', '20:00'], perDay: 10, perRun: 3, autoSend: false },
  videoPrefs: {
    keywords: [],
    channels: [],
    authors: [],
    avoid: [],
    perDay: 10,
  },
  /** 用哪个表情库：auto / qq / dsh-meme / custom / own */
  memeSource: 'auto',
  /** 本地表情包文件夹（留空则用插件自带的 stickers/） */
  stickerDir: '',
  /** 每天定时清理缓存：几点、开不开 */
  cleanup: { enabled: true, hour: 4 },
  /**
   * 谷时（像 QQ 那边一样：空闲时段才活动，高峰时段只读不回）
   *   onlyValley  只有谷时才回话/主动发
   *   windows     谷时时段，支持跨零点（start > end 表示跨天）
   */
  valley: { onlyValley: false, windows: [{ start: 12, end: 14 }, { start: 18, end: 9 }] },
  /** 旧字段，保留兼容；新逻辑看 valley */
  peakAvoid: { enabled: false, hours: [12, 13, 19, 20, 21, 22] },
  peakAvoid: { enabled: false, hours: [12, 13, 19, 20, 21, 22] },
  /** 读评论时顺便学梗 */
  learnFromComments: true,
  /** 每个群每天最多回几条（0 = 不限） */
  dailyGroupLimit: 3,
  /** 只在这些小时里自动接话（0-23，空数组 = 不限） */
  quietHours: [],
  /**
   * 主动开口（像 QQ 那样自己找你说话）：
   *   enabled   总开关（默认关）
   *   dm        主动发私信的对象（昵称）
   *   groups    主动说话的群（空 = 用 groupWhitelist）
   *   minGapMin 两次之间至少隔多少分钟
   *   maxPerDay 每天最多几条
   *   quietHours 这些小时里不主动（默认 0-7 点）
   */
  proactive: {
    enabled: false,
    dm: [],
    groups: [],
    minGapMin: 90,
    maxPerDay: 6,
    quietHours: [0, 1, 2, 3, 4, 5, 6, 7],
  },
  /**
   * 用哪个抖音号：id = 抖音号（可手填），nick = 显示名，cookieFile = 登录态文件。
   * 留空就用回退的那份 cookie（跟以前一样）。
   */
  account: {
    id: '',
    nick: '',
    cookieFile: '',
  },
}

export function load() {
  try {
    if (!existsSync(PATHS.config)) return { ...DEFAULTS }
    const j = JSON.parse(readFileSync(PATHS.config, 'utf8'))
    return { ...DEFAULTS, ...(j && typeof j === 'object' ? j : {}) }
  } catch { return { ...DEFAULTS } }
}

export function save(patch = {}) {
  const next = { ...load(), ...(patch || {}) }
  ensureHome()
  writeFileSync(PATHS.config, JSON.stringify(next, null, 2), 'utf8')
  return next
}

/** 只允许这些键被改，防止外部乱塞 */
export const EDITABLE = new Set(Object.keys(DEFAULTS))

export function sanitizePatch(patch = {}) {
  const out = {}
  for (const [k, v] of Object.entries(patch || {})) {
    if (!EDITABLE.has(k)) continue
    out[k] = v
  }
  return out
}
