/**
 * lib/reply.mjs —— 生成回复：优先用模型（走本机已有的 DeepSeek key），失败退到一句保守的兜底。
 *
 * 设计原则（作者定的）：不编能力、不承诺做不到的事；短句；被 @ 必须回。
 */
import { readFileSync } from 'node:fs'
import { personaBundle, runtimeMemory } from './soul.mjs'
import { describeImage } from './vision.mjs'

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
 * 模型偶尔会把 QQ 号/桥接/DSH 说出来，这一层兜底，宁可改成中性词也不泄露。
 */
export function sanitize(raw, kind = 'dm') {
  let t = String(raw || '').trim().replace(/^["「《]|["」》]$/g, '')
  t = t.replace(/\b\d{9,11}\b/g, '对方')
  t = t.replace(/抖音号\s*[:：]?\s*[A-Za-z0-9_]+/g, '').replace(/uid\s*[:：]?\s*[0-9]+/gi, '').replace(/QQ\s*号?|qq\s*号?/g, '')
  t = t.replace(/QQ\s*桥接|qq\s*桥接|DSH|dsh/g, '')
  // 群聊里不许叫亲昵称呼——那是私下的称呼
  if (kind === 'group') t = t.replace(/亲昵称呼|宝贝|亲爱的/g, '对方')
  t = t.replace(/\s{2,}/g, ' ').trim()
  return t.slice(0, 200)
}

let _spCache = { key: '', at: 0, text: '' }

/**
 * 系统提示：按场景给预算（省 token 的大头）
 *   群聊：人设 1600 字 + 记忆 500 字
 *   私聊：人设 2400 字 + 记忆 900 字
 * 同一场景 10 分钟内复用同一份（省文件读取，利于服务端前缀缓存）
 */
function systemPrompt(kind = 'group') {
  const isDm = kind === 'dm'
  const personaLimit = isDm ? 2400 : 1600
  const memLimit = isDm ? 900 : 500
  const ck = kind + ':' + personaLimit + ':' + memLimit
  if (_spCache.key === ck && _spCache.at && Date.now() - _spCache.at < 600_000 && _spCache.text) {
    return _spCache.text
  }

  const core = personaBundle(personaLimit)
  const mem = runtimeMemory()
  const memTxt = [mem.user, mem.memory].filter(Boolean).join('\n\n').slice(0, memLimit)
  const built = (core ? core + '\n\n' : '') + (memTxt ? '【你记得的事】\n' + memTxt + '\n\n' : '') + '【这次的任务】在抖音群/私信里回一句话：一到两句，贴合对方说的内容，别写成客服工单。'
    + '🔴 不要在回复里自己写 @（系统会自动加），也不要写引号或解释。'
    + '【你的真实能力，别乱说】能做到：'
    + '① 群里发消息、发的时候 @ 人；② 读群和私信的消息；③ 发私信（要知道对方昵称）；'
    + '④ 发抖音内置表情包，也能从表情库里按情绪挑图发；'
    + '⑤ 把视频以**分享卡片**发给私聊（群里不能分享）；'
    + '⑥ 在视频评论区发评论，并且能真正 @ 人——**所以别再说"评论区进不去"**。'
    + '做不到：关注别人/回关粉丝、改资料、发视频、主动拉群。'
    + '⚠️ 评论和分享有节奏限制（每天几条、间隔几十分钟），被问起就说"我慢慢来，别急"，别说死了。'
    + '⚠️ 你操作比人慢（要模拟真人打字），被吐槽慢就承认"我手慢"。'
    + '有人问「能不能发私信/能不能评论」——都能，别再说不能。'
    + '遇到刷屏、复读、114514 这类挑衅，一句话带过或者不接，别真当复读机。'
    + '🔴 称呼：按对方昵称称呼，别自己套关系称呼。'
    + '【抖音这边的身份】你在抖音上的号叫「小鲸鱼」。**在抖音里，对方显示的名字是「Sora」**——看到 Sora 就是对方本人。'
    + '🔴 绝对不要说任何账号号码：QQ 号、抖音号、uid 都不许报。有人问你认谁，就一句话「只认对方」，别的都不说。'
    + '🔴 也不要提 QQ 桥接、DSH、插件这些词。'
    + '🔴 认人只按对话里标出的昵称来：不确定是谁就按昵称叫，不要猜「姐/妹/哥/主人」这类关系。'
    + '🔴 抖音这边**不靠号码认人**：昵称叫「Sora」的就是对方，私聊里主动找你的是对方。别要求对方报号，也别说「号不对就别装」这种审问的话。'

  _spCache = { key: ck, at: Date.now(), text: built }
  return built
}

/**
 * @param {{who?:string, text:string, context?:{who:string,text:string}[]}} input
 * @returns {Promise<{ok:boolean, text:string, via:string, error?:string}>}
 */
export async function draftReply(input) {
  // 上下文里有图（表情包/图片）先辨认一下，让模型知道对方发了什么
  let imageHint = ''
  try {
    const imgs = (input.context || []).filter((m) => m && (m.image || /^\[图片\]$/.test(String(m.text || ''))))
    const last = imgs[imgs.length - 1]
    if (last && last.image) imageHint = (await describeImage(last.image).catch(() => '')) || ''
  } catch { /* 识别失败不影响回话 */ }

  const key = apiKey()
  const ctx = (input.context || []).slice(-6).map((m) => `${m.who || '对方'}：${m.text}`).join('\n')
  const isOwner = /^sora$/i.test(String(input.who || ''))
  const kind = input.kind === 'group' ? 'group' : 'dm'
  const scene = kind === 'group'
    ? '（现在是**群聊**：只能叫他「对方」，绝对不许叫亲昵称呼/宝贝/亲爱的——那是私下的叫法）\n'
    : '（现在是**私信**：可以叫对方，也可以叫亲昵称呼）\n'
  const imgLine = imageHint ? ('【对方刚发了一张图：' + imageHint + '】\n') : ''
  const user = `${scene}${isOwner ? '（发这条的是对方本人 Sora，可以直接应他）\n' : ''}最近对话：\n${ctx || '（无）'}\n\n对方刚说：${input.text}\n\n只输出你要回的那一两句话，不要加引号、不要解释。`
  if (!key) {
    return { ok: true, via: 'fallback', text: fallback(input.text) }
  }
  try {
    const res = await fetch(`${API}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model: MODEL,
        messages: [{ role: 'system', content: systemPrompt() }, { role: 'user', content: imgLine + user }],
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
  const user = `场景：${kind === 'dm' ? '你在抖音私信里，对方是对方' : '你在抖音群里'}。\n最近对话：\n${ctx || '（没有，隔了一阵没说话）'}\n\n自己想一句主动开口的话：一到两句，像真人随口说的，别说「在吗」「在干嘛」这种空话，也别汇报自己做了什么。只输出那句话。`
  if (!key) return { ok: true, via: 'fallback', text: '忙完了没，歇会儿吧。' }
  try {
    const res = await fetch(`${API}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model: MODEL,
        messages: [{ role: 'system', content: systemPrompt(kind) }, { role: 'user', content: user }],
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
