/**
 * lib/groups.mjs —— 群的身份：**群号（会话 id）为准，群名只是显示**。
 *
 * 使用者 2026-11-09 定的：群名会改，所以记群必须记群号；名字更新时同步更新。
 *
 * 存储（prefs.groupWhitelist）兼容两种写法：
 *   "Yuuka的后宫"                          ← 旧写法，只有名字
 *   { id: "7428236235618976295", name: "DeepSleep" }   ← 新写法
 *
 * 抖音的会话 id 不在 DOM 上，只在打开会话时的 imapi 请求体里（protobuf，id 是 ASCII 数字串）。
 * 所以「认群号」的做法是：打开会话的同时抓一次 id，落到存储里；下次按 id 认，名字对不上就更新名字。
 */

/** 把配置里的群列表统一成 [{id, name}] */
export function normalize(list) {
  const out = []
  for (const item of list || []) {
    if (!item) continue
    if (typeof item === 'string') out.push({ id: '', name: item.trim() })
    else out.push({ id: String(item.id || '').trim(), name: String(item.name || '').trim() })
  }
  return out.filter((g) => g.name || g.id)
}

/** 名字列表（给 openConversation / watch 用） */
export function names(list) {
  return normalize(list).map((g) => g.name).filter(Boolean)
}

/** 按 id 找；找不到再按名字 */
export function find(list, { id = '', name = '' } = {}) {
  const groups = normalize(list)
  if (id) {
    const byId = groups.find((g) => g.id && g.id === String(id))
    if (byId) return byId
  }
  if (name) return groups.find((g) => g.name === name) || null
  return null
}

/** 合并一次同步结果：id 已存在 → 更新名字；否则新增 */
export function merge(list, seen) {
  const groups = normalize(list)
  for (const s of seen || []) {
    if (!s?.id) continue
    const hit = groups.find((g) => g.id === s.id)
    if (hit) {
      if (s.name && hit.name !== s.name) hit.name = s.name
    } else {
      groups.push({ id: s.id, name: s.name || '' })
    }
  }
  return groups
}

/** 从 imapi 的 get_by_conversation 请求体里抠出会话 id（19 位数字串） */
export function extractConversationId(postData) {
  if (!postData) return ''
  const m = String(postData).match(/\n[\x00-\x1f]?(\d{16,20})/)
  if (m) return m[1]
  const m2 = String(postData).match(/(\d{16,20})/)
  return m2 ? m2[1] : ''
}
