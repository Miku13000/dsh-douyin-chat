/**
 * dsh-douyin-chat —— 宿主半端。
 *
 * 只做一件事：确保本地后台服务（127.0.0.1:3110）在跑。
 * 真正的抖音操作都在 bin/service.mjs（无头 Chrome + CDP），面板只是它的界面。
 */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const name = 'douyin-chat'
export const inject = []

const ROOT = dirname(fileURLToPath(import.meta.url))
const PORT = Number(process.env.DOUYIN_CHAT_PORT || 3110)
let child = null

async function alive() {
  try {
    const r = await fetch('http://127.0.0.1:' + PORT + '/health', { signal: AbortSignal.timeout(1500) })
    return r.ok
  } catch { return false }
}

function startService(ctx) {
  const entry = join(ROOT, 'bin', 'service.mjs')
  if (!existsSync(entry)) {
    try { ctx?.logger?.warn?.('[douyin-chat] 没找到 bin/service.mjs，跳过启动') } catch { /* 忽略 */ }
    return
  }
  child = spawn(process.execPath, [entry], {
    cwd: ROOT,
    windowsHide: true,
    stdio: 'ignore',
    env: { ...process.env, DOUYIN_CHAT_PORT: String(PORT) },
  })
  child.on('exit', (code) => {
    try { ctx?.logger?.info?.('[douyin-chat] 服务退出 code=' + code) } catch { /* 忽略 */ }
    child = null
  })
}

export function apply(ctx) {
  const boot = async () => {
    if (await alive()) { try { ctx?.logger?.info?.('[douyin-chat] 服务已在运行') } catch { /* 忽略 */ } ; return }
    try { ctx?.logger?.info?.('[douyin-chat] 启动本地服务…') } catch { /* 忽略 */ }
    startService(ctx)
  }
  boot().catch(() => { /* 起不来就让面板显示离线 */ })
  if (ctx?.on) {
    ctx.on('dispose', () => { try { child?.kill() } catch { /* 已退 */ } })
  }
}
