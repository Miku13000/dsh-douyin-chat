/**
 * bin/comment-mention-bridge.mjs —— 评论区真 @（桥接已跑通的实现）
 *
 * 我们自己的 UI 实现还在调（lib/comment-post.mjs），这个桥先保证能用：
 * 调本机已装的 dsh-douyin-scroll 里验证过的 comment-mention-ui.mjs。
 *
 *   node bin/comment-mention-bridge.mjs --aweme <id> --name <昵称> --text "正文" [--dry]
 *
 * 路径：环境变量 DOUYIN_SCROLL_DIR 或偏好 prefs.douyinScrollDir（指向那个插件目录）
 */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { arg, flag } from '../lib/util.mjs'
import { load as loadPrefs } from '../lib/prefs.mjs'

const aweme = arg('--aweme') || ''
const name = arg('--name') || ''
const text = arg('--text') || ''
const dry = flag('--dry')

const prefs = (() => { try { return loadPrefs() } catch { return {} } })()
const root = process.env.DOUYIN_SCROLL_DIR || prefs.douyinScrollDir || ''
const script = join(root, 'tools', 'comment-mention-ui.mjs')

function out(o) { console.log(JSON.stringify(o, null, 1)) }

if (!aweme || !name) { out({ ok: false, error: '缺 --aweme 或 --name' }); process.exit(2) }
if (!root) { out({ ok: false, error: '没配 DOUYIN_SCROLL_DIR（评论区 @ 人需要本机已装该插件）' }); process.exit(2) }
if (!existsSync(script)) {
  out({ ok: false, error: '找不到已跑通的执行器：' + script, hint: '设 DOUYIN_SCROLL_DIR 指向 dsh-douyin-scroll 目录' })
  process.exit(2)
}

const args = [script, '--aweme', aweme, '--name', name, '--text', text]
if (dry) args.push('--dry')

const child = spawn(process.execPath, args, { cwd: root, windowsHide: true })
let stdout = ''
let stderr = ''
child.stdout.on('data', (d) => { stdout += d.toString() })
child.stderr.on('data', (d) => { stderr += d.toString() })
child.on('close', (code) => {
  const i = stdout.lastIndexOf('\n{')
  const raw = i >= 0 ? stdout.slice(i + 1) : stdout.slice(stdout.indexOf('{'))
  try {
    const j = JSON.parse(raw)
    out({ ...j, via: 'bridge', exitCode: code })
  } catch {
    out({ ok: false, error: '桥接执行器没返回可解析 JSON', exitCode: code, stdout: stdout.slice(-300), stderr: stderr.slice(-300) })
  }
})
