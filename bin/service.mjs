/**
 * bin/service.mjs —— 抖音后台服务（对标 QQ 桥接的 3100）
 *
 * 设计原则（使用者 2026-11-09 定）：**不操作电脑**。
 * 所有动作都走进程内的无头浏览器（CDP），不弹窗、不抢焦点、不动鼠标键盘。
 *
 * 端口 3110，接口：
 *   GET  /health            活着吗、浏览器在不在、监听着没
 *   GET  /status            账号 / 偏好 / 监听状态
 *   POST /send   {to,text,at?}      发一条（私信或群，at=昵称则 @）
 *   GET  /read?to=&n=       读最近几条
 *   POST /sticker {to,keyword?}     发内置表情
 *   POST /watch  {on:true}          开关群监听
 *   POST /proactive {force?:true}   跑一次主动聊天（force 忽略安静时段）
 *
 * 监听本身交给 bin/watch.mjs 子进程跑（它已经过实测），服务只做监管与转发。
 */
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ensureHome, PATHS } from '../lib/paths.mjs'
import { load as loadPrefs, save as savePrefs } from '../lib/prefs.mjs'
import { runBin } from '../lib/util.mjs'
import { browserSummary } from '../lib/browsers.mjs'
import { scan as scanMemes, pick as pickMeme } from '../lib/memes.mjs'
import { phase as trafficPhase, hourly as trafficHourly } from '../lib/traffic.mjs'
import { nextChange } from '../lib/valley.mjs'
import { bump as bumpStat, today as statToday, recent as statRecent } from '../lib/stats.mjs'
import { getPlan, quota, isPlanTime, nextRunAt, DEFAULT_PLAN } from '../lib/plan.mjs'
import { check as guardCheck, mark as guardMark, jitterMs, status as guardStatus } from '../lib/guard.mjs'
import { soulStatus, localPersona, localMemory, saveLocalPersona, saveLocalMemory, identityMode } from '../lib/soul.mjs'
import { Browser, readCookieString } from '../lib/cdp.mjs'
import { openChat, openConversation, readRecent } from '../lib/douyin.mjs'
import { cookieFile } from '../lib/account.mjs'
import { postComment } from '../lib/comment-post.mjs'
import { replyComment } from '../lib/comment-reply.mjs'

// ---- 常驻浏览器（开关：prefs.keepBrowser）----
let warm = null
let warmAt = 0
let warmTimer = null

async function getWarm() {
  if (warm) { warmAt = Date.now(); return warm }
  warm = await new Browser().launch({ headless: true })
  await warm.setCookies(readCookieString(cookieFile()))
  await openChat(warm)
  warmAt = Date.now()
  log('[warm] 常驻浏览器已启动')
  if (warmTimer) clearInterval(warmTimer)
  // 5 分钟没人用就关掉，别白占内存
  warmTimer = setInterval(async () => {
    if (!warm) return
    if (Date.now() - warmAt < 300_000) return
    try { await warm.close() } catch { /* 已经退了 */ }
    warm = null
    log('[warm] 闲置 5 分钟，已关闭')
  }, 60_000)
  return warm
}

async function closeWarm() {
  if (warmTimer) { clearInterval(warmTimer); warmTimer = null }
  if (!warm) return
  try { await warm.close() } catch { /* 已经退了 */ }
  warm = null
  log('[warm] 已关闭')
}

const HERE = dirname(fileURLToPath(import.meta.url))
const PORT = Number(process.env.FISH_PORT || 3110)
const ROOT_DIR = join(HERE, '..')
const HOME = process.env.DSH_FISH_HOME || join(process.env.USERPROFILE || '', '.dsh', 'fish')
const LOG = join(PATHS.home, 'service.log')
const STATE = join(PATHS.home, 'service-state.json')

const log = (m) => {
  const line = `[${new Date().toISOString()}] ${m}`
  console.log(line)
  try { ensureHome(); writeFileSync(LOG, (existsSync(LOG) ? readFileSync(LOG, 'utf8') : '') + line + '\n') } catch { /* 日志写不进不影响服务 */ }
}

let watchChild = null
const readCache = new Map()   // to -> { at, data }

/** 分享串行锁：多个分享同时跑会互相干扰（页面没加载好/面板打不开） */
let shareChain = Promise.resolve()
function withShareLock(fn) {
  const run = shareChain.then(fn, fn)
  shareChain = run.catch(() => {})
  return run
}
let lastCleanup = null

/**
 * 每天清一遍缓存：
 *   · shots/ 截图超过 3 天就删
 *   · 日志超过 5MB 留最后 2000 行
 *   · 登录 Cookie 只留最新 3 份
 *   · 临时 fish-chrome-* 目录超过 1 天就删
 */
function cleanupCaches() {
  const t0 = Date.now()
  const home = process.env.DSH_FISH_HOME || join(process.env.USERPROFILE || '', '.dsh', 'fish')
  const now = Date.now()
  const DAY = 86_400_000
  const report = {
    shots: { removed: 0, freedBytes: 0, names: [] },
    logs: [],                       // [{ file, fromBytes, toBytes }]
    cookies: { removed: 0, kept: 0, names: [] },
    chromeDirs: { removed: 0, freedBytes: 0, names: [] },
    readCache: 0,
    totalFreedBytes: 0,
  }
  const addFreed = (bytes) => { report.totalFreedBytes += Number(bytes) || 0 }

  // 截图：超过 3 天
  try {
    const dir = join(home, 'shots')
    for (const f of readdirSync(dir)) {
      const fp = join(dir, f)
      try {
        const st = statSync(fp)
        if (now - st.mtimeMs > 3 * DAY) {
          unlinkSync(fp)
          report.shots.removed++
          report.shots.freedBytes += st.size
          addFreed(st.size)
          if (report.shots.names.length < 5) report.shots.names.push(f)
        }
      } catch { /* 单文件失败跳过 */ }
    }
  } catch { /* 没有截图目录 */ }

  // 日志：超过 5MB 截断到 2000 行
  for (const name of ['service.log', 'watch.log', 'watch-dm.log', 'proactive.log']) {
    const fp = join(home, name)
    try {
      const st = statSync(fp)
      if (st.size > 5 * 1024 * 1024) {
        const lines = readFileSync(fp, 'utf8').split(/\r?\n/)
        writeFileSync(fp, lines.slice(-2000).join('\n'), 'utf8')
        let after = st.size
        try { after = statSync(fp).size } catch { /* 就当没变 */ }
        report.logs.push({ file: name, fromBytes: st.size, toBytes: after })
        addFreed(st.size - after)
      }
    } catch { /* 没有这个日志 */ }
  }

  // 登录 Cookie：只留最新 3 份
  try {
    const dir = join(home, 'accounts')
    const files = readdirSync(dir)
      .filter((f) => /^cookie-.*\.txt$/.test(f))
      .map((f) => ({ f, m: statSync(join(dir, f)).mtimeMs }))
      .sort((a, b) => b.m - a.m)
    report.cookies.kept = Math.min(3, files.length)
    for (const { f } of files.slice(3)) {
      try {
        const fp = join(dir, f)
        const size = statSync(fp).size
        unlinkSync(fp)
        report.cookies.removed++
        if (report.cookies.names.length < 5) report.cookies.names.push(f)
        addFreed(size)
      } catch { /* 跳过 */ }
    }
  } catch { /* 没有账号目录 */ }

  // 临时浏览器目录（超过 1 天）
  try {
    for (const d of readdirSync(tmpdir())) {
      if (!d.startsWith('fish-chrome-')) continue
      const fp = join(tmpdir(), d)
      try {
        const st = statSync(fp)
        if (now - st.mtimeMs > DAY) {
          rmSync(fp, { recursive: true, force: true })
          report.chromeDirs.removed++
          if (report.chromeDirs.names.length < 5) report.chromeDirs.names.push(d)
        }
      } catch { /* 跳过 */ }
    }
  } catch { /* tmp 读不到 */ }

  // 内存里的读消息缓存
  report.readCache = readCache.size
  readCache.clear()

  report.durationMs = Date.now() - t0
  lastCleanup = { at: new Date().toISOString(), report }
  log('[cleanup] ' + JSON.stringify({ freed: report.totalFreedBytes, shots: report.shots.removed, logs: report.logs.length, cookies: report.cookies.removed, dirs: report.chromeDirs.removed, ms: report.durationMs }))
  return lastCleanup
}
const READ_TTL = 15_000
let watchDmChild = null

function startWatch() {
  if (watchChild) return { ok: true, already: true }
  const prefs = loadPrefs()
  const groups = (prefs.groupWhitelist || []).filter(Boolean)
  if (!groups.length) return { ok: false, error: 'groupWhitelist 是空的，先配群' }
  // 群名单交给 watch 自己从偏好读（里面是 {id,name} 对象，塞参数会变成 [object Object]）
  const args = ['bin/watch.mjs', '--interval', String(prefs.watchIntervalSec || 25)]
  watchChild = spawn(process.execPath, args, { cwd: join(HERE, '..'), windowsHide: true, env: process.env })
  watchChild.stdout.on('data', (d) => log('[watch] ' + d.toString().trim()))
  watchChild.stderr.on('data', (d) => log('[watch:err] ' + d.toString().trim()))
  watchChild.on('exit', (code) => { log(`[watch] 退出 code=${code}`); watchChild = null })
  savePrefs({ watchEnabled: true })
  return { ok: true, pid: watchChild.pid, groups }
}

function startWatchDm() {
  if (watchDmChild) return { ok: true, already: true }
  const prefs = loadPrefs()
  const peers = (prefs.dmPeers || []).filter(Boolean)
  if (!peers.length) return { ok: false, error: 'dmPeers 是空的，先配私信对象' }
  watchDmChild = spawn(process.execPath, ['bin/watch-dm.mjs', '--interval', String(prefs.watchIntervalSec || 8)], {
    cwd: ROOT_DIR, windowsHide: true, env: process.env,
  })
  watchDmChild.stdout.on('data', (d) => log('[watch-dm] ' + d.toString().trim()))
  watchDmChild.stderr.on('data', (d) => log('[watch-dm:err] ' + d.toString().trim()))
  watchDmChild.on('exit', (code) => { log('[watch-dm] 退出 code=' + code); watchDmChild = null })
  savePrefs({ watchDmEnabled: true })
  return { ok: true, pid: watchDmChild.pid, peers }
}

function stopWatchDm() {
  if (!watchDmChild) { savePrefs({ watchDmEnabled: false }); return { ok: true, already: true } }
  try { watchDmChild.kill() } catch { /* 已退 */ }
  watchDmChild = null
  savePrefs({ watchDmEnabled: false })
  return { ok: true }
}

function stopWatch() {
  if (!watchChild) { savePrefs({ watchEnabled: false }); return { ok: true, already: true } }
  try { watchChild.kill() } catch { /* 已经退了 */ }
  watchChild = null
  savePrefs({ watchEnabled: false })
  return { ok: true }
}

function body(req) {
  return new Promise((resolve) => {
    let s = ''
    req.on('data', (d) => { s += d.toString() })
    req.on('end', () => { try { resolve(s ? JSON.parse(s) : {}) } catch { resolve({}) } })
  })
}

// 面板跑在 DSH 网页里（另一个端口），跨域是必须放行的
const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET,POST,OPTIONS',
  'access-control-allow-headers': 'content-type',
}

function json(res, code, value) {
  const s = JSON.stringify(value)
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(s),
    ...CORS,
  })
  res.end(s)
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1')
  const p = url.pathname
  if (req.method === 'OPTIONS') { res.writeHead(204, CORS); res.end(); return }
  try {
    if (p === '/health') {
      return json(res, 200, { ok: true, pid: process.pid, watch: Boolean(watchChild), watchPid: watchChild?.pid || null, since: STATE.since })
    }
    if (p === '/icon') {
      // 侧边栏自定义图标：把图片放到 ~/.dsh/fish/icon.png 就生效
      try {
        const file = join(HOME, 'icon.png')
        const buf = readFileSync(file)
        res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'no-cache', ...CORS })
        return res.end(buf)
      } catch {
        return json(res, 404, { ok: false, error: '没有 icon.png（放到 ~/.dsh/fish/icon.png）' })
      }
    }
    if (p === '/restart' && req.method === 'POST') {
      // 交给外部脚本：先回响应，再重启（本进程会被杀）
      setTimeout(() => {
        try {
          spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', 'C:\\_setup\\fish-restart.ps1'], {
            detached: true, stdio: 'ignore', windowsHide: true,
          }).unref()
        } catch { /* 起不来就算了 */ }
      }, 300)
      return json(res, 200, { ok: true, restarting: true, hint: '3~5 秒后自动回来' })
    }
    if (p === '/cleanup' && req.method === 'POST') {
      const r = cleanupCaches()
      return json(res, 200, { ok: true, ...r })
    }
    if (p === '/diag') {
      // 体检 + 最近报错：面板上点「诊断」就看这个
      const prefsNow = loadPrefs()
      const lastErr = []
      try {
        const lines = readFileSync(LOG, 'utf8').split(/\r?\n/).filter(Boolean)
        for (const line of lines.slice(-400)) {
          if (/出错|error|失败|Error|退出 code=[1-9]|超时/.test(line)) lastErr.push(line.slice(0, 220))
        }
      } catch { /* 没日志就当没有 */ }

      const checks = []
      checks.push({ name: '后台服务', ok: true, detail: '127.0.0.1:' + PORT + '（你现在能打开这个页面就说明它活着）' })
      try {
        const b = browserSummary()
        checks.push({ name: '浏览器', ok: Boolean(b.current?.path), detail: b.current?.name || '没找到' })
      } catch (e) { checks.push({ name: '浏览器', ok: false, detail: String(e?.message ?? e) }) }

      const acc = prefsNow.account || {}
      let cookieOk = false
      let cookieDetail = '没有配置登录态'
      try {
        const txt = readFileSync(acc.cookieFile, 'utf8')
        cookieOk = txt.includes('sessionid') || txt.length > 200
        cookieDetail = (acc.nick || '未知账号') + ' · ' + (cookieOk ? 'Cookie 有内容（' + txt.length + ' 字节）' : 'Cookie 太短，可能已失效')
      } catch (e) { cookieDetail = '读不到 Cookie 文件：' + String(e?.message ?? e) }
      checks.push({ name: '登录态', ok: cookieOk, detail: cookieDetail })

      checks.push({ name: '群监听', ok: Boolean(watchChild), detail: watchChild ? '运行中 pid=' + watchChild.pid : '没开' })
      checks.push({ name: '私信监听', ok: Boolean(watchDmChild), detail: watchDmChild ? '运行中 pid=' + watchDmChild.pid : '没开' })
      checks.push({ name: '常驻浏览器', ok: Boolean(warm) || prefsNow.keepBrowser === true, detail: warm ? '运行中' : (prefsNow.keepBrowser ? '开关开着，下次读取时启动' : '未启用') })

      let chromeCount = 0
      try {
        chromeCount = readdirSync(tmpdir()).filter((f) => f.startsWith('fish-chrome-')).length
      } catch { /* 忽略 */ }
      checks.push({ name: '残留浏览器目录', ok: chromeCount < 5, detail: chromeCount + ' 个临时 profile 目录' })

      return json(res, 200, {
        ok: true,
        checks,
        lastErrors: lastErr.slice(-8),
        lastCleanup,
        logFile: LOG,
        version: '0.1.0',
      })
    }
    if (p === '/run' && req.method === 'POST') {
      const b = await body(req)
      const manual = b.manual !== false
      const t0 = Date.now()
      const q = quota(statToday())
      if (q.left <= 0) {
        return json(res, 200, { ok: false, error: '今天的额度用完了（' + q.total + '/' + q.perDay + '）', quota: q })
      }
      const perRun = Math.max(1, Math.min(10, Number(getPlan().perRun) || 3))
      const r = await runBin('bin/recommend.mjs', ['--top', String(Math.min(q.left, perRun))])
      const list = (r && r.list) || []
      if (list.length) {
        try { bumpStat(manual ? 'recommend_manual' : 'recommend_auto', list.length) } catch { /* 忽略 */ }
      }

      // ⭐ 拉完就发：**只发卡片**（用户 2026-11-09 定：不要文字分享）
      let shared = null
      const autoShare = b.autoShare !== undefined ? b.autoShare === true : (getPlan().autoSend === true)
      if (autoShare && list.length) {
        const prefsNow = loadPrefs()
        const target = (prefsNow.share && prefsNow.share.targets && prefsNow.share.targets[0]) || ''
        const results = []
        if (target) {
          // 每一条都发一张卡片：每条最多试 3 次，间隔拉长（页面/面板需要时间）
          const tryShare = async (item, attempt) => withShareLock(async () => {
            const r2 = await runBin('bin/share.mjs', [
              '--aweme', String(item.aweme_id), '--to', String(target),
              '--reason', String(item.desc || '').slice(0, 60), '--force',
            ])
            if (r2 && r2.ok) return r2
            if (attempt >= 3) return r2
            await new Promise((ok) => setTimeout(ok, 6000 + attempt * 3000))
            return tryShare(item, attempt + 1)
          })

          for (const item of list) {
            const r2 = await tryShare(item, 1)
            if (r2 && r2.ok) { try { bumpStat('share') } catch { /* 忽略 */ } }
            results.push({
              aweme: item.aweme_id,
              via: (r2 && r2.via) || 'card',
              ok: Boolean(r2 && r2.ok),
              error: (r2 && (r2.error || r2.reason)) || '',
            })
            await new Promise((ok) => setTimeout(ok, 8000))   // 每条之间歇 8 秒
          }
        } else {
          results.push({ via: 'none', ok: false, error: '没配私聊对象（share.targets 为空）' })
        }
        shared = { target, results }
      }

      return json(res, 200, {
        ok: Boolean(r && r.ok),
        manual,
        count: list.length,
        ms: Date.now() - t0,
        list: list.slice(0, 10),
        shared,
        quota: { ...quota(statToday()), nextRunAt: nextRunAt() },
        guard: guardStatus(),
      })
    }
    if (p === '/plan') {
      if (req.method === 'POST') {
        const b = await body(req)
        const cur = getPlan()
        const patch = {
          ...cur,
          ...(typeof b.enabled === 'boolean' ? { enabled: b.enabled } : {}),
          ...(typeof b.autoSend === 'boolean' ? { autoSend: b.autoSend } : {}),
          ...(b.perDay !== undefined ? { perDay: Math.max(1, Math.min(50, Number(b.perDay) || 10)) } : {}),
          ...(b.perRun !== undefined ? { perRun: Math.max(1, Math.min(10, Number(b.perRun) || 3)) } : {}),
          ...(Array.isArray(b.times)
            ? { times: b.times.map((t) => String(t).trim()).filter((t) => /^\d{2}:\d{2}$/.test(t)).slice(0, 6) }
            : {}),
        }
        savePrefs({ plan: patch })
        return json(res, 200, { ok: true, quota: { ...quota(statToday()), nextRunAt: nextRunAt() } })
      }
      return json(res, 200, { ok: true, quota: { ...quota(statToday()), nextRunAt: nextRunAt() } })
    }
    if (p === '/share/random' && req.method === 'POST') {
      const b = await body(req)
      const prefsNow = loadPrefs()
      const target = (b.to && String(b.to).trim())
        || (prefsNow.share && prefsNow.share.targets && prefsNow.share.targets[0])
        || ''
      if (!target) return json(res, 200, { ok: false, error: '没有私聊对象（settings.targets 为空）' })
      if (prefsNow.share && prefsNow.share.allowGroups === true) {
        // 故意的：即便配置允许，这个接口只走私聊
      }
      const sg = guardCheck('share')
      if (!sg.ok) return json(res, 200, { ok: false, skipped: true, error: '先别发：' + sg.reason, guard: sg })
      await new Promise((r2) => setTimeout(r2, jitterMs()))
      const rec = await runBin('bin/recommend.mjs', ['--top', '8'])
      const list = (rec && rec.list) || []
      if (!list.length) return json(res, 200, { ok: false, error: '没拉到候选视频' })
      const pickIdx = Math.floor(Math.random() * list.length)
      const item = list[pickIdx]
      const r = await withShareLock(async () => {
        let last = null
        for (let attempt = 1; attempt <= 3; attempt++) {
          last = await runBin('bin/share.mjs', ['--aweme', String(item.aweme_id), '--to', String(target), '--force'])
          if (last && last.ok) return last
          log('[share/random] 第 ' + attempt + ' 次失败：' + ((last && (last.error || last.reason)) || '未知'))
          if (attempt < 3) await new Promise((ok) => setTimeout(ok, 6000 * attempt))
        }
        return last
      })
      if (r && r.ok) { try { bumpStat('share'); guardMark('share') } catch { /* 忽略 */ } }
      return json(res, 200, {
        ok: Boolean(r && r.ok),
        to: target,
        via: (r && r.via) || 'card',
        error: (r && (r.error || r.reason)) || '',
        picked: { aweme_id: item.aweme_id, desc: String(item.desc || '').slice(0, 60), score: item.score },
        candidates: list.length,
      })
    }
    if (p === '/comment/mention' && req.method === 'POST') {
      const b = await body(req)
      const aweme = String(b.aweme || '').trim()
      const name = String(b.name || '').trim()
      const text = String(b.text || '').trim()
      if (!aweme || !name) return json(res, 400, { ok: false, error: '缺 aweme 或 name' })
      // 编码坏掉的中文会变成一连串问号，宁可拒绝也别发出去
      if (/\?{3,}/.test(text)) return json(res, 400, { ok: false, error: '正文出现连续问号（编码坏了），已拒绝发布' })
      if (b.dry !== true && b.confirm !== true) {
        return json(res, 200, { ok: true, sent: false, needsConfirm: true, draft: '@' + name + ' ' + text })
      }
      if (b.dry !== true) {
        const g = guardCheck('comment')
        if (!g.ok) return json(res, 200, { ok: false, error: '先别发：' + g.reason, guard: g })
        await new Promise((r2) => setTimeout(r2, jitterMs()))
      }
      // 走自己的实现：昵称必须完全一致且唯一，做不到就不发（宁可不发，也不 @ 错人）
      try {
        const browser = warm || await new Browser().launch({ headless: true })
        await browser.setCookies(readCookieString(cookieFile()))
        const r = await postComment(browser, {
          awemeId: aweme,
          url: 'https://www.douyin.com/video/' + aweme,
          text,
          at: name,
          atId: (loadPrefs().owner && loadPrefs().owner.douyinId) || '',
          dry: b.dry === true,
        })
        if (!warm) { try { await browser.close() } catch { /* 忽略 */ } }
        if (r && r.ok) { try { bumpStat('comment'); guardMark('comment') } catch { /* 忽略 */ } }
        return json(res, 200, r)
      } catch (e) {
        return json(res, 200, { ok: false, error: '评论失败：' + String(e?.message ?? e) })
      }
    }    if (p === '/convos') {
      const prefsNow = loadPrefs()
      const dm = Array.isArray(prefsNow.dmPeers) ? prefsNow.dmPeers.slice() : []
      const groups = Array.isArray(prefsNow.groupWhitelist) && prefsNow.groupWhitelist.length
        ? prefsNow.groupWhitelist.slice()
        : (Array.isArray(prefsNow.groups) ? prefsNow.groups.slice() : [])
      const pending = Array.isArray(prefsNow.pendingGroups) ? prefsNow.pendingGroups.slice() : []

      if (req.method === 'POST') {
        const b = await body(req)
        const name = String(b.name || '').trim()
        const act = String(b.action || '')
        if (!act) return json(res, 400, { ok: false, error: '缺 action' })
        if (!name && act !== 'confirm') return json(res, 400, { ok: false, error: '缺 name' })

        if (act === 'addDm') {
          if (!dm.includes(name)) dm.push(name)
          savePrefs({ dmPeers: dm })
          if (watchDmChild) { stopWatchDm(); startWatchDm() }   // 让监听立刻带上新对象
        } else if (act === 'removeDm') {
          savePrefs({ dmPeers: dm.filter((x) => x !== name) })
          if (watchDmChild) { stopWatchDm(); startWatchDm() }
        } else if (act === 'requestGroup') {
          if (!pending.includes(name) && !groups.some((g) => (typeof g === 'string' ? g : g && g.name) === name)) pending.push(name)
          savePrefs({ pendingGroups: pending })
        } else if (act === 'confirmGroup' || act === 'rejectGroup') {
          const idx = pending.indexOf(name)
          if (idx >= 0) pending.splice(idx, 1)
          const nextGroups = act === 'confirmGroup'
            ? (groups.some((g) => (typeof g === 'string' ? g : g && g.name) === name) ? groups : groups.concat([name]))
            : groups
          savePrefs({ pendingGroups: pending, groupWhitelist: nextGroups, groups: nextGroups })
          if (act === 'confirmGroup' && watchChild) { stopWatch(); startWatch() }
        } else if (act === 'removeGroup') {
          const left = groups.filter((g) => (typeof g === 'string' ? g : g && g.name) !== name)
          savePrefs({ groupWhitelist: left, groups: left })
          if (watchChild) { stopWatch(); startWatch() }
        } else {
          return json(res, 400, { ok: false, error: '未知 action：' + act })
        }
      }

      const after = loadPrefs()
      return json(res, 200, {
        ok: true,
        dmPeers: after.dmPeers || [],
        groups: after.groupWhitelist || after.groups || [],
        pendingGroups: after.pendingGroups || [],
      })
    }
    if (p === '/memes') {
      const lib = scanMemes()
      return json(res, 200, {
        ok: true, total: lib.total, tags: lib.tags,
        sources: lib.sources, primary: lib.primary, ownDir: lib.ownDir, chosen: lib.chosen,
      })
    }
    if (p === '/meme' && req.method === 'POST') {
      const b = await body(req)
      if (!b.to) return json(res, 400, { ok: false, error: '缺 to' })
      const hit = pickMeme({ tag: b.tag || '', query: b.query || '' })
      if (!hit) return json(res, 200, { ok: false, error: '图库里没有匹配的表情（看看 /memes 有哪些分类）' })
      const r = await runBin('bin/sticker.mjs', ['--to', String(b.to), '--image', hit.path])
      if (r && r.ok) { try { bumpStat('sticker') } catch { /* 忽略 */ } }
      return json(res, 200, { ...r, meme: { tag: hit.tag, name: hit.name } })
    }
    if (p === '/stickers') {
      const prefsNow = loadPrefs()
      const dir = (prefsNow.stickerDir && String(prefsNow.stickerDir).trim()) || join(ROOT_DIR, 'stickers')
      if (req.method === 'POST') {
        const b = await body(req)
        if (typeof b.dir === 'string') savePrefs({ stickerDir: b.dir.trim() })
      if (typeof b.source === 'string' && ['auto', 'qq', 'dsh-meme', 'custom', 'own'].includes(b.source)) {
        savePrefs({ memeSource: b.source })
      }
      }
      let files = []
      try {
        files = readdirSync(dir).filter((f) => /\.(png|jpe?g|gif|webp)$/i.test(f))
      } catch { files = [] }
      const lib = scanMemes()
      return json(res, 200, {
        ok: true, dir, exists: existsSync(dir), count: files.length, files: files.slice(0, 30),
        sources: lib.sources, chosen: lib.chosen,
      })
    }
    if (p === '/identity') {
      if (req.method === 'POST') {
        const b = await body(req)
        if (b.mode && ['qq', 'local', 'both'].includes(b.mode)) {
          savePrefs({ identity: { ...(loadPrefs().identity || {}), mode: b.mode } })
        }
        if (b.owner && typeof b.owner === 'object') {
          const cur = loadPrefs().owner || {}
          savePrefs({
            owner: {
              ...cur,
              ...(typeof b.owner.nick === 'string' ? { nick: b.owner.nick.trim() } : {}),
              ...(typeof b.owner.douyinId === 'string' ? { douyinId: b.owner.douyinId.trim() } : {}),
              ...(typeof b.owner.qq === 'string' ? { qq: b.owner.qq.trim() } : {}),
              ...(typeof b.owner.alias === 'string' ? { alias: b.owner.alias.trim() } : {}),
            },
          })
        }
        if (typeof b.persona === 'string') saveLocalPersona(b.persona)
        if (b.videoPrefs && typeof b.videoPrefs === 'object') {
          const cur = loadPrefs().videoPrefs || {}
          const clean = (arr) => (Array.isArray(arr) ? arr.map((x) => String(x).trim()).filter(Boolean).slice(0, 60) : cur[arr] || [])
          savePrefs({
            videoPrefs: {
              ...cur,
              ...(Array.isArray(b.videoPrefs.keywords) ? { keywords: clean(b.videoPrefs.keywords) } : {}),
              ...(Array.isArray(b.videoPrefs.channels) ? { channels: clean(b.videoPrefs.channels) } : {}),
              ...(Array.isArray(b.videoPrefs.authors) ? { authors: clean(b.videoPrefs.authors) } : {}),
              ...(Array.isArray(b.videoPrefs.avoid) ? { avoid: clean(b.videoPrefs.avoid) } : {}),
              ...(b.videoPrefs.perDay !== undefined ? { perDay: Math.max(1, Math.min(50, Number(b.videoPrefs.perDay) || 10)) } : {}),
            },
          })
        }
        if (typeof b.memory === 'string') saveLocalMemory(b.memory)
      }
      return json(res, 200, {
        ok: true,
        mode: identityMode(),
        owner: loadPrefs().owner || {},
        videoPrefs: loadPrefs().videoPrefs || {},
        qq: soulStatus(),
        local: { persona: localPersona(), memory: localMemory() },
      })
    }
    if (p === '/env') {
      const prefs = loadPrefs()
      const acc = prefs.account || {}
      const nodeOk = Number(process.versions.node.split('.')[0]) >= 18
      let chromeOk = false
      let chromeName = ''
      try { const b = browserSummary(); chromeOk = Boolean(b.current?.path); chromeName = b.current?.name || '' } catch { /* 没有浏览器 */ }
      const cookieOk = Boolean(acc.cookieFile) && (() => { try { return readFileSync(acc.cookieFile, 'utf8').length > 50 } catch { return false } })()
      return json(res, 200, {
        ok: true,
        checks: [
          { name: '运行环境', ok: nodeOk, detail: 'Node ' + process.versions.node },
          { name: '浏览器', ok: chromeOk, detail: chromeName || '没找到 Chrome/Edge' },
          { name: '后台服务', ok: true, detail: '127.0.0.1:' + PORT },
          { name: '登录态', ok: cookieOk, detail: cookieOk ? '已保存' : '未登录' },
        ],
        account: acc.nick ? { nick: acc.nick, id: acc.id || '' } : null,
        browsers: (() => { try { return browserSummary() } catch { return null } })(),
      })
    }
    if (p === '/browser' && req.method === 'POST') {
      const b = await body(req)
      const want = String(b.channel || '').trim().toLowerCase()
      if (!want) return json(res, 400, { ok: false, error: '缺 channel' })
      const saved = savePrefs({ browser: { ...(loadPrefs().browser || {}), channel: want } })
      return json(res, 200, { ok: true, browser: saved.browser, summary: (() => { try { return browserSummary() } catch { return null } })() })
    }
    if (p === '/login' && req.method === 'POST') {
      // 开一个（可见的）浏览器让用户自己登；登完 login.mjs 会存 Cookie 并关掉
      const child = spawn(process.execPath, ['bin/login.mjs', '--mode', 'visible', '--timeout', '600'], {
        cwd: ROOT_DIR, env: process.env, windowsHide: true, detached: true, stdio: 'ignore',
      })
      child.unref()
      return json(res, 200, { ok: true, started: true, pid: child.pid, hint: '浏览器已打开，请在那里登录；完成后会自动保存' })
    }
    if (p === '/logout' && req.method === 'POST') {
      savePrefs({ account: { id: '', nick: '', cookieFile: '' } })
      return json(res, 200, { ok: true, loggedOut: true })
    }
    if (p === '/status') {
      const prefs = loadPrefs()
      return json(res, 200, {
        guard: guardStatus(),
        ok: true,
        account: prefs.account || null,
        participation: prefs.participation,
        groups: prefs.groupWhitelist || [],
        dmPeers: prefs.dmPeers || [],
        proactive: prefs.proactive?.enabled === true,
        watch: Boolean(watchChild),
        watchDm: Boolean(watchDmChild),
        shareEnabled: prefs.share?.enabled === true,
        shareGroups: prefs.share?.allowGroups === true,
        shareTargets: prefs.share?.targets || [],
        keepBrowser: prefs.keepBrowser === true,
        cleanup: prefs.cleanup || { enabled: true, hour: 4 },
        peakAvoid: prefs.peakAvoid || { enabled: false, hours: [] },
        valley: prefs.valley || { onlyValley: false, windows: [] },
        quota: quota(statToday()),
        stats: (() => {
          try { return { today: statToday(), recent: statRecent(7) } } catch { return null }
        })(),
        traffic: (() => {
          try {
            const p = trafficPhase()
            const h = trafficHourly()
            const nx = nextChange(prefs, new Date(), h)
            return {
              phase: p.phase, source: p.source, todayCount: p.todayCount, basePerHour: p.basePerHour,
              hour: p.hour, days: h.days, hours: h.hours,
              nextIdle: nx.nextIdle, nextPeak: nx.nextPeak,
            }
          } catch { return null }
        })(),
        lastCleanup,
        stickerDir: (() => {
          const d = (prefs.stickerDir && String(prefs.stickerDir).trim()) || join(ROOT_DIR, 'stickers')
          let c = 0
          try { c = readdirSync(d).filter((f) => /\.(png|jpe?g|gif|webp)$/i.test(f)).length } catch { /* 目录不存在 */ }
          return { dir: d, count: c }
        })(),
        warmRunning: Boolean(warm),
        browser: (() => { try { return browserSummary() } catch { return null } })(),
        persona: (() => { try { return soulStatus() } catch { return null } })(),
      })
    }
    if (p === '/send' && req.method === 'POST') {
      const b = await body(req)
      if (!b.to || !b.text) return json(res, 400, { ok: false, error: '缺 to 或 text' })
      const args = ['bin/send.mjs', '--to', String(b.to), '--text', String(b.text)]
      if (b.at) args.push('--at', String(b.at))
      const r = await runBin(args[0], args.slice(1))
      if (r && r.ok) { try { bumpStat('reply') } catch { /* 统计失败不影响发送 */ } }
      return json(res, 200, r)
    }
    if (p === '/read') {
      const to = url.searchParams.get('to')
      if (!to) return json(res, 400, { ok: false, error: '缺 to' })
      const prefsNow = loadPrefs()
      const key = to + '|' + (url.searchParams.get('n') || '8')
      const hit = readCache.get(key)
      if (hit && Date.now() - hit.at < READ_TTL) {
        return json(res, 200, { ...hit.data, cached: true, ageMs: Date.now() - hit.at })
      }
      let data
      if (prefsNow.keepBrowser === true) {
        try {
          const b = await getWarm()
          const opened = await openConversation(b, to)
          if (!opened?.ok) throw new Error('找不到会话「' + to + '」')
          const msgs = await readRecent(b, Number(url.searchParams.get('n') || '8') || 8)
          data = { ok: true, to, count: msgs.length, messages: msgs, warm: true }
        } catch (e) {
          // 常驻浏览器坏了：关掉重来一次，还失败就退回子进程
          await closeWarm()
          try {
            const b2 = await getWarm()
            await openConversation(b2, to)
            const msgs2 = await readRecent(b2, Number(url.searchParams.get('n') || '8') || 8)
            data = { ok: true, to, count: msgs2.length, messages: msgs2, warm: true }
          } catch {
            data = await runBin('bin/read.mjs', ['--to', to, '--n', url.searchParams.get('n') || '8'])
          }
        }
      } else {
        data = await runBin('bin/read.mjs', ['--to', to, '--n', url.searchParams.get('n') || '8'])
      }
      if (data && data.ok) readCache.set(key, { at: Date.now(), data })
      return json(res, 200, data)
    }
    if (p === '/sticker' && req.method === 'POST') {
      const b = await body(req)
      if (!b.to) return json(res, 400, { ok: false, error: '缺 to' })
      const args = ['bin/sticker.mjs', '--to', String(b.to)]
      if (b.image) args.push('--image', String(b.image))
      else if (b.random) args.push('--random')
      else if (b.keyword) args.push('--emoji', String(b.keyword))
      const r = await runBin(args[0], args.slice(1))
      if (r && r.ok) { try { bumpStat('sticker') } catch { /* 忽略 */ } }
      return json(res, 200, r)
    }
    if (p === '/comments' && req.method === 'POST') {
      const b = await body(req)
      if (!b.url) return json(res, 400, { ok: false, error: '缺 url' })
      return json(res, 200, await runBin('bin/comments.mjs', ['read', '--url', String(b.url), '--n', String(Number(b.n) || 20)]))
    }
    if (p === '/comment/reply' && req.method === 'POST') {
      const b = await body(req)
      if (!b.url || !b.text) return json(res, 400, { ok: false, error: '缺 url 或 text' })
      if (/\?{3,}/.test(String(b.text))) return json(res, 400, { ok: false, error: '正文出现连续问号（编码坏了），已拒绝' })
      try {
        const browser = warm || await new Browser().launch({ headless: true })
        await browser.setCookies(readCookieString(cookieFile()))
        const r = await replyComment(browser, {
          url: String(b.url),
          index: Number(b.index) || 0,
          match: String(b.match || ''),
          text: String(b.text),
          dry: b.dry === true,
        })
        if (!warm) { try { await browser.close() } catch { /* 忽略 */ } }
        if (r && r.ok) { try { bumpStat('comment'); guardMark('comment') } catch { /* 忽略 */ } }
        return json(res, 200, r)
      } catch (e) {
        return json(res, 200, { ok: false, error: '回复失败：' + String(e?.message ?? e) })
      }
    }
    if (p === '/share' && req.method === 'POST') {
      const b = await body(req)
      if (!b.aweme && !b.url) return json(res, 400, { ok: false, error: '缺 aweme（视频 id）' })
      const args = ['bin/share.mjs', '--aweme', String(b.aweme || '')]
      if (b.to) args.push('--to', String(b.to))
      if (b.reason) args.push('--reason', String(b.reason))
      if (b.title) args.push('--title', String(b.title))
      if (b.mode) args.push('--mode', String(b.mode))
      if (b.dry) args.push('--dry')
      if (b.force) args.push('--force')
      return json(res, 200, await runBin(args[0], args.slice(1)))
    }
    if (p === '/look' && req.method === 'POST') {
      const b = await body(req)
      const args = ['bin/look.mjs', '--url', String(b.url || 'https://www.douyin.com/'), '--name', String(b.name || 'look')]
      return json(res, 200, await runBin(args[0], args.slice(1)))
    }
    if (p === '/recommend' && req.method === 'POST') {
      const b = await body(req)
      const args = ['bin/recommend.mjs', '--top', String(Number(b.top) || 10), '--pages', String(Number(b.pages) || 3)]
      return json(res, 200, await runBin(args[0], args.slice(1)))
    }
    if (p === '/recommend/share' && req.method === 'POST') {
      const b = await body(req)
      const rec = await runBin('bin/recommend.mjs', ['--top', '1', '--pages', '2'])
      const pick = rec?.list?.[0]
      if (!pick) return json(res, 200, { ok: false, error: '没拉到候选', raw: rec })
      const args = ['bin/share.mjs', '--aweme', pick.aweme_id, '--reason', String(b.reason || '这个我刷到了，觉得你会喜欢'), '--title', pick.desc.slice(0, 40)]
      if (b.to) args.push('--to', String(b.to))
      return json(res, 200, { ok: true, pick, sent: await runBin(args[0], args.slice(1)) })
    }
    if (p === '/watch-dm' && req.method === 'POST') {
      const b = await body(req)
      return json(res, 200, b.on === false ? stopWatchDm() : startWatchDm())
    }
    if (p === '/settings' && req.method === 'POST') {
      const b = await body(req)
      const prefs = loadPrefs()
      const patch = {}
      if (typeof b.participation === 'string') patch.participation = b.participation
      if (typeof b.proactive === 'boolean') patch.proactive = { ...(prefs.proactive || {}), enabled: b.proactive }
      if (typeof b.shareEnabled === 'boolean' || typeof b.shareGroups === 'boolean') {
        patch.share = {
          ...(prefs.share || {}),
          ...(typeof b.shareEnabled === 'boolean' ? { enabled: b.shareEnabled } : {}),
          ...(typeof b.shareGroups === 'boolean' ? { allowGroups: b.shareGroups } : {}),
        }
      }
      if (b.valley && typeof b.valley === 'object') {
        patch.valley = {
          ...(prefs.valley || {}),
          ...(typeof b.valley.onlyValley === 'boolean' ? { onlyValley: b.valley.onlyValley } : {}),
          ...(typeof b.valley.auto === 'boolean' ? { auto: b.valley.auto } : {}),
          ...(typeof b.valley.mode === 'string' && ['adaptive', 'onlyIdle', 'always'].includes(b.valley.mode) ? { mode: b.valley.mode } : {}),
          ...(Array.isArray(b.valley.windows)
            ? {
              windows: b.valley.windows
                .map((w2) => ({ start: Math.max(0, Math.min(23, Number(w2.start) || 0)), end: Math.max(0, Math.min(23, Number(w2.end) || 0)) }))
                .slice(0, 4),
            }
            : {}),
        }
      }
      if (b.peakAvoid && typeof b.peakAvoid === 'object') {
        patch.peakAvoid = {
          ...(prefs.peakAvoid || {}),
          ...(typeof b.peakAvoid.enabled === 'boolean' ? { enabled: b.peakAvoid.enabled } : {}),
          ...(Array.isArray(b.peakAvoid.hours) ? { hours: b.peakAvoid.hours.map(Number).filter((h) => h >= 0 && h <= 23) } : {}),
        }
      }
      if (b.cleanup && typeof b.cleanup === 'object') {
        patch.cleanup = {
          ...(prefs.cleanup || {}),
          ...(typeof b.cleanup.enabled === 'boolean' ? { enabled: b.cleanup.enabled } : {}),
          ...(b.cleanup.hour !== undefined ? { hour: Math.max(0, Math.min(23, Number(b.cleanup.hour) || 0)) } : {}),
        }
      }
      // ⭐ 限速可自定义：每天最多几条、两条之间至少隔几分钟
      if (b.guard && typeof b.guard === 'object') {
        const clamp = (v, lo, hi, dflt) => {
          const n2 = Number(v)
          if (!Number.isFinite(n2)) return dflt
          return Math.max(lo, Math.min(hi, Math.round(n2)))
        }
        const g0 = prefs.guard || {}
        patch.guard = {
          ...g0,
          ...(b.guard.commentPerDay !== undefined ? { commentPerDay: clamp(b.guard.commentPerDay, 0, 50, g0.commentPerDay ?? 3) } : {}),
          ...(b.guard.commentGapMin !== undefined ? { commentGapMin: clamp(b.guard.commentGapMin, 0, 1440, g0.commentGapMin ?? 45) } : {}),
          ...(b.guard.sharePerDay !== undefined ? { sharePerDay: clamp(b.guard.sharePerDay, 0, 200, g0.sharePerDay ?? 10) } : {}),
          ...(b.guard.shareGapMin !== undefined ? { shareGapMin: clamp(b.guard.shareGapMin, 0, 1440, g0.shareGapMin ?? 10) } : {}),
        }
      }
      if (typeof b.keepBrowser === 'boolean') {
        patch.keepBrowser = b.keepBrowser
        if (!b.keepBrowser) await closeWarm()
      }
      if (typeof b.watchDm === 'boolean') { if (b.watchDm) startWatchDm(); else stopWatchDm() }
      if (typeof b.watch === 'boolean') { if (b.watch) startWatch(); else stopWatch() }
      const saved = Object.keys(patch).length ? savePrefs(patch) : prefs
      return json(res, 200, {
        ok: true,
        participation: saved.participation,
        proactive: saved.proactive?.enabled === true,
        shareEnabled: saved.share?.enabled === true,
        shareGroups: saved.share?.allowGroups === true,
        keepBrowser: saved.keepBrowser === true,
        cleanup: saved.cleanup || null,
        peakAvoid: saved.peakAvoid || null,
        valley: saved.valley || null,
        guard: saved.guard || null,
        warmRunning: Boolean(warm),
        watch: Boolean(watchChild),
        watchDm: Boolean(watchDmChild),
      })
    }
    if (p === '/watch' && req.method === 'POST') {
      const b = await body(req)
      return json(res, 200, b.on === false ? stopWatch() : startWatch())
    }
    if (p === '/proactive' && req.method === 'POST') {
      const b = await body(req)
      const args = ['bin/proactive.mjs']
      if (b.mode) args.push('--mode', String(b.mode))
      if (b.dry) args.push('--dry')
      if (b.force) args.push('--force')
      return json(res, 200, await runBin(args[0], args.slice(1)))
    }
    json(res, 404, { ok: false, error: '没有这个接口' })
  } catch (e) {
    json(res, 500, { ok: false, error: String(e?.message ?? e) })
  }
})

server.listen(PORT, '127.0.0.1', () => {
  try { cleanupCaches() } catch (e) { log('[cleanup] 失败：' + String(e?.message ?? e)) }
  setInterval(() => { try { cleanupCaches() } catch { /* 定时清理失败不影响服务 */ } }, 6 * 3600_000)

  // 自动计划：每到点跑一轮推荐（额度、暂停都在 lib/plan.mjs 里判）
  let lastPlanKey = ''
  setInterval(async () => {
    try {
      if (!isPlanTime()) return
      const now = new Date()
      const key = now.toISOString().slice(0, 13) + ':' + now.getMinutes()
      if (key === lastPlanKey) return
      lastPlanKey = key
      const q = quota(statToday())
      if (q.left <= 0) { log('[plan] 额度已用完，跳过'); return }
      log('[plan] 到点，跑一轮推荐（剩余额度 ' + q.left + '）')
      const perRun = Math.max(1, Math.min(10, Number(getPlan().perRun) || 3))
      // 统一走 /run：推荐 + （自动分享开着时）发送，计数在那边做
      const resp = await fetch('http://127.0.0.1:' + PORT + '/run', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ manual: false, autoShare: getPlan().autoSend === true }),
      })
      const jj = await resp.json().catch(() => null)
      const sharedN = (jj && jj.shared && jj.shared.results) ? jj.shared.results.length : 0
      log('[plan] 本轮 ' + ((jj && jj.count) || 0) + ' 条' + (sharedN ? '，已自动分享 ' + sharedN + ' 项' : ''))
    } catch (e) { log('[plan] 失败：' + String(e?.message ?? e)) }
  }, 60_000)
  ensureHome()
  const state = { since: new Date().toISOString(), port: PORT }
  try { writeFileSync(STATE, JSON.stringify(state, null, 2), 'utf8') } catch { /* ignore */ }
  log(`抖音后台服务已起：http://127.0.0.1:${PORT}`)
  // 开机时如果之前是开着的，自动恢复监听
  const prefs = loadPrefs()
  if (prefs.watchDmEnabled === true) {
    const r2 = startWatchDm()
    log('自动恢复私信监听：' + JSON.stringify(r2))
  }
  if (prefs.watchEnabled === true) {
    const r = startWatch()
    log('自动恢复监听：' + JSON.stringify(r))
  }
})

function shutdown(sig) {
  log('收到 ' + sig + '，收工')
  stopWatch()
  server.close(() => process.exit(0))
  setTimeout(() => process.exit(0), 3000)
}
process.on('SIGINT', () => { closeWarm(); shutdown('SIGINT') })
process.on('SIGTERM', () => { closeWarm(); shutdown('SIGTERM') })
