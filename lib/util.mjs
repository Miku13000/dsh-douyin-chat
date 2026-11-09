/**
 * lib/util.mjs —— 各处都在重复的小工具，收在一处。
 *
 * 之前 send/read/sticker/comments/account/service 每个脚本都自己写一份
 * `const arg = (n,d)=>...`、`sleep`、`JSON.parse 最后一段输出`，抄得越多越容易不一致。
 */
import { spawn } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** 取命令行参数：--to "某人" → arg('--to') */
export function arg(name, dflt = '') {
  const i = process.argv.indexOf(name)
  return i < 0 ? dflt : (process.argv[i + 1] ?? dflt)
}

/** 是否带了某个开关：--dry */
export function flag(name) {
  return process.argv.includes(name)
}

/** CLI 统一输出：一段 JSON，人看得懂，机器也读得动 */
export function emit(value) {
  console.log(JSON.stringify(value, null, 2))
}

/** 往文件里追加一行（目录不存在就建） */
export function logLine(file, line) {
  try {
    mkdirSync(dirname(file), { recursive: true })
    appendFileSync(file, line + '\n', 'utf8')
  } catch { /* 日志写不进去不该影响主流程 */ }
}

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

/**
 * 跑一个 bin 脚本，拿它最后打印的那段 JSON。
 * 子进程跑的好处：浏览器崩了、脚本挂死，都不会把调用方（服务/插件）拖下去。
 */
export function runBin(script, args = [], { timeout = 240_000, cwd = ROOT } = {}) {
  return new Promise((resolve) => {
    const file = script.includes('/') || script.includes('\\') ? join(ROOT, script) : join(ROOT, 'bin', script)
    const child = spawn(process.execPath, [file, ...args], { cwd, env: process.env, windowsHide: true })
    let out = ''
    let err = ''
    const timer = setTimeout(() => { try { child.kill() } catch { /* 已退 */ } }, timeout)
    child.stdout.on('data', (d) => { out += d.toString() })
    child.stderr.on('data', (d) => { err += d.toString() })
    child.on('error', (e) => { clearTimeout(timer); resolve({ ok: false, error: String(e?.message ?? e) }) })
    child.on('close', (code) => {
      clearTimeout(timer)
      const i = out.lastIndexOf('\n{')
      const raw = i >= 0 ? out.slice(i + 1) : out.slice(out.indexOf('{'))
      try { resolve(JSON.parse(raw)) } catch {
        resolve({ ok: false, code, error: '脚本没返回可解析的 JSON', stdout: out.slice(-400), stderr: err.slice(-400) })
      }
    })
  })
}
