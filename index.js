/**
 * 宿主半端 —— 保证本地后台服务（127.0.0.1:3110）一直活着。
 *
 * 之前这里只有一个 ping 工具，服务挂了就没人管（面板显示"服务离线"）。
 * 现在：插件加载时检查一次，之后每 60 秒检查，挂了就拉起来。
 */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

export const name = 'douyin-chat'
export const inject = []

const PORT = Number(process.env.FISH_PORT || 3110)

/** 服务代码可能在的位置（开发目录 / 安装目录） */
const CANDIDATES = [
  process.env.FISH_ROOT,
  '\\dsh-fish',
  'C:\\fishsvc',
  join(process.env.USERPROFILE || '', '.dsh', 'plugins', 'dsh-fish'),
].filter(Boolean)

function serviceEntry() {
  for (const root of CANDIDATES) {
    const p = join(root, 'bin', 'service.mjs')
    if (existsSync(p)) return { root, entry: p }
  }
  return null
}

async function alive() {
  try {
    const r = await fetch('http://127.0.0.1:' + PORT + '/health', { signal: AbortSignal.timeout(1500) })
    return r.ok
  } catch { return false }
}

let child = null

function startService(ctx) {
  const found = serviceEntry()
  if (!found) {
    try { ctx?.logger?.warn?.('[douyin-chat] 找不到 bin/service.mjs，跳过启动') } catch { /* 忽略 */ }
    return
  }
  child = spawn(process.execPath, [found.entry], {
    cwd: found.root,
    windowsHide: true,
    stdio: 'ignore',
    env: { ...process.env, FISH_PORT: String(PORT) },
  })
  child.on('exit', (code) => {
    try { ctx?.logger?.info?.('[douyin-chat] 服务退出 code=' + code) } catch { /* 忽略 */ }
    child = null
  })
  try { ctx?.logger?.info?.('[douyin-chat] 已启动服务：' + found.entry) } catch { /* 忽略 */ }
}

export function apply(ctx) {
  let timer = null

  const check = async () => {
    if (await alive()) return
    startService(ctx)
  }

  check().catch(() => {})
  timer = setInterval(() => { check().catch(() => {}) }, 60_000)

  if (ctx?.on) {
    ctx.on('dispose', () => {
      if (timer) clearInterval(timer)
      try { child?.kill() } catch { /* 已退 */ }
    })
  }

  // 保留一个 ping 工具（确认插件活着）
  try {
    if (ctx?.tools?.register) {
      ctx.tools.register({
        name: 'douyin_chat_ping',
        description: '确认「抖音群聊聊天」插件已加载，并报告后台服务是否在线。',
        parameters: { type: 'object', properties: {}, additionalProperties: false },
        output: {
          schema: { type: 'object', properties: {}, additionalProperties: true },
          render: (_a, v) => [{ type: 'text', text: JSON.stringify(v) }],
        },
        async execute() {
          const ok = await alive()
          const found = serviceEntry()
          return { ok, plugin: 'dsh-douyin-chat', port: PORT, service: found ? found.entry : null }
        },
      })
    }
  } catch (e) {
    console.error('[douyin-chat] 注册工具失败', e?.message)
  }
}
