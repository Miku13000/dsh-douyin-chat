/**
 * bin/notices.mjs —— 读一次通知，挑出「谁 @ 我 / 谁回复我」。
 *
 *   node bin/notices.mjs                 # 摘要 + 命中的条目
 *   node bin/notices.mjs --all           # 连原始通知一起给
 *
 * 依赖 lib/notices.mjs（走「刷抖音」插件的 MCP 服务拿签名接口结果）。
 */
import { fetchNotices, pickMentions } from '../lib/notices.mjs'
import { flag, emit } from '../lib/util.mjs'

const r = await fetchNotices()
if (!r.ok) {
  emit({ ok: false, error: r.error, raw: r.raw })
  process.exit(1)
}
const mentions = pickMentions(r.data)
emit({
  ok: true,
  total: Array.isArray(r.data.items) ? r.data.items.length : 0,
  counts: r.data.counts || {},
  mentionCount: mentions.length,
  mentions,
  ...(flag('--all') ? { all: r.data.items } : {}),
})
