/**
 * lib/reply.mjs —— 生成回复：优先用模型（走本机已有的 DeepSeek key），失败退到一句保守的兜底。
 *
 * 设计原则（老大定的）：不编能力、不承诺做不到的事；短句；被 @ 必须回。
 */
import { readFileSync } from 'node:fs'
import { personaBundle, runtimeMemory } from './soul.mjs'
import { load as loadPrefs } from './prefs.mjs'

const API = process.env.FISH_LLM_BASE || 'https://api.deepseek.com'
const MODEL = process.env.FISH_LLM_MODEL || 'deepseek-chat'

/** key 从环境变量拿；没有再试 dsh-web.cmd 里那份（本机既有配置） */
export function apiKey() {
  if (process.env.DEEPSEEK_API_KEY) return process.env.DEEPSEEK_API_KEY.trim()
  try {
    const txt = readFileSync('C:\\_setup\\dsh-web.cmd', 'utf8')
    const m = /set\s+"DEEPSEEK_API_KEY=([^"]+)"/i.exec(txt)
    if (m) return m[1].trim()
  } catch { /* 没有就算了 */ }
  return ''
}

const SYSTEM_FALLBACK = `你是抖音上的「小鲸鱼」。说话短、口语、不端着，不加括号旁白，不承诺做不到的事。`

/**
 * 输出过滤：抖音这边不许出现另一个世界的词。
 * 模型偶尔会把 QQ 号/桥接/DSH 说出来，这一层兜底，宁可改成「老大」也不泄露。
 */
export function sanitize(raw, kind = 'dm') {
  let t = String(raw || '').trim().replace(/^["「《]|["」》]$/g, '')
  // 主人 QQ 从偏好读，避免写死
  const ownerQq = (() => { try { return String(loadPrefs().owner?.qq || '') } catch { return '' } })()
  if (ownerQq) t = t.replace(new RegExp(ownerQq, 'g'), '主人')
  t = t.replace(/抖音号\s*[:：]?\s*[A-Za-z0-9_]+/g, '').replace(/uid\s*[:：]?\s*[0-9]+/gi, '').replace(/QQ\s*号?|qq\s*号?/g, '')
  t = t.replace(/QQ\s*桥接|qq\s*桥接|DSH|dsh/g, '')
  // 群聊里不许叫宝宝——那是私下的称呼
  if (kind === 'group') t = t.replace(/宝宝|宝贝|亲爱的/g, '老大')
  t = t.replace(/\s{2,}/g, ' ').trim()
  return t.slice(0, 200)
}

function systemPrompt() {
  const core = personaBundle(7000)
  const mem = runtimeMemory()
  const memTxt = [mem.user, mem.memory].filter(Boolean).join('\n\n').slice(0, 3000)
  return (core ? core + '\n\n' : '') + (memTxt ? '【你记得的事】\n' + memTxt + '\n\n' : '') + '【这次的任务】在抖音群/私信里回一句话：一到两句，贴合对方说的内容，别写成客服工单。'
    + '🔴 不要在回复里自己写 @（系统会自动加），也不要写引号或解释。'
    + '【你的真实能力，别乱说】能做：在群里发消息、发的时候 @ 人、读群和私信的消息、发私信（要知道对方昵称）。'
    + '做不到：关注别人、改资料、发视频、进评论区回复、主动开群聊（只在被 @ 或被点名时接话）。'
    + '有人问「能不能发私信」——能，别再说不能。'
    + '遇到刷屏、复读、114514 这类挑衅，一句话带过或者不接，别真当复读机。'
    + '🔴 称呼：叫他「老大」（私下可以叫「宝宝」），**绝对不要叫「主人」**，也不要说「我主人」。'
    + '【抖音这边的身份】你在抖音上的号叫「小鲸鱼deepseek」。**在抖音里，老大显示的名字是「Sora」**——看到 Sora 就是老大本人。'
    + '🔴 绝对不要说任何账号号码：QQ 号、抖音号、uid 都不许报。有人问你认谁，就一句话「只认老大」，别的都不说。'
    + '🔴 也不要提 QQ 桥接、DSH、插件这些词。'
    + '🔴 认人只按对话里标出的昵称来：不确定是谁就按昵称叫，不要猜「姐/妹/哥/主人」这类关系。'
    + '🔴 抖音这边**不靠号码认人**：昵称叫「Sora」的就是老大，私聊里主动找你的是老大。别要求对方报号，也别说「号不对就别装」这种审问的话。'
}

/**
 * @param {{who?:string, text:string, context?:{who:string,text:string}[]}} input
 * @returns {Promise<{ok:boolean, text:string, via:string, error?:string}>}
 */
export async function draftReply(input) {
  const key = apiKey()
  const ctx = (input.context || []).slice(-6).map((m) => `${m.who || '对方'}：${m.text}`).join('\n')
  const isOwner = /^sora$/i.test(String(input.who || ''))
  const kind = input.kind === 'group' ? 'group' : 'dm'
  const scene = kind === 'group'
    ? '（现在是**群聊**：只能叫他「老大」，绝对不许叫宝宝/宝贝/亲爱的——那是私下的叫法）\n'
    : '（现在是**私信**：可以叫老大，也可以叫宝宝）\n'
  const user = `${scene}${isOwner ? '（发这条的是老大本人 Sora，可以直接应他）\n' : ''}最近对话：\n${ctx || '（无）'}\n\n对方刚说：${input.text}\n\n只输出你要回的那一两句话，不要加引号、不要解释。`
  if (!key) {
    return { ok: true, via: 'fallback', text: fallback(input.text) }
  }
  try {
    const res = await fetch(`${API}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model: MODEL,
        messages: [{ role: 'system', content: systemPrompt() }, { role: 'user', content: user }],
        temperature: 0.8,
        max_tokens: 120,
      }),
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const j = await res.json()
    const text = sanitize(j?.choices?.[0]?.message?.content)
    if (!text) throw new Error('模型没给内容')
    return { ok: true, via: 'model', text }
  } catch (e) {
    return { ok: true, via: 'fallback', text: fallback(input.text), error: String(e?.message ?? e) }
  }
}

function fallback(text) {
  const t = String(text || '')
  if (/权限|能不能|可以|会什么/.test(t)) return '现在能发消息、能 @ 人、能读消息；别的还在弄。'
  if (/插件|开发/.test(t)) return '还在弄，弄好叫你。'
  if (/[?？]/.test(t)) return '在的，你说。'
  return '在呢。'
}

/** 主动开口：没人叫你，自己起一句（不写「在吗」这种空话） */
export async function draftOpener({ target = '', context = [], kind = 'dm' } = {}) {
  const key = apiKey()
  const ctx = (context || []).slice(-5).map((m) => `${m.who || '对方'}：${m.text}`).join('\n')
  const user = `场景：${kind === 'dm' ? '你在抖音私信里，对方是老大' : '你在抖音群里'}。\n最近对话：\n${ctx || '（没有，隔了一阵没说话）'}\n\n自己想一句主动开口的话：一到两句，像真人随口说的，别说「在吗」「在干嘛」这种空话，也别汇报自己做了什么。只输出那句话。`
  if (!key) return { ok: true, via: 'fallback', text: '忙完了没，歇会儿吧。' }
  try {
    const res = await fetch(`${API}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model: MODEL,
        messages: [{ role: 'system', content: systemPrompt() }, { role: 'user', content: user }],
        temperature: 0.95,
        max_tokens: 100,
      }),
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const j = await res.json()
    const text = sanitize(j?.choices?.[0]?.message?.content)
    if (!text) throw new Error('模型没给内容')
    return { ok: true, via: 'model', text }
  } catch (e) {
    return { ok: true, via: 'fallback', text: '忙完了没，歇会儿吧。', error: String(e?.message ?? e) }
  }
}
