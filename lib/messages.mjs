/**
 * lib/messages.mjs —— 消息去重的公共工具（群聊和私信共用一套）
 *
 * 为什么需要：抖音网页版的消息 DOM 里**没有 id**（查过，没有 data-id / message_id），
 * 所以不能像 QQ 的 OneBot 那样按 message_id 去重。这里用「指纹」代替：
 *
 *   指纹 = 发送者 + 去掉空白后的正文（截断 60 字）
 *
 * 处理过的指纹存进集合，2 小时内重复出现就跳过。
 * 比"锚点"可靠：不依赖消息在列表里的位置，读漏一条也不会把旧消息当新的。
 */

/** 一条消息的指纹 */
export function fingerprint(m) {
  const who = String((m && m.who) || '')
  const text = String((m && m.text) || '').replace(/\s+/g, '').slice(0, 60)
  return who + '|' + text
}

/** 正文归一化（去标点表情，用于"同一句别重复说"） */
export function normalizeText(s) {
  return String(s || '').replace(/[\s\p{P}\p{S}]/gu, '')
}

/** 是不是自己发的（读消息时会用 __self__ / __peer__ 标记） */
export function isSelfMessage(m, selfNick = '') {
  if (!m) return false
  if (m.who === '__self__') return true
  if (m.who === '__peer__') return false
  const w = String(m.who || '')
  if (!w) return false
  if (selfNick && w === selfNick) return true
  if (w.includes('小鲸鱼')) return true
  return false
}

/**
 * 从消息列表里挑出"还没处理过"的。
 * @param {Array} msgs 读到的消息（按时间正序）
 * @param {Array} seen 已处理指纹：[{ fp, at }]
 * @param {number} ttlMs 指纹有效期（默认 2 小时）
 */
export function pickFresh(msgs, seen, ttlMs = 2 * 3600_000) {
  const map = new Map((Array.isArray(seen) ? seen : []).map((x) => [x.fp, x.at]))
  const now = Date.now()
  const fresh = (msgs || []).filter((m) => {
    const at = map.get(fingerprint(m))
    return !(at && now - at < ttlMs)
  })
  return { fresh, map }
}

/** 把本轮看到的消息全部记进指纹表，返回裁剪后的数组 */
export function rememberSeen(msgs, map, { ttlMs = 2 * 3600_000, max = 200 } = {}) {
  const now = Date.now()
  for (const m of msgs || []) {
    const fp = fingerprint(m)
    if (!map.has(fp)) map.set(fp, now)
  }
  return [...map.entries()]
    .map(([fp, at]) => ({ fp, at }))
    .filter((x) => now - x.at < ttlMs)
    .slice(-max)
}
