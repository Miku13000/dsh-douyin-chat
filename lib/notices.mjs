/**
 * lib/notices.mjs —— 通过 MCP(stdio) 复用「刷抖音」插件那边的通知能力。
 *
 * 为什么这么绕：谁 @ 我 / 谁回复我 这些通知要签名接口，自己重写一套不划算；
 * 那个插件已经把这套能力开放成标准 MCP server（tools/mcp-server.mjs），
 * 我们起个子进程说 JSON-RPC 就能拿到，比自己实现签名稳。
 */
import { spawn } from 'node:child_process'

const SERVER = process.env.DOUYIN_MCP || ''
const HOME = process.env.DOUYIN_HOME || '\\.dsh\\douyin-duty'

/** 起一次 MCP 会话，跑一个工具，拿回它的 text 内容 */
function callMcpTool(toolName, args = {}, timeoutMs = 90_000) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [SERVER], {
      env: { ...process.env, DOUYIN_HOME: HOME },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    })
    let buf = ''
    const pending = new Map()
    const done = (v) => { try { child.kill() } catch { /* 已退 */ } resolve(v) }
    const timer = setTimeout(() => done({ ok: false, error: 'MCP 调用超时' }), timeoutMs)

    child.stdout.on('data', (d) => {
      buf += d.toString()
      let i
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim()
        buf = buf.slice(i + 1)
        if (!line) continue
        try {
          const msg = JSON.parse(line)
          if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id) }
        } catch { /* 非 JSON 行忽略 */ }
      }
    })
    child.stderr.on('data', () => {})
    child.on('error', (e) => { clearTimeout(timer); done({ ok: false, error: String(e?.message ?? e) }) })

    const send = (o) => { try { child.stdin.write(JSON.stringify(o) + '\n') } catch { /* 管道断了 */ } }
    const call = (id, method, params) => new Promise((res) => { pending.set(id, res); send({ jsonrpc: '2.0', id, method, params }) })

    ;(async () => {
      try {
        await call(1, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'dsh-fish', version: '0.1.0' } })
        send({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} })
        const r = await call(2, 'tools/call', { name: toolName, arguments: args })
        clearTimeout(timer)
        const text = (r?.result?.content || []).map((c) => c.text).filter(Boolean).join('\n')
        let parsed = null
        try { parsed = JSON.parse(text) } catch { parsed = null }
        done(parsed ? { ok: true, data: parsed } : { ok: false, error: '返回不是 JSON', raw: text.slice(0, 400) })
      } catch (e) {
        clearTimeout(timer)
        done({ ok: false, error: String(e?.message ?? e) })
      }
    })()
  })
}

/** 通知列表（谁 @ 我、谁回复我、谁关注/赞/评论） */
export async function fetchNotices() {
  const r = await callMcpTool('douyin_notices', {})
  if (!r.ok) return r
  return { ok: true, data: r.data }
}

/** 只挑「跟我说话」的那几类：@ 我、回复我的评论 */
export function pickMentions(notices) {
  const items = Array.isArray(notices?.items) ? notices.items : []
  const hit = items.filter((it) => {
    const t = Number(it.type)
    const name = String(it.type_name || '')
    return t === 45 || t === 46 || t === 31 || t === 32 || /提到|回复了你的评论|在你评论/.test(name)
  })
  return hit.map((it) => ({
    type: Number(it.type),
    type_name: it.type_name,
    nickname: it.nickname,
    text: it.text || it.comment_text || it.content || '',
    aweme_id: it.aweme_id || '',
    comment_id: it.comment_id || it.cid || '',
    root_comment_id: it.root_comment_id || '',
    at: it.create_time ? new Date(Number(it.create_time) * 1000).toISOString() : '',
    raw: it,
  }))
}
