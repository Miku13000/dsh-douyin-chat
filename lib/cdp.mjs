/**
 * lib/cdp.mjs —— 最小 Chrome DevTools Protocol 客户端（自己写的，不依赖 puppeteer）。
 *
 * 只做三件事：起一个无头 Chrome、连上它的页面 target、发 CDP 命令/跑 JS。
 * 够用就好，不追求通用。
 */
import { spawn } from 'node:child_process'
import { resolveBrowser } from './browsers.mjs'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const CHROME_CANDIDATES = [
  process.env.FISH_CHROME,
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
].filter(Boolean)

export function findChrome() {
  if (process.env.FISH_CHROME && existsSync(process.env.FISH_CHROME)) return process.env.FISH_CHROME
  // 走统一的选择逻辑：环境变量 > 偏好里的 browser.channel > 本机第一个装了的
  const picked = resolveBrowser()
  if (!picked?.path) throw new Error('没找到 Chrome/Edge 可执行文件')
  return picked.path
}

/** 读 Netscape 之外的普通 Cookie 串："a=1; b=2" */
export function readCookieString(file) {
  const raw = readFileSync(file, 'utf8').trim()
  return raw.replace(/^cookie:\s*/i, '').replace(/\r?\n/g, '; ').trim()
}

export class Browser {
  constructor() {
    this.proc = null
    this.profileDir = ''
    this.ws = null
    this.nextId = 1
    this.pending = new Map()
    this.events = new Map()
  }

  async launch({ port = 0, headless = true, extraArgs = [] } = {}) {
    const chrome = findChrome()
    this.profileDir = mkdtempSync(join(tmpdir(), 'fish-chrome-'))
    const args = [
      headless ? '--headless=new' : (extraArgs.some((a) => a.startsWith('--window-position')) ? '--window-size=1200,900' : '--start-maximized'),
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${this.profileDir}`,
      '--no-first-run',
      '--no-default-browser-check',
      // 无头才关 GPU；真窗口关掉会黑屏
      ...(headless ? ['--disable-gpu'] : []),
      '--window-size=1440,900',
      ...extraArgs,
      'about:blank',
    ]
    this.proc = spawn(chrome, args, { stdio: 'ignore', windowsHide: true })
    // 端口 0 时，真实端口写在 DevToolsActivePort 第一行
    let realPort = port
    if (!port) {
      const f = join(this.profileDir, 'DevToolsActivePort')
      for (let i = 0; i < 100; i++) {
        await sleep(200)
        if (existsSync(f)) {
          const [p] = readFileSync(f, 'utf8').split(/\r?\n/)
          if (p && Number(p) > 0) { realPort = Number(p); break }
        }
      }
    }
    if (!realPort) throw new Error('Chrome 没起来（拿不到调试端口）')
    this.port = realPort
    await this._connect()
    return this
  }

  async _connect() {
    for (let i = 0; i < 60; i++) {
      try {
        const res = await fetch(`http://127.0.0.1:${this.port}/json/list`)
        const list = await res.json()
        const page = list.find((t) => t.type === 'page')
        if (page?.webSocketDebuggerUrl) {
          this.ws = new WebSocket(page.webSocketDebuggerUrl)
          await new Promise((resolve, reject) => {
            this.ws.addEventListener('open', resolve, { once: true })
            this.ws.addEventListener('error', reject, { once: true })
          })
          this.ws.addEventListener('message', (ev) => this._onMessage(ev))
          return
        }
      } catch { /* 还没起来 */ }
      await sleep(250)
    }
    throw new Error('连不上页面 target')
  }

  _onMessage(ev) {
    let msg
    try { msg = JSON.parse(ev.data) } catch { return }
    if (msg.id && this.pending.has(msg.id)) {
      const { resolve, reject } = this.pending.get(msg.id)
      this.pending.delete(msg.id)
      if (msg.error) reject(new Error(`${msg.error.message}${msg.error.data ? ' — ' + msg.error.data : ''}`))
      else resolve(msg.result)
      return
    }
    if (msg.method) {
      const subs = this.events.get(msg.method) || []
      for (const fn of subs) { try { fn(msg.params) } catch { /* 监听器自己崩了不算事 */ } }
    }
  }

  send(method, params = {}, timeout = 30_000) {
    if (!this.ws) return Promise.reject(new Error('CDP 未连接'))
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`CDP 超时：${method}`))
      }, timeout)
      this.pending.set(id, {
        resolve: (v) => { clearTimeout(timer); resolve(v) },
        reject: (e) => { clearTimeout(timer); reject(e) },
      })
      this.ws.send(JSON.stringify({ id, method, params }))
    })
  }

  on(method, fn) {
    const arr = this.events.get(method) || []
    arr.push(fn)
    this.events.set(method, arr)
  }

  /** 取消某个监听（on 的配对），避免长跑进程里监听越堆越多 */
  off(method, fn) {
    const arr = this.events.get(method) || []
    const i = arr.indexOf(fn)
    if (i >= 0) arr.splice(i, 1)
    this.events.set(method, arr)
  }

  /** 在页面里跑一段表达式，返回 JSON 值 */
  async eval(expression, { awaitPromise = false, timeout = 30_000 } = {}) {
    const r = await this.send('Runtime.evaluate', {
      expression, returnByValue: true, awaitPromise, userGesture: true,
    }, timeout)
    if (r?.exceptionDetails) {
      throw new Error('页面里报错：' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text))
    }
    return r?.result?.value
  }

  /** 注入 Cookie 串（domain 默认 .douyin.com） */
  async setCookies(cookieString, domain = '.douyin.com') {
    await this.send('Network.enable')
    const pairs = String(cookieString || '').split(';').map((s) => s.trim()).filter(Boolean)
    for (const pair of pairs) {
      const eq = pair.indexOf('=')
      if (eq <= 0) continue
      const name = pair.slice(0, eq).trim()
      const value = pair.slice(eq + 1).trim()
      try {
        await this.send('Network.setCookie', { name, value, domain, path: '/', secure: true })
      } catch { /* 单条失败不挡整体 */ }
    }
    return pairs.length
  }

  /** 把当前浏览器里的 douyin Cookie 全导出来（登录后落盘用） */
  async getCookies() {
    await this.send('Network.enable')
    const r = await this.send('Network.getAllCookies')
    const list = (r?.cookies || []).filter((c) => /douyin\.com$/.test(c.domain || '') || /\.douyin\.com$/.test(c.domain || ''))
    return list
  }

  /** 拼成一条 Cookie 头（name=value; name=value） */
  async cookieHeader() {
    const list = await this.getCookies()
    return list.map((c) => c.name + '=' + c.value).join('; ')
  }
  async goto(url, waitMs = 6000) {
    await this.send('Page.enable')
    await this.send('Page.navigate', { url })
    await sleep(waitMs)
  }

  async close() {
    try { this.ws?.close() } catch { /* 已经关了 */ }
    try { this.proc?.kill() } catch { /* 可能已经退了 */ }
    await sleep(300)
    try { if (this.profileDir) rmSync(this.profileDir, { recursive: true, force: true }) } catch { /* 临时目录删不掉不影响 */ }
  }
}
