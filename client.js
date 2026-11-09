/**
 * 抖音群聊聊天 —— 客户端界面。
 *
 * 三个模块：群聊 / 私信 / 分享。
 * 数据全部来自 dsh-fish 的后台服务（127.0.0.1:3110），这里只做展示与操作。
 */
window.__ModuleLoader__.load({
  id: 'dsh-douyin-chat',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useState, useEffect, useCallback, useRef } = React

    const API = 'http://127.0.0.1:3110'

    const fmtBytes = (b) => {
      const n = Number(b) || 0
      if (n < 1024) return n + ' B'
      if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB'
      return (n / 1024 / 1024).toFixed(1) + ' MB'
    }
    async function call(path, options) {
      const res = await fetch(API + path, options)
      if (!res.ok) throw new Error('HTTP ' + res.status)
      return res.json()
    }
    const post = (path, body) => call(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body || {}),
    })

    const s = {
      page: { display: 'flex', flexDirection: 'column', height: '100%', minHeight: 420, padding: 14, gap: 10, overflowY: 'auto' },
      head: { display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' },
      tabs: { display: 'flex', gap: 6 },
      tab: (on) => ({
        padding: '4px 12px', borderRadius: 999, cursor: 'pointer', fontSize: 13,
        border: '1px solid ' + (on ? 'transparent' : 'var(--dsh-border, rgba(128,128,128,.3))'),
        background: on ? 'var(--dsh-accent, #3b82f6)' : 'transparent',
        color: on ? '#fff' : 'inherit',
      }),
      body: { flex: 1, minHeight: 0, display: 'flex', gap: 12 },
      col: { flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 8 },
      list: {
        flex: 1, minHeight: 220, overflowY: 'auto', border: '1px solid var(--dsh-border, rgba(128,128,128,.25))',
        borderRadius: 10, padding: 8, fontSize: 13,
      },
      msg: { padding: '4px 2px', borderBottom: '1px solid rgba(128,128,128,.12)' },
      who: { opacity: 0.6, marginRight: 6 },
      row: { display: 'flex', gap: 8 },
      input: {
        flex: 1, padding: '7px 10px', borderRadius: 8, fontSize: 13,
        border: '1px solid var(--dsh-border, rgba(128,128,128,.35))',
        background: 'transparent', color: 'inherit',
      },
      btn: {
        padding: '6px 14px', borderRadius: 8, cursor: 'pointer', fontSize: 13,
        border: '1px solid var(--dsh-border, rgba(128,128,128,.35))',
        background: 'transparent', color: 'inherit',
      },
      primary: {
        padding: '6px 14px', borderRadius: 8, cursor: 'pointer', fontSize: 13,
        border: '1px solid transparent', background: 'var(--dsh-accent, #3b82f6)', color: '#fff',
      },
      muted: { opacity: 0.6, fontSize: 12 },
      err: { color: '#dc2626', fontSize: 12 },
      online: { color: '#16a34a', fontSize: 12 },
      offline: { color: '#dc2626', fontSize: 12 },
    }

    // 会话消息缓存：切走再切回来不重新转圈；刷新在后台做
    const chatCache = new Map()   // target -> messages

    function ChatPane({ target, kind }) {
      const [msgs, setMsgs] = useState(() => chatCache.get(target) || [])
      const [slow, setSlow] = useState(false)
      const [tags, setTags] = useState([])
      const [showTags, setShowTags] = useState(false)
      const [text, setText] = useState('')
      const [busy, setBusy] = useState('')
      const [err, setErr] = useState('')
      const listRef = useRef(null)

      const load = useCallback(async (auto) => {
        if (!target) return
        const slowTimer = setTimeout(() => setSlow(true), 3000)
        if (!auto) setBusy('load')
        try {
          const r = await call('/read?to=' + encodeURIComponent(target) + '&n=30')
          if (r && r.ok) {
            const list = Array.isArray(r.messages) ? r.messages : []
            chatCache.set(target, list)
            setMsgs(list)
            setErr('')
          }
          else if (!auto) setErr(r && r.error ? r.error : '读不到消息')
        } catch (e) { if (!auto) setErr(String(e && e.message || e)) }
        finally { clearTimeout(slowTimer); setSlow(false); if (!auto) setBusy('') }
      }, [target])

      useEffect(() => { setMsgs([]); load(false) }, [load])

      useEffect(() => {
        call('/memes').then((r) => setTags((r && r.tags) || [])).catch(() => { /* 图库读不到就不显示分类 */ })
      }, [])

      const sendTag = useCallback(async (tag) => {
        if (!target) return
        setBusy('meme')
        try { await post('/meme', { to: target, tag }); await load(true) }
        catch (e) { setErr(String(e && e.message || e)) }
        finally { setBusy('') }
      }, [target, load])
      useEffect(() => {
        if (!target) return undefined
        const t = setInterval(() => load(true), 10000)
        return () => clearInterval(t)
      }, [target, load])
      useEffect(() => { const el = listRef.current; if (el) el.scrollTop = el.scrollHeight }, [msgs])

      const send = useCallback(async () => {
        const t = text.trim()
        if (!t || !target) return
        setBusy('send')
        try {
          const r = await post('/send', { to: target, text: t })
          if (r && r.ok) { setText(''); setErr(''); await load(true) }
          else setErr(r && r.error ? r.error : '发送失败')
        } catch (e) { setErr(String(e && e.message || e)) } finally { setBusy('') }
      }, [text, target, load])

      if (!target) return h('div', { style: s.muted }, kind === 'group' ? '左边选一个群' : '左边选一个人')

      return h('div', { style: s.col },
        h('div', { style: s.head },
          h('div', { style: { fontWeight: 600 } }, target),
          h('div', { style: s.muted }, kind === 'group' ? '群聊' : '私信'),
          h('div', { style: { flex: 1 } }),
          h('button', { style: s.btn, disabled: busy === 'load', onClick: () => load(false) }, '刷新')
        ),
        h('div', { ref: listRef, style: s.list },
          msgs.length
            ? msgs.map((m, i) => h('div', { key: i, style: s.msg },
              m.who ? h('span', { style: s.who }, m.who + '：') : null,
              h('span', null, String(m.text || '').slice(0, 500))
            ))
            : h('div', { style: s.muted }, busy === 'load'
              ? (slow ? '读取中…（第一次要开无头浏览器，约 10 秒；之后会走缓存）' : '读取中…')
              : (err || '还没有消息'))
        ),
        h('div', { style: s.row },
          h('input', {
            style: s.input, value: text, placeholder: '说点什么…',
            onChange: (e) => setText(e.target.value),
            onKeyDown: (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send() } },
          }),
          h('button', { style: s.primary, disabled: busy === 'send', onClick: send }, busy === 'send' ? '发送中…' : '发送'),
          h('button', {
            style: s.btn,
            disabled: Boolean(busy),
            onClick: () => setShowTags(!showTags),
          }, showTags ? '表情 ▲' : '表情 ▼')
        ),
        showTags
          ? h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 6, paddingTop: 4 } },
            tags.length
              ? tags.map((t) => h('button', {
                key: t.tag,
                disabled: Boolean(busy),
                onClick: () => sendTag(t.tag),
                style: {
                  padding: '3px 10px', borderRadius: 999, cursor: 'pointer', fontSize: 12,
                  border: '1px solid var(--dsh-border, rgba(128,128,128,.35))',
                  background: 'transparent', color: 'inherit',
                },
              }, t.tag + ' ' + t.count))
              : h('span', { style: s.muted }, '图库没读到（看设置里的表情包路径）')
          )
          : null,
        err ? h('div', { style: s.err }, err) : null
      )
    }

    function SharePane() {
      const [status, setStatus] = useState(null)
      const [busy, setBusy] = useState(false)
      const [last, setLast] = useState(null)

      useEffect(() => {
        call('/status').then(setStatus).catch(() => { /* 读不到就显示默认 */ })
      }, [])

      const target = ((status && status.shareTargets) || [])[0] || ''

      const roll = useCallback(async () => {
        setBusy(true)
        try {
          const r = await post('/share/random', {})
          setLast({
            at: new Date().toLocaleTimeString(),
            ok: Boolean(r && r.ok),
            text: r && r.ok
              ? ('已发出卡片：' + String((r.picked && r.picked.desc) || '').slice(0, 40))
              : ('失败：' + ((r && (r.error || r.reason)) || '未知')),
          })
        } catch (e) {
          setLast({ at: new Date().toLocaleTimeString(), ok: false, text: String(e && e.message || e) })
        } finally { setBusy(false) }
      }, [])

      return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 12, paddingTop: 8 } },
        h('div', { style: { fontSize: 13 } }, '随机分享给私聊'),
        h('div', { style: { opacity: 0.65, fontSize: 12, lineHeight: 1.8 } },
          '点一下：随机挑一条视频，以卡片发给 ' + (target ? '主人（' + target + '）' : '（还没配私聊对象）') + '。',
          h('br'),
          '群聊一律不发；每轮推荐也会自动发卡片，这里只是手动补一条。'
        ),
        h('div', { style: s.row },
          h('button', { style: s.primary, disabled: busy, onClick: roll }, busy ? '发送中…' : '随机分享一条'),
          h('button', {
            style: s.btn,
            disabled: busy,
            onClick: async () => { setBusy(true); try { setStatus(await call('/status')) } catch { /* 忽略 */ } finally { setBusy(false) } },
          }, '刷新状态')
        ),
        last
          ? h('div', { style: { fontSize: 12, opacity: 0.85 } },
            (last.ok ? '✓ ' : '✗ ') + last.at + ' · ' + last.text)
          : null
      )
    }

    const srow2 = { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, padding: '6px 0' }

    function Toggle({ label, desc, on, busy, onChange }) {
      return h('div', { style: srow2 },
        h('div', null,
          h('div', { style: { fontSize: 13 } }, label),
          desc ? h('div', { style: { opacity: 0.6, fontSize: 12 } }, desc) : null
        ),
        h('button', {
          onClick: () => { if (!busy) onChange(!on) },
          style: {
            width: 44, height: 24, borderRadius: 999, cursor: busy ? 'default' : 'pointer',
            border: '1px solid var(--dsh-border, rgba(128,128,128,.35))',
            background: on ? 'var(--dsh-accent, #3b82f6)' : 'transparent',
            position: 'relative',
          },
        }, h('span', {
          style: {
            position: 'absolute', top: 2, left: on ? 22 : 2, width: 18, height: 18,
            borderRadius: '50%', background: on ? '#fff' : 'var(--dsh-border, rgba(128,128,128,.7))',
          },
        }))
      )
    }

    /* ---------- 开始使用：环境 / 账号 / 诊断 / 概览 ---------- */
    function StartPanel() {
      const [env, setEnv] = useState(null)
      const [busy, setBusy] = useState('')
      const [msg, setMsg] = useState('')
      const [diag, setDiag] = useState(null)
      const [clean, setClean] = useState(null)
      const [stat, setStat] = useState(null)
      const [running, setRunning] = useState(false)
      const [lastRun, setLastRun] = useState(null)
      const [quota, setQuota] = useState(null)
      const [showPlan, setShowPlan] = useState(false)
      const [planTimes, setPlanTimes] = useState('09:00, 20:00')
      const [planPerDay, setPlanPerDay] = useState(20)
      const [planPerRun, setPlanPerRun] = useState(3)

      const refresh = useCallback(async () => {
        setBusy('env')
        try { setEnv(await call('/env')); setMsg('') }
        catch (e) { setEnv({ ok: false, error: String(e && e.message || e) }) }
        try { setStat(await call('/status')) } catch { /* 忽略 */ }
        try {
          const q = await call('/plan')
          setQuota(q.quota)
          setPlanTimes((q.quota.plan.times || []).join(', '))
          setPlanPerDay(q.quota.plan.perDay || 20)
          setPlanPerRun(q.quota.plan.perRun || 3)
        } catch { /* 忽略 */ }
        finally { setBusy('') }
      }, [])
      useEffect(() => { refresh() }, [refresh])

      const login = useCallback(async () => {
        setBusy('login')
        try { const d = await post('/login'); setMsg(d.hint || '浏览器已打开，请在那里登录') }
        catch (e) { setMsg('启动登录失败：' + String(e && e.message || e)) }
        finally { setBusy('') }
      }, [])
      const logout = useCallback(async () => {
        setBusy('logout')
        try { await post('/logout'); await refresh(); setMsg('已退出登录') }
        catch (e) { setMsg('退出失败：' + String(e && e.message || e)) }
        finally { setBusy('') }
      }, [refresh])
      const pickBrowser = useCallback(async (id) => {
        setBusy('browser')
        try { await post('/browser', { channel: id }); await refresh(); setMsg('浏览器已切到 ' + id) }
        catch (e) { setMsg('切换失败：' + String(e && e.message || e)) }
        finally { setBusy('') }
      }, [refresh])

      const runDiag = useCallback(async () => {
        setBusy('diag')
        try { setDiag(await call('/diag')) }
        catch (e) { setMsg('诊断失败：' + String(e && e.message || e)) }
        finally { setBusy('') }
      }, [])

      const runOnce = useCallback(async () => {
        setRunning(true)
        const t0 = Date.now()
        try {
          const r = await post('/proactive')
          setLastRun({ at: new Date().toLocaleString(), ms: Date.now() - t0, ok: Boolean(r && r.ok), detail: (r && (r.detail || r.reason)) || '' })
          await refresh()
        } catch (e) {
          setLastRun({ at: new Date().toLocaleString(), ms: Date.now() - t0, ok: false, detail: String(e && e.message || e) })
        } finally { setRunning(false) }
      }, [refresh])

      const runRecommend = useCallback(async () => {
        setRunning(true)
        const t0 = Date.now()
        try {
          const r = await post('/run', { manual: true })
          setLastRun({
            at: new Date().toLocaleString(), ms: Date.now() - t0,
            ok: Boolean(r && r.ok),
            detail: r && r.ok ? ('推荐 ' + r.count + ' 条' + (r.shared ? '，已自动分享' : '')) : ((r && r.error) || ''),
          })
          if (r && r.quota) setQuota(r.quota)
        } catch (e) {
          setLastRun({ at: new Date().toLocaleString(), ms: Date.now() - t0, ok: false, detail: String(e && e.message || e) })
        } finally { setRunning(false) }
      }, [])

      const savePlan = useCallback(async (patch) => {
        setBusy('plan')
        try {
          const r = await post('/plan', patch)
          if (r && r.quota) {
            setQuota(r.quota)
            setPlanTimes((r.quota.plan.times || []).join(', '))
            setPlanPerDay(r.quota.plan.perDay || 20)
            setPlanPerRun(r.quota.plan.perRun || 3)
          }
          setMsg('计划已保存')
        } catch (e) { setMsg('保存失败：' + String(e && e.message || e)) }
        finally { setBusy('') }
      }, [])

      const checks = (env && env.checks) || []
      const account = env && env.account
      const browsers = (env && env.browsers && env.browsers.installed) || []
      const curBrowser = (env && env.browsers && env.browsers.current && env.browsers.current.id) || ''

      return h('div', {
        style: {
          border: '1px solid var(--dsh-border, rgba(128,128,128,.25))',
          borderRadius: 12, padding: '12px 14px', marginBottom: 10,
        },
      },
        h('div', { style: { ...srow2, alignItems: 'flex-start' } },
          h('div', null,
            h('div', { style: { fontWeight: 600, fontSize: 14 } }, '开始使用'),
            h('div', { style: { opacity: 0.6, fontSize: 12 } }, '先确认环境和账号，再往下聊天。')
          ),
          h('div', { style: { display: 'flex', gap: 8 } },
            h('button', {
              style: s.btn, disabled: busy === 'clean',
              onClick: async () => {
                setBusy('clean')
                try { const r = await post('/cleanup'); setClean((r && r.report) || null); setMsg('清理完成') }
                catch (e) { setMsg('清理失败：' + String(e && e.message || e)) }
                finally { setBusy('') }
              },
            }, busy === 'clean' ? '清理中…' : '一键清理'),
            h('button', { style: s.btn, disabled: busy === 'diag', onClick: runDiag }, busy === 'diag' ? '诊断中…' : '诊断'),
            h('button', { style: s.btn, disabled: busy === 'env', onClick: refresh }, busy === 'env' ? '检查中…' : '检查环境')
          )
        ),
        checks.map((c) => {
          const canPick = c.name === '浏览器' && browsers.length > 1
          return h('div', { key: c.name, style: srow2 },
            h('div', { style: { display: 'flex', alignItems: 'center', gap: 8 } },
              h('span', { style: { color: c.ok ? '#16a34a' : '#dc2626', fontSize: 12 } }, c.ok ? '✓' : '✗'),
              h('span', { style: { fontSize: 13 } }, c.name)
            ),
            canPick
              ? h('select', {
                value: curBrowser, disabled: busy === 'browser',
                onChange: (e) => pickBrowser(e.target.value),
                style: {
                  padding: '3px 8px', borderRadius: 8, fontSize: 12,
                  border: '1px solid var(--dsh-border, rgba(128,128,128,.35))',
                  background: 'var(--dsh-surface, #1b1b1f)', color: 'inherit',
                },
              }, browsers.map((b) => h('option', { key: b.id, value: b.id, style: { color: '#111', background: '#fff' } }, b.name)))
              : h('span', { style: { opacity: 0.6, fontSize: 12 } }, c.detail)
          )
        }),
        h('div', { style: { ...srow2, borderTop: '1px solid rgba(128,128,128,.18)', marginTop: 6, paddingTop: 8 } },
          h('div', null,
            h('div', { style: { fontSize: 13 } }, '抖音账号'),
            h('div', { style: { opacity: 0.6, fontSize: 12 } }, account ? ('已保存登录态 · ' + account.nick) : '未登录')
          ),
          h('div', { style: { display: 'flex', gap: 8 } },
            h('button', { style: s.primary, disabled: busy === 'login', onClick: login }, busy === 'login' ? '启动中…' : '登录'),
            account ? h('button', { style: s.btn, disabled: busy === 'logout', onClick: logout }, '退出登录') : null
          )
        ),
        (() => {
          const today = (stat && stat.stats && stat.stats.today) || {}
          const cell = (label, v2) => h('div', { key: label, style: { textAlign: 'center', flex: 1 } },
            h('div', { style: { fontSize: 18, fontWeight: 600 } }, String(v2 || 0)),
            h('div', { style: { opacity: 0.6, fontSize: 11 } }, label)
          )
          return h('div', { style: { marginTop: 8 } },
            h('div', { style: { display: 'flex', gap: 8, padding: '6px 0' } },
              cell('回复', today.reply), cell('表情', today.sticker), cell('分享', today.share), cell('评论', today.comment)
            ),
            quota
              ? h('div', { style: { display: 'flex', alignItems: 'center', gap: 14, fontSize: 12, flexWrap: 'wrap', padding: '4px 0' } },
                h('span', null, '今日推荐 ' + quota.total + ' 条'),
                h('span', { style: { opacity: 0.75 } }, '自动 ' + quota.auto + ' / 上限 ' + quota.perDay),
                h('span', { style: { opacity: 0.75 } }, '手动 ' + quota.manual),
                h('span', { style: { opacity: 0.7 } }, quota.paused ? '｜自动计划已暂停' : ('｜下次自动 ' + (quota.nextRunAt || '—')))
              )
              : null,
            h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, marginTop: 4, flexWrap: 'wrap' } },
              h('button', { style: s.primary, disabled: running, onClick: runRecommend }, running ? '跑着呢…' : '跑一轮推荐'),
              h('button', { style: s.btn, disabled: busy === 'plan', onClick: () => setShowPlan(!showPlan) }, '调整计划 ' + (showPlan ? '▲' : '▼')),
              h('button', { style: s.btn, disabled: running, onClick: runOnce }, '回话一轮'),
              h('span', { style: { opacity: 0.6, fontSize: 12 } }, '推荐会按额度自动私聊分享')
            ),
            showPlan
              ? h('div', { style: { marginTop: 8, padding: '8px 10px', borderRadius: 8, fontSize: 12, border: '1px solid var(--dsh-border, rgba(128,128,128,.35))' } },
                h('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10 } },
                  h('span', null, '自动计划'),
                  h('button', {
                    style: { ...s.btn, ...(quota && !quota.paused ? { background: 'var(--dsh-accent, #3b82f6)', borderColor: 'transparent', color: '#fff' } : {}) },
                    disabled: busy === 'plan',
                    onClick: () => savePlan({ enabled: !(quota && !quota.paused) }),
                  }, quota && !quota.paused ? '已开启' : '已暂停')
                ),
                h('div', { style: { marginTop: 6 } }, '每天几点跑（逗号分隔）'),
                h('input', {
                  value: planTimes, onChange: (e) => setPlanTimes(e.target.value), placeholder: '09:00, 20:00',
                  style: { width: '100%', marginTop: 3, padding: '4px 8px', borderRadius: 8, fontSize: 12, border: '1px solid var(--dsh-border, rgba(128,128,128,.35))', background: 'transparent', color: 'inherit' },
                }),
                h('div', { style: { marginTop: 6, display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' } },
                  h('span', null, '每日上限'),
                  h('input', {
                    type: 'number', value: planPerDay, min: 1, max: 50,
                    onChange: (e) => setPlanPerDay(Number(e.target.value) || 20),
                    style: { width: 64, padding: '3px 8px', borderRadius: 8, fontSize: 12, border: '1px solid var(--dsh-border, rgba(128,128,128,.35))', background: 'transparent', color: 'inherit' },
                  }),
                  h('span', null, '条/天'),
                  h('span', { style: { marginLeft: 8 } }, '每次跑'),
                  h('input', {
                    type: 'number', value: planPerRun, min: 1, max: 10,
                    onChange: (e) => setPlanPerRun(Number(e.target.value) || 3),
                    style: { width: 56, padding: '3px 8px', borderRadius: 8, fontSize: 12, border: '1px solid var(--dsh-border, rgba(128,128,128,.35))', background: 'transparent', color: 'inherit' },
                  }),
                  h('span', null, '条'),
                  h('div', { style: { flex: 1 } }),
                  h('button', {
                    style: s.primary, disabled: busy === 'plan',
                    onClick: () => savePlan({ times: planTimes.split(/[,，\s]+/).map((x) => x.trim()).filter(Boolean), perDay: planPerDay, perRun: planPerRun }),
                  }, '保存计划')
                )
              )
              : null,
            lastRun
              ? h('div', { style: { marginTop: 6, fontSize: 12, opacity: 0.8 } },
                (lastRun.ok ? '✓ ' : '✗ ') + lastRun.at + ' · 用时 ' + Math.round(lastRun.ms / 1000) + ' 秒'
                + (lastRun.detail ? ' · ' + String(lastRun.detail).slice(0, 80) : ''))
              : null
          )
        })(),
        clean
          ? h('div', { style: { marginTop: 8, padding: '8px 10px', borderRadius: 8, fontSize: 12, lineHeight: 1.8, border: '1px solid var(--dsh-border, rgba(128,128,128,.35))' } },
            h('div', { style: { fontWeight: 600, marginBottom: 2 } }, '清理明细'),
            h('div', null, '截图：删除 ' + clean.shots.removed + ' 张，释放 ' + fmtBytes(clean.shots.freedBytes)),
            h('div', null, '日志：' + (clean.logs && clean.logs.length ? clean.logs.map((l) => l.file).join('、') : '没有超过 5MB 的日志')),
            h('div', null, '登录 Cookie：删除 ' + clean.cookies.removed + ' 份，保留 ' + clean.cookies.kept + ' 份'),
            h('div', null, '临时目录：删除 ' + clean.chromeDirs.removed + ' 个'),
            h('div', { style: { fontWeight: 600, marginTop: 2 } }, '共释放 ' + fmtBytes(clean.totalFreedBytes) + '，用时 ' + clean.durationMs + ' ms')
          )
          : null,
        diag
          ? h('div', { style: { marginTop: 8, padding: '8px 10px', borderRadius: 8, fontSize: 12, lineHeight: 1.8, border: '1px solid var(--dsh-border, rgba(128,128,128,.35))' } },
            h('div', { style: { fontWeight: 600, marginBottom: 2 } }, '诊断结果'),
            (diag.checks || []).map((c) => h('div', { key: c.name },
              h('span', { style: { color: c.ok ? '#16a34a' : '#dc2626' } }, c.ok ? '✓ ' : '✗ '),
              c.name + '：' + c.detail
            )),
            h('div', { style: { marginTop: 6, opacity: 0.8 } }, '最近报错：' + ((diag.lastErrors && diag.lastErrors.length) ? '' : '没有')),
            (diag.lastErrors || []).slice(-5).map((line, i) => h('div', { key: 'e' + i, style: { opacity: 0.75, fontFamily: 'monospace', fontSize: 11, wordBreak: 'break-all' } }, line)),
            h('div', { style: { marginTop: 4, opacity: 0.5, fontSize: 11 } }, '日志：' + (diag.logFile || ''))
          )
          : null,
        h('div', { style: { ...srow2, borderTop: '1px solid rgba(128,128,128,.18)', marginTop: 6, paddingTop: 8 } },
          h('div', null,
            h('div', { style: { fontSize: 13 } }, '后台服务'),
            h('div', { style: { opacity: 0.6, fontSize: 12 } }, '卡住或改了配置时点一下；新增表情图不用重启')
          ),
          h('button', {
            style: s.btn, disabled: busy === 'restart',
            onClick: async () => {
              setBusy('restart')
              try { await post('/restart'); setMsg('正在重启，3~5 秒后回来') }
              catch (e) { setMsg('重启请求失败：' + String(e && e.message || e)) }
              finally { setBusy('') }
            },
          }, busy === 'restart' ? '重启中…' : '重启后台服务')
        ),
        msg ? h('div', { style: { opacity: 0.6, fontSize: 12, marginTop: 6 } }, msg) : null
      )
    }

    /* ---------- 设置：开关 ---------- */
    function SettingsPane() {
      const [st, setSt] = useState(null)
      const [busy, setBusy] = useState('')
      const [msg, setMsg] = useState('')
      const [sticker, setSticker] = useState(null)
      const [stickerDir, setStickerDir] = useState('')
      const [memeLib, setMemeLib] = useState(null)

      const load = useCallback(async () => {
        try { setSt(await call('/status')); setMsg('') }
        catch (e) { setMsg('读不到状态：' + String(e && e.message || e)) }
        try {
          const sk = await call('/stickers')
          setSticker(sk)
          setStickerDir((old) => old || (sk && sk.dir) || '')
        } catch { /* 忽略 */ }
        try { setMemeLib(await call('/memes')) } catch { /* 忽略 */ }
      }, [])
      useEffect(() => { load() }, [load])

      const put = useCallback(async (patch, tag) => {
        setBusy(tag)
        try { const r = await post('/settings', patch); setSt((old) => ({ ...(old || {}), ...r })); setMsg('已更新') }
        catch (e) { setMsg('失败：' + String(e && e.message || e)) }
        finally { setBusy('') }
      }, [])

      if (!st) return h('div', { style: { opacity: 0.6, fontSize: 12 } }, msg || '读取中…')

      return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 4 } },
        h('div', { style: { ...srow2, borderBottom: '1px solid rgba(128,128,128,.18)', paddingBottom: 6 } },
          h('div', { style: { fontWeight: 600, fontSize: 13 } }, '群聊聊天设置'),
          h('span', { style: { opacity: 0.6, fontSize: 12 } }, '改完立即生效')
        ),
        h(Toggle, { label: '群聊自动回', desc: '被 @ 或叫名字时回话', on: Boolean(st.watch), busy: busy === 'watch', onChange: (v) => put({ watch: v }, 'watch') }),
        h(Toggle, { label: '私信自动回', desc: '好友发来新消息自动回', on: Boolean(st.watchDm), busy: busy === 'watchDm', onChange: (v) => put({ watchDm: v }, 'watchDm') }),
        h(Toggle, { label: '主动开口', desc: '隔一阵自己找你说一句', on: Boolean(st.proactive), busy: busy === 'proactive', onChange: (v) => put({ proactive: v }, 'proactive') }),
        h(Toggle, { label: '视频分享（私聊）', desc: '允许把视频以卡片分享给好友', on: Boolean(st.shareEnabled), busy: busy === 'shareOn', onChange: (v) => put({ shareEnabled: v }, 'shareOn') }),
        h(Toggle, {
          label: '常驻浏览器（更快）', desc: '开：读消息 1~2 秒，但占一个无头 Chrome；关：每次现开约 10 秒',
          on: Boolean(st.keepBrowser), busy: busy === 'warm', onChange: (v) => put({ keepBrowser: v }, 'warm'),
        }),
        h('div', { style: { fontSize: 12, opacity: 0.55 } },
          '常驻浏览器：' + (st.warmRunning ? '运行中' : (st.keepBrowser ? '下次读取时启动' : '未启用'))),
        h('div', { style: srow2 },
          h('div', null,
            h('div', { style: { fontSize: 13 } }, '说话频率'),
            h('div', { style: { opacity: 0.6, fontSize: 12 } }, '空闲时多说、高峰时少说，而不是一刀切')
          ),
          h('select', {
            value: (st.valley && st.valley.mode) || 'adaptive',
            disabled: busy === 'valley',
            onChange: (e) => put({ valley: { ...(st.valley || {}), mode: e.target.value, onlyValley: e.target.value !== 'always' } }, 'valley'),
            style: { padding: '3px 8px', borderRadius: 8, fontSize: 12, border: '1px solid var(--dsh-border, rgba(128,128,128,.35))', background: 'var(--dsh-surface, #1b1b1f)', color: 'inherit' },
          }, [
            ['adaptive', '空闲多说，高峰少说（推荐）'],
            ['onlyIdle', '只在空闲时说话'],
            ['always', '不限制，一直说'],
          ].map(([v2, text]) => h('option', { key: v2, value: v2, style: { color: '#111', background: '#fff' } }, text)))
        ),
        (() => {
          const t = st.traffic
          if (!t) return null
          const label = t.phase === 'idle' ? '空闲（适合说话）' : '高峰（先不说话）'
          return h('div', { style: { fontSize: 12, padding: '2px 0' } },
            '当前时段：', h('span', { style: { color: t.phase === 'idle' ? '#16a34a' : '#dc2626', fontWeight: 600 } }, label),
            h('span', { style: { opacity: 0.6 } }, '（这一小时 ' + t.todayCount + ' 条' + (t.nextIdle ? '，下一空闲 ' + t.nextIdle : '') + '）')
          )
        })(),
        h('div', { style: { borderTop: '1px solid rgba(128,128,128,.18)', marginTop: 8, paddingTop: 8 } },
          h(Toggle, {
            label: '每天自动清理缓存',
            desc: '清理截图、超大日志、旧 Cookie、残留临时目录（当前：'
              + ((st.cleanup && st.cleanup.enabled !== false) ? '开' : '关')
              + '，' + String((st.cleanup && st.cleanup.hour) ?? 4).padStart(2, '0') + ':00）',
            on: Boolean(st.cleanup && st.cleanup.enabled !== false),
            busy: busy === 'cleanSwitch',
            onChange: (v) => put({ cleanup: { enabled: v, hour: (st.cleanup && st.cleanup.hour) ?? 4 } }, 'cleanSwitch'),
          }),
          h('div', { style: srow2 },
            h('div', { style: { fontSize: 13 } }, '清理时间'),
            h('div', { style: { display: 'flex', gap: 8, alignItems: 'center' } },
              h('select', {
                value: String((st.cleanup && st.cleanup.hour) ?? 4),
                disabled: busy === 'cleanHour',
                onChange: (e) => put({ cleanup: { enabled: (st.cleanup && st.cleanup.enabled) !== false, hour: Number(e.target.value) } }, 'cleanHour'),
                style: { padding: '3px 8px', borderRadius: 8, fontSize: 12, border: '1px solid var(--dsh-border, rgba(128,128,128,.35))', background: 'var(--dsh-surface, #1b1b1f)', color: 'inherit' },
              }, Array.from({ length: 24 }, (_, i) => h('option', { key: i, value: String(i), style: { color: '#111', background: '#fff' } }, String(i).padStart(2, '0') + ':00'))),
              h('button', {
                style: s.btn, disabled: busy === 'cleanNow',
                onClick: async () => {
                  setBusy('cleanNow')
                  try { const r = await post('/cleanup'); const rep = (r && r.report) || {}; setMsg('清理完成：截图 ' + (rep.shots && rep.shots.removed || 0) + ' · 日志 ' + (rep.logs && rep.logs.length || 0) + ' · Cookie ' + (rep.cookies && rep.cookies.removed || 0)) }
                  catch (e) { setMsg('清理失败：' + String(e && e.message || e)) }
                  finally { setBusy('') }
                },
              }, busy === 'cleanNow' ? '清理中…' : '立即清理')
            )
          )
        ),
        h('div', { style: { borderTop: '1px solid rgba(128,128,128,.18)', marginTop: 8, paddingTop: 8 } },
          h('div', { style: { fontSize: 13, marginBottom: 2 } }, '表情包文件夹'),
          (() => {
            const lib = memeLib
            if (!lib) return h('div', { style: { opacity: 0.6, fontSize: 12 } }, '读取中…')
            const tag = { qq: 'QQ 同步', 'dsh-meme': 'DSH 表情包', custom: '自定义', own: '自建' }
            return h('div', { style: { fontSize: 12, marginBottom: 6, lineHeight: 1.8 } },
              h('div', { style: { opacity: 0.75 } }, '共 ' + lib.total + ' 张，来源自动选'),
              (lib.sources || []).map((s2) => h('div', { key: s2.id + s2.dir, style: { opacity: s2 === lib.primary ? 1 : 0.65 } },
                (s2 === lib.primary ? '● ' : '○ ') + (tag[s2.id] || s2.label) + '：' + s2.count + ' 张'))
            )
          })(),
          (() => {
            const lib = memeLib
            if (!lib || !lib.sources) return null
            const opts = [['auto', '自动（有 QQ 用 QQ，其次 DSH，最后自建）']]
            for (const s2 of lib.sources) {
              const name = s2.id === 'qq' ? 'QQ 同步图库' : (s2.id === 'dsh-meme' ? 'DSH 表情包插件' : (s2.id === 'custom' ? '自定义目录' : '自建目录'))
              opts.push([s2.id, name + '（' + s2.count + ' 张）'])
            }
            return h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 } },
              h('span', { style: { fontSize: 13 } }, '用哪个库'),
              h('select', {
                value: lib.chosen || 'auto',
                disabled: busy === 'memeSource',
                onChange: async (e) => {
                  setBusy('memeSource')
                  try { await post('/stickers', { source: e.target.value }); setMemeLib(await call('/memes')); setMsg('表情库已切换') }
                  catch (err) { setMsg('切换失败：' + String(err && err.message || err)) }
                  finally { setBusy('') }
                },
                style: { flex: 1, padding: '3px 8px', borderRadius: 8, fontSize: 12, border: '1px solid var(--dsh-border, rgba(128,128,128,.35))', background: 'var(--dsh-surface, #1b1b1f)', color: 'inherit' },
              }, opts.map(([v2, text]) => h('option', { key: v2, value: v2, style: { color: '#111', background: '#fff' } }, text)))
            )
          })(),
          h('div', { style: s.row },
            h('input', {
              style: s.input, value: stickerDir, placeholder: '额外目录（可选）',
              onChange: (e) => setStickerDir(e.target.value),
            }),
            h('button', {
              style: s.primary, disabled: busy === 'stickerDir',
              onClick: async () => {
                setBusy('stickerDir')
                try { const r = await post('/stickers', { dir: stickerDir }); setSticker(r); setMsg('表情包目录已保存') }
                catch (e) { setMsg('保存失败：' + String(e && e.message || e)) }
                finally { setBusy('') }
              },
            }, busy === 'stickerDir' ? '保存中…' : '保存')
          )
        ),
        msg ? h('div', { style: { opacity: 0.6, fontSize: 12, marginTop: 4 } }, msg) : null
      )
    }

    /* ---------- 人设 / 记忆：两条通道 + 刷视频偏好 ---------- */
    const ID_MODES = [
      { id: 'qq', label: '连 QQ（自动同步）' },
      { id: 'local', label: '自己写' },
      { id: 'both', label: '两个都用' },
    ]

    function IdentityPane() {
      const [data, setData] = useState(null)
      const [persona, setPersona] = useState('')
      const [memory, setMemory] = useState('')
      const [busy, setBusy] = useState('')
      const [msg, setMsg] = useState('')
      const [vp, setVp] = useState({ keywords: '', channels: '', authors: '', avoid: '', perDay: 10 })

      const load = useCallback(async () => {
        try {
          const d = await call('/identity')
          setData(d)
          setPersona((d.local && d.local.persona) || '')
          setMemory((d.local && d.local.memory) || '')
          const v = d.videoPrefs || {}
          setVp({
            keywords: (v.keywords || []).join('\n'),
            channels: (v.channels || []).join('\n'),
            authors: (v.authors || []).join('\n'),
            avoid: (v.avoid || []).join('\n'),
            perDay: v.perDay || 10,
          })
          setMsg('')
        } catch (e) { setMsg('读不到：' + String(e && e.message || e)) }
      }, [])
      useEffect(() => { load() }, [load])

      const save = useCallback(async (patch, tag) => {
        setBusy(tag)
        try {
          const d = await post('/identity', patch)
          setData(d)
          setMsg('已保存')
        } catch (e) { setMsg('保存失败：' + String(e && e.message || e)) }
        finally { setBusy('') }
      }, [])

      if (!data) return h('div', { style: { opacity: 0.6, fontSize: 12 } }, msg || '读取中…')

      const mode = data.mode || 'qq'
      const qq = data.qq || {}
      const editable = mode !== 'qq'
      const ta = {
        minHeight: 96, padding: 8, borderRadius: 8, fontSize: 12, resize: 'vertical',
        border: '1px solid var(--dsh-border, rgba(128,128,128,.35))',
        background: 'transparent', color: 'inherit',
      }

      const field = (key, label, ph, minH) => h('div', { key, style: { display: 'flex', flexDirection: 'column', gap: 3 } },
        h('div', { style: { fontSize: 12, opacity: 0.75 } }, label),
        h('textarea', {
          value: vp[key], placeholder: ph,
          onChange: (e) => setVp({ ...vp, [key]: e.target.value }),
          style: { ...ta, minHeight: minH || 54 },
        })
      )

      return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 10 } },
        h('div', { style: srow2 },
          h('div', null,
            h('div', { style: { fontSize: 13, fontWeight: 600 } }, '人格 / 记忆从哪来'),
            h('div', { style: { opacity: 0.6, fontSize: 12 } }, '两条通道：连 QQ 就跟着 QQ 那份走；自己写就只用你写的')
          ),
          h('select', {
            value: mode,
            disabled: Boolean(busy),
            onChange: (e) => save({ mode: e.target.value }, 'mode'),
            style: {
              padding: '3px 8px', borderRadius: 8, fontSize: 12,
              border: '1px solid var(--dsh-border, rgba(128,128,128,.35))',
              background: 'var(--dsh-surface, #1b1b1f)', color: 'inherit',
            },
          }, ID_MODES.map((m) => h('option', {
            key: m.id, value: m.id, style: { color: '#111', background: '#fff' },
          }, m.label)))
        ),

        h('div', {
          style: {
            border: '1px solid var(--dsh-border, rgba(128,128,128,.25))',
            borderRadius: 10, padding: '8px 10px', opacity: mode === 'local' ? 0.45 : 1,
          },
        },
          h('div', { style: { fontSize: 13, marginBottom: 4 } }, 'QQ 通道（共享，只读）'),
          h('div', { style: { opacity: 0.65, fontSize: 12, lineHeight: 1.7 } },
            '人格底座：' + ((qq.soulCore && qq.soulCore.path) || '未找到') + '（' + ((qq.soulCore && qq.soulCore.chars) || 0) + ' 字）',
            h('br'),
            'QQ 角色卡：' + ((qq.qqRole && qq.qqRole.path) || '未找到') + '（' + ((qq.qqRole && qq.qqRole.chars) || 0) + ' 字）',
            h('br'),
            '共享记忆：' + ((qq.memory && qq.memory.dir) || '未找到') + '（MEMORY ' + ((qq.memory && qq.memory.memoryMd && qq.memory.memoryMd.chars) || 0) + ' 字 / USER ' + ((qq.memory && qq.memory.userMd && qq.memory.userMd.chars) || 0) + ' 字）',
            h('br'),
            '当前生效总长：' + (qq.personaChars || 0) + ' 字 · 记忆通道：' + mode
          ),
          qq.hint
            ? h('div', {
              style: {
                marginTop: 6, padding: '6px 8px', borderRadius: 8, fontSize: 12,
                border: '1px solid rgba(234,179,8,.45)', background: 'rgba(234,179,8,.10)',
              },
            }, '⚠ ' + qq.hint)
            : null
        ),

        h('div', { style: { borderTop: '1px solid rgba(128,128,128,.18)', paddingTop: 8, display: 'flex', flexDirection: 'column', gap: 6 } },
          h('div', { style: { fontSize: 13, fontWeight: 600 } }, '刷视频的偏好'),
          h('div', { style: { opacity: 0.6, fontSize: 12 } }, '一行一个。想看的加分（关键词 > 分类），屏蔽词直接压到底。'),
          field('keywords', '想看的（关键词）', '比如：我的世界'),
          field('channels', '分类', '比如：游戏'),
          field('authors', '指定作者', '比如：Sora'),
          field('avoid', '不想看的（屏蔽词）', '比如：带货'),
          h('div', { style: { display: 'flex', alignItems: 'center', gap: 8 } },
            h('span', { style: { fontSize: 12, opacity: 0.75 } }, '每天最多推荐'),
            h('input', {
              type: 'number', value: vp.perDay, min: 1, max: 50,
              onChange: (e) => setVp({ ...vp, perDay: Number(e.target.value) || 10 }),
              style: {
                width: 70, padding: '3px 8px', borderRadius: 8, fontSize: 12,
                border: '1px solid var(--dsh-border, rgba(128,128,128,.35))',
                background: 'transparent', color: 'inherit',
              },
            }),
            h('span', { style: { fontSize: 12, opacity: 0.6 } }, '条')
          )
        ),

        h('div', { style: { display: 'flex', flexDirection: 'column', gap: 6, opacity: editable ? 1 : 0.45 } },
          h('div', { style: { fontSize: 13 } }, '自己的人设（只喂给抖音这只）'),
          h('textarea', {
            value: persona, disabled: !editable,
            onChange: (e) => setPersona(e.target.value),
            placeholder: '比如：说话短一点，别端着；群里叫主人，私聊可以随便点……',
            style: { ...ta, minHeight: 120 },
          }),
          h('div', { style: { fontSize: 13 } }, '自己的记忆（额外的事实，会拼在共享记忆后面）'),
          h('textarea', {
            value: memory, disabled: !editable,
            onChange: (e) => setMemory(e.target.value),
            placeholder: '比如：主人喜欢被叫宝宝；群里不能叫宝宝……',
            style: { ...ta, minHeight: 100 },
          })
        ),

        h('div', { style: s.row },
          h('button', {
            style: s.primary, disabled: Boolean(busy),
            onClick: () => save({
              persona, memory,
              videoPrefs: {
                keywords: vp.keywords.split('\n').map((x) => x.trim()).filter(Boolean),
                channels: vp.channels.split('\n').map((x) => x.trim()).filter(Boolean),
                authors: vp.authors.split('\n').map((x) => x.trim()).filter(Boolean),
                avoid: vp.avoid.split('\n').map((x) => x.trim()).filter(Boolean),
                perDay: vp.perDay,
              },
            }, 'save'),
          }, busy === 'save' ? '保存中…' : '保存'),
          h('button', { style: s.btn, disabled: Boolean(busy), onClick: load }, '重新读取')
        ),
        msg ? h('div', { style: { opacity: 0.6, fontSize: 12 } }, msg) : null
      )
    }

    const MODULES = [
      { id: 'chat', label: '聊天' },
      { id: 'share', label: '分享' },
      { id: 'identity', label: '人设' },
      { id: 'settings', label: '设置' },
    ]

    // 侧边栏图标 ↔ 浮层：一个极简 store（宿主不会替我们跳转，就自己开）
    const viewers = new Set()
    let panelOpen = false
    const setPanelOpen = (v) => { panelOpen = v; viewers.forEach((fn) => fn(v)) }

    function Overlay() {
      const [open, setOpen] = useState(false)
      useEffect(() => {
        viewers.add(setOpen)
        return () => { viewers.delete(setOpen) }
      }, [])
      if (!open) return null
      return h('div', {
        style: {
          position: 'fixed', inset: 0, zIndex: 9000, display: 'flex',
          alignItems: 'center', justifyContent: 'center', background: 'rgba(0,0,0,.45)',
        },
        onClick: () => setPanelOpen(false),
      }, h('div', {
        onClick: (e) => e.stopPropagation(),
        style: {
          width: 'min(920px, 94vw)', height: 'min(760px, 90vh)', maxHeight: '92vh', overflowY: 'auto', WebkitOverflowScrolling: 'touch',
          borderRadius: 14, padding: 14,
          background: 'var(--dsh-surface, #16171b)',
          border: '1px solid var(--dsh-border, rgba(128,128,128,.3))',
          boxShadow: '0 20px 60px rgba(0,0,0,.45)',
        },
      },
        h('div', { style: { display: 'flex', justifyContent: 'flex-end', marginBottom: 6 } },
          h('button', {
            onClick: () => setPanelOpen(false),
            style: { cursor: 'pointer', background: 'transparent', color: 'inherit', border: 'none', fontSize: 16 },
          }, '✕')
        ),
        h(Panel)
      ))
    }

    function Panel() {
      const [mod, setMod] = useState('chat')
      const [status, setStatus] = useState(null)
      const [target, setTarget] = useState(null)   // { name, kind }
      const [err, setErr] = useState('')

      const loadStatus = useCallback(async () => {
        try { setStatus(await call('/status')); setErr('') }
        catch (e) { setErr('后台服务没起来：' + String(e && e.message || e)) }
      }, [])
      useEffect(() => { loadStatus() }, [loadStatus])

      const groups = ((status && status.groups) || []).map((g) => (typeof g === 'string' ? g : g && g.name)).filter(Boolean)
      const peers = (status && status.dmPeers) || []
      // 群 + 好友合成一个列表：先群后好友
      const items = [
        ...groups.map((n) => ({ name: n, kind: 'group' })),
        ...peers.map((n) => ({ name: n, kind: 'dm' })),
      ]

      useEffect(() => {
        if (!target && items.length) setTarget(items[0])
      }, [status])

      return h('div', { style: s.page },
        // 最前面的风险提示（不能省）
        h('div', {
          style: {
            padding: '8px 12px', borderRadius: 10, fontSize: 12, lineHeight: 1.7,
            // 用跟主题一致的颜色，不跳出来（醒目靠 ⚠ 和加粗，不靠红）
            border: '1px solid var(--dsh-border, rgba(128,128,128,.35))',
            background: 'var(--dsh-surface-2, rgba(128,128,128,.08))',
            color: 'inherit',
            opacity: 0.95,
          },
        },
          h('div', { style: { fontWeight: 600, marginBottom: 2 } }, '⚠ 风险提示'),
          h('div', null,
            '本插件通过非官方接口操作抖音，可能被平台判定为违规，',
            h('span', { style: { fontWeight: 600 } }, '导致账号被限流或封禁'),
            '。使用即表示你知悉并自行承担后果。'
          )
        ),
        h(StartPanel),
        h('div', { style: s.head },
          h('div', { style: { fontWeight: 600, fontSize: 14 } }, '抖音群聊聊天'),
          h('span', { style: status && status.ok ? s.online : s.offline }, status && status.ok ? '● 服务在线' : '● 服务离线'),
          (() => {
            const t = status && status.traffic
            if (!t) return null
            // 只分两种：不是空闲就算高峰（跟那个提示条一个口径）
            const text = t.phase === 'idle' ? '空闲' : '高峰'
            const color = t.phase === 'idle' ? '#16a34a' : '#dc2626'
            return h('span', { style: { fontSize: 12, opacity: 0.85 } },
              '当前 ',
              h('span', { style: { color, fontWeight: 600 } }, text),
              t.phase === 'idle'
                ? (t.nextPeak ? h('span', null, ' · 下一高峰 ', h('span', { style: { color: '#dc2626' } }, t.nextPeak)) : null)
                : (t.nextIdle ? h('span', null, ' · 下一空闲 ', h('span', { style: { color: '#16a34a' } }, t.nextIdle)) : null)
            )
          })(),
          h('div', { style: { flex: 1 } }),
          h('div', { style: s.tabs }, MODULES.map((m) => h('button', {
            key: m.id, style: s.tab(mod === m.id), onClick: () => setMod(m.id),
          }, m.label)))
        ),
        err ? h('div', { style: s.err }, err) : null,
        mod === 'identity'
          ? h(IdentityPane)
          : mod === 'settings'
            ? h(SettingsPane)
          : mod === 'share'
            ? h(SharePane)
            : h('div', { style: s.body },
              h('div', { style: { width: 180, minWidth: 140, overflow: 'auto', borderRight: '1px solid rgba(128,128,128,.2)', paddingRight: 8 } },
                h('div', { style: { ...s.muted, marginBottom: 6 } }, '会话（' + items.length + '）'),
                items.length
                  ? items.map((it) => h('div', {
                    key: it.kind + ':' + it.name,
                    onClick: () => setTarget(it),
                    style: {
                      display: 'flex', alignItems: 'center', gap: 6,
                      padding: '5px 8px', borderRadius: 8, cursor: 'pointer', fontSize: 13,
                      background: target && target.name === it.name && target.kind === it.kind ? 'rgba(59,130,246,.16)' : 'transparent',
                    },
                  },
                    h('span', { style: { ...s.muted, fontSize: 11 } }, it.kind === 'group' ? '群' : '私'),
                    h('span', { style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, it.name)
                  ))
                  : h('div', { style: s.muted }, '还没有配置')
              ),
              h(ChatPane, { target: target && target.name, kind: target && target.kind })
            )
      )
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        // 1) 插件详情页（如果你在插件列表里点开了 dsh-douyin-group-chat）
        ctx.slots.inject('plugins.bundle.config', () => ctx.slots.register({
          name: 'plugins.bundle.config',
          key: 'dsh-sidebar-entry',
        }, Panel))

        // 设置 → 群聊聊天（独立一页）
        ctx.slots.inject('settings.section', () => ctx.slots.register({
          name: 'settings.section',
          id: 'douyin-panel',
          order: 40,
          label: '群聊聊天',
        }, SettingsPane))

        // 2) 左侧菜单（跟「浏览器」「插件」并列的那一栏）
        ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
          name: 'sidebar.panellist',
          id: 'douyin-panel',
          order: 40,
          label: '抖音群聊聊天',
        }, function FishSidebarIcon() {
          // 自定义图标：把图片放到 ~/.dsh/fish/icon.png 就能换
          return h('button', {
            title: '抖音群聊聊天',
            onClick: () => setPanelOpen(!panelOpen),
            style: { padding: 0, border: 'none', background: 'transparent', cursor: 'pointer' },
          }, h('img', {
            src: 'http://127.0.0.1:3110/icon?v=1',
            alt: '抖音群聊聊天',
            style: { width: 22, height: 22, borderRadius: 6, objectFit: 'cover', display: 'block' },
            onError: (e) => { e.currentTarget.style.display = 'none' },
          }))
        }))

        // 点图标后显示的浮层（不依赖宿主跳转）
        ctx.slots.inject('shell.overlay', () => ctx.slots.register({
          name: 'shell.overlay',
          id: 'douyin-panel-overlay',
          order: 900,
        }, Overlay))

        // 侧边栏那条点开后渲染的主面板
        ctx.slots.inject('main', () => ctx.slots.register({
          name: 'main',
          key: 'douyin-panel',
        }, Panel))

      },
    }
  },
})
