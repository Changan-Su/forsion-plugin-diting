// 界面:主页面(三种布局共用一套零件)、右栏的对话和章节、底部字幕、Mini 小窗、设置页。
// 视图只读 state.ts、只通过 act() 改东西,不关心自己在主窗口还是小窗。
// 用户的字、模型的字一律走 textContent / append(不拼 innerHTML);只有自己写死的图标走 html。

import { canAi } from './ai'
import { chooseTarget, closeConfiguration, mountModelControls, prepareDraft, recordingDraft, showGlossary } from './configuration'
import { canRetry, importFile } from './engine'
import { duration, getLocale, SPOKEN, t, TARGETS, targetLabel, type Key } from './i18n'
import { changes, clock, FILES, parseClock, type Layout, type Rec, type Segment, type SummaryStyle } from './model'
import { emit, on, OWNER, prefs, S, setPref, type Prefs } from './state'
import { loadRec, vaultReady, reconnectLegacy, root as folderRoot } from './store'
import { act, refresh } from './sync'

const AGENT = 'diting-companion'

const P = {
  mic: '<path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" x2="12" y1="19" y2="22"/>',
  pause: '<rect x="14" y="4" width="4" height="16" rx="1"/><rect x="6" y="4" width="4" height="16" rx="1"/>',
  stop: '<rect width="14" height="14" x="5" y="5" rx="2.5"/>',
  star: '<polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>',
  play: '<path d="M5 5a2 2 0 0 1 3.008-1.728l11.997 6.998a2 2 0 0 1 .003 3.458l-12 7A2 2 0 0 1 5 19z"/>',
  chat: '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>',
  more: '<circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/><circle cx="5" cy="12" r="1"/>',
  down: '<path d="M12 5v14"/><path d="m19 12-7 7-7-7"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
  x: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
  file: '<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/>',
  open: '<path d="M15 3h6v6"/><path d="M10 14 21 3"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>',
} as const

type Attrs = Record<string, string | number | boolean | null | undefined>
type Kid = Node | string | null | undefined | false
function h(tag: string, attrs?: Attrs | null, ...kids: Kid[]): HTMLElement {
  const el = document.createElement(tag)
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue
    if (k === 'html') el.innerHTML = String(v); else el.setAttribute(k, v === true ? '' : String(v))
  }
  for (const kid of kids) if (kid) el.append(kid)
  return el
}
const ic = (name: keyof typeof P): string => `<svg viewBox="0 0 24 24" aria-hidden="true">${P[name]}</svg>`
function btn(action: string, label: string, o: { icon?: keyof typeof P; cls?: string; text?: boolean; data?: Attrs; disabled?: boolean } = {}): HTMLElement {
  return h('button', { type: 'button', class: o.cls, 'data-act': action, title: o.text ? undefined : label, 'aria-label': label, disabled: o.disabled, ...o.data, html: o.icon ? ic(o.icon) : '' }, o.text ? label : null)
}
function select(action: string, options: Array<[string, string]>, value: string, cls = 'dt-sel'): HTMLSelectElement {
  const el = h('select', { class: cls, 'data-change': action }) as HTMLSelectElement
  for (const [v, label] of options) el.append(h('option', { value: v, selected: v === value }, label))
  el.value = value
  return el
}
const spokenOptions = (): Array<[string, string]> => SPOKEN.map((l): [string, string] => [l.id, t(l.key)])
const targetOptions = (): Array<[string, string]> => [['', t('targetOff')], ...TARGETS.map((l): [string, string] => [l.id, t(l.key)])]

// ── 这个窗口的界面状态(放在模块上:打开 / 关掉底部面板会把主区重挂一遍,放在视图里就丢了)────────────────
const V = { recoveryArm: '', tab: '', sel: 0, menu: false, playing: 0, scrollTo: 0, armDelete: false, dragging: false }

// 回放。声音只在用户自己点了播放以后才会出;测试里一律静音。
const A = { el: null as HTMLAudioElement | null, rec: '', url: '', time: 0, on: false, rate: 1, gen: 0 }

/** 也让还在路上的加载作废(换了记录、插件被停用以后才读完的声音不许再装上、更不许响)。 */
function unloadAudio(): void {
  A.gen++
  if (A.el) { A.el.pause(); A.el.removeAttribute('src'); A.el.load() }
  if (A.url) URL.revokeObjectURL(A.url)
  A.el = null; A.rec = ''; A.url = ''; A.time = 0; A.on = false; V.playing = 0
}

const once = (el: HTMLMediaElement, names: string[], ms: number): Promise<string> => new Promise((resolve) => {
  const done = (e: Event | string): void => { names.forEach((n) => el.removeEventListener(n, done)); clearTimeout(timer); resolve(typeof e === 'string' ? e : e.type) }
  const timer = setTimeout(() => done('timeout'), ms)
  names.forEach((n) => el.addEventListener(n, done))
})

async function loadAudio(rec: Rec): Promise<boolean> {
  if (A.rec === rec.id && A.el) return true
  if (!rec.audio || !ctx.app.readBytes) return false
  unloadAudio()
  const g = A.gen
  let url = ''; let el: HTMLAudioElement | null = null
  try {
    const bytes = await ctx.app.readBytes(`${rec.folder}/${rec.audio}`)
    if (!bytes || g !== A.gen) return false
    const ext = rec.audio.split('.').pop() || ''
    const type = ({ webm: 'audio/webm', m4a: 'audio/mp4', mp4: 'video/mp4', mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', mov: 'video/quicktime' } as Record<string, string>)[ext]
    url = URL.createObjectURL(new Blob([bytes as BlobPart], type ? { type } : undefined))
    el = new Audio()
    el.preload = 'auto'; el.muted = !!window.__DITING_TEST__; el.src = url
    if ((await once(el, ['loadedmetadata', 'error'], 8000)) !== 'loadedmetadata' || g !== A.gen) return false
    // 边录边写出来的 webm 头里没有时长,不先让它自己算一遍,拖进度会跳回开头。
    if (!Number.isFinite(el.duration)) { el.currentTime = 1e101; await once(el, ['durationchange'], 4000); el.currentTime = 0; await once(el, ['seeked'], 2000) }
    if (g !== A.gen) return false
    const ready = el
    ready.playbackRate = A.rate
    ready.ontimeupdate = () => {
      A.time = ready.currentTime
      const segs = S.open?.id === A.rec ? S.open.segments : []
      let cur = 0; for (const s of segs) { if (s.start <= A.time + 0.05) cur = s.id; else break }
      V.playing = cur
      emit()
    }
    ready.onplay = ready.onpause = ready.onended = () => { A.on = !ready.paused; emit() }
    A.el = ready; A.rec = rec.id; A.url = url
    url = ''; el = null
    return true
  } catch (e) {
    console.warn('[diting] audio', e)
    return false
  } finally {
    // 没装上的(读失败、中途作废)当场收掉。
    if (el) { el.removeAttribute('src'); el.load() }
    if (url) URL.revokeObjectURL(url)
  }
}

async function seek(rec: Rec, sec: number, play: boolean): Promise<void> {
  if (rec.id === S.live?.id || !(await loadAudio(rec)) || !A.el || A.rec !== rec.id) return
  A.el.currentTime = Math.max(0, sec); A.time = A.el.currentTime
  if (play) await A.el.play().catch(() => undefined)
  emit()
}

export const playerState = (): Record<string, unknown> => ({ rec: A.rec, time: A.el?.currentTime ?? 0, on: A.on, muted: A.el?.muted ?? null, duration: A.el?.duration ?? null, rate: A.rate })

const isLive = (rec: Rec | null): boolean => !!rec && rec.id === S.live?.id
const canSeek = (rec: Rec): boolean => !isLive(rec) && !!rec.audio && !!ctx.app.readBytes

// ── 打开 / 新建 ────────────────────────────────────────────────────────────────────────────────────

const bottomOk = (): boolean => !!ctx.viewLocations?.includes('bottom')
export function syncCaptions(): void {
  if (!bottomOk()) return
  if (prefs().layout === 'notes' && S.open) ctx.openView('captions', { location: 'bottom' }); else ctx.closeView?.('captions')
}

export async function openRecord(id: string): Promise<void> {
  if (S.live?.id === id) { S.open = S.live; refresh() }
  else {
    const row = S.index.find((r) => r.id === id)
    const rec = row ? await loadRec(row.folder).catch(() => null) : null
    if (!rec) { ctx.notify?.(t('noRecord'), { level: 'warning' }); return }
    S.open = rec
  }
  if (S.healed === id) S.healed = ''
  if (A.rec !== id) unloadAudio()
  V.sel = 0; V.tab = ''; V.menu = false
  ctx.openView('session', { location: 'main' })
  syncCaptions()
  emit()
}

export function newRecord(): void {
  if (S.live) { S.open = S.live; ctx.notify?.(t('busy'), { level: 'info' }) } else { S.open = null; prepareDraft(); unloadAudio() }
  V.menu = false
  ctx.openView('session', { location: 'main' })
  emit()
}

let fileInput: HTMLInputElement | null = null
export function pickImport(): void {
  if (!OWNER) return
  if (S.phase !== 'idle') { ctx.notify?.(t('busy'), { level: 'warning' }); return }
  fileInput ??= (() => {
    const el = h('input', { type: 'file', accept: 'audio/*,video/*', hidden: true }) as HTMLInputElement
    el.addEventListener('change', () => { const f = el.files?.[0]; el.value = ''; if (f) { ctx.openView('session', { location: 'main' }); void importFile(f, recordingDraft) } })
    document.body.append(el)
    return el
  })()
  fileInput.click()
}
export const disposeUi = (): void => { closeConfiguration(); fileInput?.remove(); fileInput = null; unloadAudio(); chat?.handle.dispose(); chat = null }

// ── 零件:转写 ─────────────────────────────────────────────────────────────────────────────────────

interface Pane { el: HTMLElement; col: HTMLElement; update(rec: Rec): void }

function segEl(rec: Rec, s: Segment, o: { sel: boolean; seekable: boolean }): HTMLElement {
  const cls = ['dt-s', s.mark && 'mark', s.low && 'low', s.fail && 'fail', o.sel && 'sel', V.playing === s.id && 'playing'].filter(Boolean).join(' ')
  const node = h('div', { class: cls, 'data-act': 'sel', 'data-seg': s.id })
  node.append(o.seekable ? h('button', { type: 'button', class: 'ts', 'data-act': 'seek', 'data-t': s.start, title: t('playFrom') }, clock(s.start)) : h('span', { class: 'ts' }, clock(s.start)))
  const orig = h('div', { class: 'o' })
  if (s.fail) { orig.append(t('asrFailed')); if (canRetry(rec, s.id)) orig.append(btn('retry', t('retry'), { cls: 'dt-link', text: true, data: { 'data-seg': s.id } })) }
  else if (s.raw) {
    // 被按上下文改过的词划一条细线,点开这一句能看到原来听成了什么。
    let at = 0
    for (const c of changes(s.raw, s.text)) {
      const i = c.to ? s.text.indexOf(c.to, at) : -1
      if (i < 0) continue
      orig.append(s.text.slice(at, i), h('span', { class: 'dt-fix' }, c.to)); at = i + c.to.length
    }
    orig.append(s.text.slice(at))
  } else orig.append(s.text)
  if (s.low) orig.append(h('span', { class: 'dt-tag', title: t('lowHint') }, t('low')))
  node.append(orig)
  if (rec.target && !s.fail) {
    const tr = h('div', { class: 't' })
    if (s.trState === 'done' && s.tr) tr.textContent = s.tr
    else if (s.trState === 'wait') tr.append(h('span', { class: 'dt-wait' }, t('translating')))
    else if (s.trState === 'fail') { if (s.tr) tr.append(h('span', null, s.tr), h('br')); tr.append(h('span', { class: 'dt-wait' }, t('trFailed')), btn('retry', t('retry'), { cls: 'dt-link', text: true, data: { 'data-seg': s.id } })) }
    else if (s.trState !== 'skip') tr.textContent = t('noTranslation')
    node.append(tr)
  }
  const receipt = [s.asrModel && s.asrModel.id !== rec.asrModel ? s.asrModel.name : '', s.trModel && (s.trModel.id !== rec.translationModel || s.trTarget !== rec.target) ? `${s.trModel.name} · ${targetLabel(s.trTarget || rec.trLang || rec.target)}` : ''].filter(Boolean).join(' · ')
  if (receipt) node.append(h('div', { class: 'dt-model-receipt' }, receipt))
  if (o.sel) {
    const row = h('div', { class: 'dt-acts' })
    if (o.seekable) row.append(btn('seek', t('playFrom'), { icon: 'play', text: true, data: { 'data-t': s.start } }))
    if (!s.fail) row.append(btn('mark', s.mark ? t('unmark') : t('mark'), { icon: 'star', text: true, cls: s.mark ? 'on' : '', data: { 'data-seg': s.id } }))
    if (!s.fail && ctx.tangu?.mountChat) row.append(btn('quote', t('quoteAsk'), { icon: 'chat', text: true, data: { 'data-seg': s.id } }))
    if (s.raw) {
      const fixes = h('div', { class: 'dt-fixes' })
      const short = (x: string): boolean => x.split(/\s+/).length <= 4 && x.length <= 40
      for (const c of changes(s.raw, s.text).filter((x) => x.from && x.to).slice(0, 3)) {
        fixes.append(h('span', { class: 'dt-fixnote' }, t('fixed', c)))
        if (short(c.from) && short(c.to)) fixes.append(btn('term', t('addTerm'), { text: true, data: { 'data-from': c.from, 'data-to': c.to } }))
      }
      fixes.append(btn('revert', t('revert'), { text: true, data: { 'data-seg': s.id } }))
      row.append(fixes)
    }
    node.append(row)
  }
  return node
}

function transcriptPane(compact = false): Pane {
  const list = h('div', { class: 'dt-list' })
  const jump = btn('latest', t('latest'), { cls: 'dt-jump', icon: 'down', text: true }); jump.hidden = true
  const col = h('div', { class: 'dt-col' }, list)
  const el = h('div', { class: `dt-scroll${compact ? ' compact' : ''}` }, col, jump)
  const nodes = new Map<number, HTMLElement>(); const sigs = new Map<number, string>()
  const liveLine = h('div', { class: 'dt-s live' }); const empty = h('p', { class: 'dt-empty' })
  let follow = true
  el.addEventListener('scroll', () => { follow = el.scrollHeight - el.scrollTop - el.clientHeight < 80 })
  jump.addEventListener('click', (e) => { e.stopPropagation(); follow = true; el.scrollTop = el.scrollHeight })
  return {
    el, col,
    update(rec) {
      const live = isLive(rec); const seekable = canSeek(rec)
      const seen = new Set<number>(); let prev: Element | null = null
      for (const s of rec.segments) {
        seen.add(s.id)
        const sel = !compact && V.sel === s.id
        const sig = [s.text, s.tr, s.trState, s.mark, s.low, s.fail, s.raw, s.start, sel, V.playing === s.id, rec.target, seekable, getLocale(), s.fail && canRetry(rec, s.id), JSON.stringify(s.asrModel), JSON.stringify(s.trModel), s.trTarget, rec.asrModel, rec.translationModel].join('\u0001')
        let node = nodes.get(s.id)
        if (!node || sigs.get(s.id) !== sig) { const next = segEl(rec, s, { sel, seekable }); node?.replaceWith(next); node = next; nodes.set(s.id, node); sigs.set(s.id, sig) }
        if (node.parentElement !== list || node.previousElementSibling !== prev) list.insertBefore(node, prev ? prev.nextSibling : list.firstChild)
        prev = node
      }
      for (const [id, node] of nodes) if (!seen.has(id)) { node.remove(); nodes.delete(id); sigs.delete(id) }
      const busy = live && S.phase !== 'idle'
      if (busy && S.phase !== 'paused') {
        const line = S.phase === 'importing' ? `${t('importing')} ${Math.round(S.progress * 100)}%` : S.phase === 'stopping' ? t('finishing') : S.partial
        liveLine.replaceChildren(h('span', { class: 'ts' }, clock(S.seconds)), h('div', { class: 'o' }, line || t('listening'), line && S.phase === 'live' ? h('i', { class: 'dt-caret' }) : h('span', { class: 'dt-dots', html: '<i></i><i></i><i></i>' })))
        list.append(liveLine)
      } else liveLine.remove()
      if (!rec.segments.length && !busy) { empty.textContent = t('emptyTranscript'); list.append(empty) } else empty.remove()
      jump.hidden = follow || !live
      if (live && follow) el.scrollTop = el.scrollHeight
      const target = V.scrollTo ? nodes.get(V.scrollTo) : null
      if (target) { V.scrollTo = 0; follow = false; target.scrollIntoView({ block: 'center' }) }
    },
  }
}

// ── 零件:笔记 ─────────────────────────────────────────────────────────────────────────────────────

/** 打了一半还没回车的笔记:主区会被宿主重挂(开关底部面板时),放在视图里就没了。 */
const drafts = new Map<string, string>()

function notesPane(): Pane {
  const list = h('div', { class: 'dt-notes' })
  const input = h('input', { class: 'dt-note-in', type: 'text', placeholder: t('notePlaceholder'), 'aria-label': t('notePlaceholder') }) as HTMLInputElement
  const col = h('div', { class: 'dt-col' }, list, input, h('div', { class: 'dt-hint' }, t('noteHint')))
  const el = h('div', { class: 'dt-scroll' }, col)
  let rec: Rec | null = null; let sig = ''
  input.addEventListener('keydown', (e) => {
    // 输入法还在选字的那一下回车不算。
    if (e.key !== 'Enter' || e.isComposing || !input.value.trim() || !rec) return
    act({ c: 'note', rec: rec.id, text: input.value, t: isLive(rec) ? S.seconds : A.rec === rec.id ? A.time : rec.duration })
    input.value = ''; drafts.delete(rec.id)
    requestAnimationFrame(() => { el.scrollTop = el.scrollHeight })
  })
  input.addEventListener('input', () => { if (rec) drafts.set(rec.id, input.value) })
  return {
    el, col,
    update(r) {
      if (rec?.id !== r.id) input.value = drafts.get(r.id) ?? ''
      rec = r
      const seekable = canSeek(r)
      const next = JSON.stringify(r.notes) + seekable + r.id
      if (next === sig) return
      sig = next
      list.replaceChildren(...(r.notes.length ? r.notes.map((n) => h('div', { class: 'dt-note' },
        seekable ? h('button', { type: 'button', class: 'dt-cite', 'data-act': 'seek', 'data-t': n.t }, clock(n.t)) : h('span', { class: 'dt-cite' }, clock(n.t)),
        h('span', { class: 'tx' }, n.text),
        btn('delNote', t('del'), { icon: 'x', cls: 'dt-x', data: { 'data-note': n.id } }))) : [h('p', { class: 'dt-empty' }, t('noNotes'))]))
    },
  }
}

// ── 零件:纪要 ─────────────────────────────────────────────────────────────────────────────────────

/** 纪要是插件自己按固定格式写的 Markdown(小标题、列表、待办、加粗、[mm:ss]),这里只认这几样。 */
function mdNodes(md: string, seekable: boolean): HTMLElement[] {
  const out: HTMLElement[] = []; let ul: HTMLElement | null = null
  const inline = (el: HTMLElement, text: string): void => {
    const re = /\*\*(.+?)\*\*|\[(\d{1,2}:\d{2}(?::\d{2})?)\]/g; let last = 0; let m: RegExpExecArray | null
    while ((m = re.exec(text))) {
      el.append(text.slice(last, m.index))
      if (m[1]) el.append(h('b', null, m[1]))
      else { const sec = parseClock(m[2]) ?? 0; el.append(seekable ? h('button', { type: 'button', class: 'dt-cite', 'data-act': 'seek', 'data-t': sec }, m[2]) : h('span', { class: 'dt-cite' }, m[2])) }
      last = re.lastIndex
    }
    el.append(text.slice(last))
  }
  for (const raw of md.split('\n')) {
    const l = raw.trim()
    if (!l) { ul = null; continue }
    if (l.startsWith('## ')) { ul = null; out.push(h('h2', null, l.slice(3))); continue }
    const todo = /^- \[[ x]\] (.*)$/.exec(l); const li = todo ? null : /^- (.*)$/.exec(l)
    if (todo || li) {
      if (!ul || ul.classList.contains('todo') !== !!todo) { ul = h('ul', { class: todo ? 'todo' : null }); out.push(ul) }
      const body = h('span'); inline(body, todo ? todo[1] : li![1])
      ul.append(h('li', null, todo ? h('i') : null, body))
      continue
    }
    ul = null
    const p = h('p'); inline(p, l); out.push(p)
  }
  return out
}

const STYLES: Array<[SummaryStyle, Key]> = [['class', 'styleClass'], ['meeting', 'styleMeeting'], ['interview', 'styleInterview']]

function summaryPane(): Pane {
  const body = h('div', { class: 'dt-md' }); const foot = h('div', { class: 'dt-gen' })
  const col = h('div', { class: 'dt-col' }, body, foot)
  const el = h('div', { class: 'dt-scroll' }, col)
  let sig = ''
  return {
    el, col,
    update(rec) {
      const live = isLive(rec); const busy = S.summarizing === rec.id; const has = rec.segments.some((s) => s.text)
      const next = [rec.id, rec.summary, busy, live, S.summaryError, getLocale(), prefs().style, rec.notes.length, has, canSeek(rec)].join('\u0001')
      if (next === sig) return
      sig = next
      if (rec.summary && !busy) body.replaceChildren(...mdNodes(rec.summary, canSeek(rec)))
      else body.replaceChildren(h('p', { class: 'dt-empty' }, busy ? t('writing') : live ? t('summaryLive') : !canAi() ? t('needAi') : has ? t('summaryEmpty') : t('emptyTranscript')))
      foot.replaceChildren()
      if (S.summaryError && !busy) foot.append(h('span', { class: 'dt-err' }, t('summaryFailed', { e: S.summaryError })))
      if (!live && !busy && has && canAi()) foot.append(select('style', STYLES.map(([id, key]): [string, string] => [id, t(key)]), prefs().style), btn('summarize', rec.summary ? t('rewrite') : t('writeSummary'), { text: true, cls: 'dt-btn' }))
      if (rec.summary && !busy) foot.append(h('span', null, rec.notes.length ? t('summaryFrom', { n: rec.notes.length }) : t('summaryFromNoNotes')))
    },
  }
}

// ── 主页面 ────────────────────────────────────────────────────────────────────────────────────────

type Tab = 'transcript' | 'notes' | 'summary' | 'split'
const TABS: Record<Layout, Tab[]> = { transcript: ['transcript', 'notes', 'summary'], notes: ['notes', 'transcript', 'summary'], split: ['split', 'summary'] }
const TAB_KEY: Record<Tab, Key> = { transcript: 'tabTranscript', notes: 'tabNotes', summary: 'tabSummary', split: 'tabSplit' }
/** 宿主看法胶囊窄时只留图标(宿主插件图标词表里的名字)。 */
const TAB_ICON: Record<Tab, string> = { transcript: 'audio-lines', notes: 'notebook-pen', summary: 'list-checks', split: 'layout' }

// 每次记录各记各的看到哪一格(视图模式标准:按「看的那个东西」记);新记录从第一格开始。
const TAB_MEMO = 'plugin.diting.tabs'
const TAB_MEMO_CAP = 200 // ponytail: 只留最近 200 次记录,超出按写入先后丢
function tabMemo(id: string): string {
  try { const v = JSON.parse(localStorage.getItem(TAB_MEMO) || '{}'); return typeof v?.[id] === 'string' ? v[id] : '' } catch { return '' }
}
function rememberTab(id: string, tab: string): void {
  try {
    const v = JSON.parse(localStorage.getItem(TAB_MEMO) || '{}') as Record<string, string>
    delete v[id]; v[id] = tab // 删了再放 = 排到最后
    for (const k of Object.keys(v).slice(0, -TAB_MEMO_CAP)) delete v[k]
    localStorage.setItem(TAB_MEMO, JSON.stringify(v))
  } catch { /* 存不上就只在这次生效 */ }
}
const LAYOUTS: Array<[Layout, Key, Key]> = [['transcript', 'layoutTranscript', 'layoutTranscriptHint'], ['notes', 'layoutNotes', 'layoutNotesHint'], ['split', 'layoutSplit', 'layoutSplitHint']]
const DISPLAYS: Array<[Prefs['display'], Key]> = [['stacked', 'stacked'], ['paired', 'paired'], ['original', 'originalOnly']]

function recoveryNotice():HTMLElement {
  const box=h('div',{class:'dt-recovery','data-recovery':true})
  if(S.storageError)box.append(h('p',{role:'alert'},S.storageError))
  for(const item of S.recovery){
    const notice=h('div',null,h('p',null,item.error || t('previousRecords',{folder:item.folder,count:item.count,current:folderRoot(),currentCount:S.index.length})))
    if(!item.error){
      if(V.recoveryArm===item.folder)notice.append(h('p',null,t('recoveryHint',{folder:item.folder})))
      const vault=S.recoveryVault,current=S.recoveryFolder
      const action=btn('recoverLegacy',t(V.recoveryArm===item.folder?'confirmRecovery':'reviewRecovery'),{text:true,cls:'dt-btn',disabled:!OWNER||S.phase!=='idle'})
      action.addEventListener('click',()=>{if(V.recoveryArm!==item.folder){V.recoveryArm=item.folder;emit();return}void reconnectLegacy(item.folder,vault,current).catch(e=>ctx.notify?.(String(e.message||e),{level:'error'}))})
      notice.append(action)
    }
    box.append(notice)
  }
  return box
}
function startForm(): HTMLElement {
  const p = recordingDraft
  const title = h('input', { class: 'dt-in', type: 'text', placeholder: t('titlePlaceholder'), value: recordingDraft.title, 'data-field': 'title', 'aria-label': t('fieldTitle') })
  const keep = h('input', { type: 'checkbox', class: 'dt-sw', 'data-change': 'keep', checked: p.keep, 'aria-label': t('fieldKeep') })
  return h('div', { class: 'dt-start' },
    h('h1', null, t('startTitle')), h('p', null, t('startHint')), h('div', { class: 'dt-model-controls' }),
    h('div', { class: 'dt-row' }, h('label', null, t('fieldTitle')), title),
    h('div', { class: 'dt-row' }, h('label', null, t('fieldSpoken')), select('prefSpoken', spokenOptions(), p.spoken)),
    h('div', { class: 'dt-row' }, h('label', null, t('fieldTarget')), select('prefTarget', targetOptions(), p.target)),
    h('div', { class: 'dt-row' }, h('label', null, t('fieldKeep')), keep),
    h('div', { class: 'dt-row note' }, t('keepHint')),
    btn('start', t('start'), { icon: 'mic', text: true, cls: 'dt-go' }),
    OWNER ? btn('import', t('importFile'), { icon: 'file', text: true, cls: 'dt-alt' }) : null,
    h('div', { class: 'dt-err', 'data-slot': 'error' }),
  )
}

// 悬浮条分两步:结构只在「换了一种状态」时重搭,时间、音量条、进度就地改。
// 每秒整个重搭的话,按钮会在按下和抬起之间被换掉,点击就丢了。
function dockKey(rec: Rec | null): string {
  if (rec && isLive(rec) && S.phase !== 'idle') return `L|${S.phase}|${getLocale()}`
  if (rec && canSeek(rec)) return `P|${rec.id}|${A.rec === rec.id && A.on}|${A.rate}|${rec.duration}|${getLocale()}`
  return ''
}

function dock(rec: Rec): HTMLElement {
  if (isLive(rec)) {
    const el = h('div', { class: `dt-dock ${S.phase}` })
    if (S.phase === 'importing') el.append(h('span', { class: 'tm' }), btn('stop', t('cancel'), { text: true, cls: 'end' }))
    else if (S.phase === 'stopping' || S.phase === 'starting') el.append(h('span', { class: 'tm' }))
    else {
      const paused = S.phase === 'paused'
      el.append(h('i', { class: 'dot' }), h('span', { class: 'tm' }), h('span', { class: 'dt-wave', html: '<i></i><i></i><i></i><i></i><i></i>' }), h('i', { class: 'sep' }),
        paused ? btn('resume', t('resume'), { icon: 'play', cls: 'ib' }) : btn('pause', t('pause'), { icon: 'pause', cls: 'ib' }),
        btn('markNow', t('mark'), { icon: 'star', cls: 'ib' }),
        btn('stop', t('stop'), { icon: 'stop', text: true, cls: 'end' }))
    }
    return el
  }
  const on = A.rec === rec.id && A.on
  return h('div', { class: 'dt-dock player' },
    btn('play', on ? t('pause') : t('play'), { icon: on ? 'pause' : 'play', cls: 'play' }),
    h('span', { class: 'tm' }),
    h('input', { type: 'range', class: 'dt-track', min: 0, max: Math.max(1, rec.duration), step: 1, value: 0, 'data-input': 'scrub', 'aria-label': t('play') }),
    btn('rate', `${A.rate}×`, { text: true, cls: 'spd' }))
}

const WAVE = [0.5, 0.8, 1, 0.7, 0.4]
function dockUpdate(el: HTMLElement, rec: Rec): void {
  const tm = el.querySelector<HTMLElement>('.tm')!
  let text: string
  if (isLive(rec)) {
    text = S.phase === 'importing' ? `${t('importing')} ${Math.round(S.progress * 100)}%` : S.phase === 'stopping' ? t('finishing') : S.phase === 'starting' ? '…' : `${S.phase === 'paused' ? `${t('paused')} ` : ''}${clock(S.seconds)}`
    el.querySelectorAll<HTMLElement>('.dt-wave i').forEach((bar, i) => { bar.style.height = `${Math.round(3 + (S.phase === 'live' ? S.level : 0) * 18 * WAVE[i])}px` })
  } else {
    const now = A.rec === rec.id ? A.time : 0
    text = `${clock(now)} / ${clock(rec.duration)}`
    const range = el.querySelector<HTMLInputElement>('.dt-track')
    if (range && !V.dragging) range.value = String(Math.round(now))
  }
  if (tm.textContent !== text) tm.textContent = text
}

function menu(rec: Rec): HTMLElement {
  const p = prefs()
  const item = (action: string, label: string, o: { on?: boolean; data?: Attrs; cls?: string } = {}): HTMLElement =>
    h('button', { type: 'button', class: `dt-mi ${o.cls || ''}`, role: 'menuitem', 'data-act': action, ...o.data }, h('span', { class: 'ck', html: o.on ? ic('check') : '' }), label)
  const el = h('div', { class: 'dt-menu', role: 'menu' },
    h('div', { class: 'dt-mh' }, t('layout')), ...LAYOUTS.map(([id, key]) => item('layout', t(key), { on: p.layout === id, data: { 'data-v': id } })),
    h('div', { class: 'dt-mh' }, t('display')), ...DISPLAYS.map(([id, key]) => item('display', t(key), { on: p.display === id, data: { 'data-v': id } })),
    h('div', { class: 'dt-msep' }))
  if (ctx.app.openNote) el.append(item('openMd', t('openTranscript'), { data: { 'data-f': FILES.transcript } }))
  if (ctx.app.reveal) el.append(item('reveal', t('reveal')))
  if (!isLive(rec) && ctx.app.trash) el.append(item('delete', V.armDelete ? t('deleteConfirm') : t('deleteRecord'), { cls: 'danger' }))
  return el
}

export function mountSession(el: HTMLElement): () => void {
  const root = h('div', { class: 'dt' }); el.append(root)
  // 新宿主(2026-10-19+):转写 / 笔记 / 纪要交给宿主画在视图头行最左(⌥⌘V、命令面板、窄宽、手机顶栏都归宿主),
  // 目标语言和「…」挪进同一行右边;老宿主照旧画自己那排标签。
  let modes: ViewModesHandle | null = null; let stopActions: (() => void) | null = null
  const dropModes = (): void => { stopActions?.(); stopActions = null; modes?.dispose(); modes = null; delete root.dataset.hosthead }
  let key = ''; let panes: Pane[] = []
  let bar: HTMLElement; let body: HTMLElement; let head: HTMLElement | null = null; let banner: HTMLElement
  let modelCleanup: (() => void) | null = null
  let dockSig = ''; let dockEl: HTMLElement | null = null; let menuEl: HTMLElement | null = null; let menuSig = ''

  const draw = (): void => {
    if (!S.open && S.live) S.open = S.live
    const rec = S.open; const p = prefs()
    const tabs = TABS[p.layout]
    const want = V.tab || (rec ? tabMemo(rec.id) : '')
    const tab = (tabs.includes(want as Tab) ? want : tabs[0]) as Tab
    root.dataset.layout = p.layout; root.dataset.display = rec?.target ? p.display : 'original'
    const next = [S.vault, rec?.id ?? '', p.layout, tab, getLocale(),S.index.length,JSON.stringify(S.recovery),S.storageError,V.recoveryArm].join('|')
    if (next !== key) {
      modelCleanup?.(); modelCleanup = null
      key = next; panes = []; head = null; dockSig = ''; dockEl = null; menuEl = null; menuSig = ''
      bar = h('div', { class: 'dt-bar' }); banner = h('div', { class: 'dt-banner', hidden: true }); body = h('div', { class: 'dt-main' })
      root.replaceChildren(bar, banner, body)
      if (!S.vault || !rec) dropModes()
      if (!S.vault) body.append(h('p', { class: 'dt-empty big' }, t('noVault')))
      else if (!rec) body.append(h('div', { class: 'dt-scroll' },recoveryNotice(),startForm()))
      else {
        const tools = [...(canAi() ? [select('target', targetOptions(), rec.target, 'dt-sel pill')] : []), btn('menu', t('more'), { icon: 'more', cls: 'dt-ibtn' })]
        const setViewModes = ctx.ui?.setViewModes
        if (setViewModes) {
          const spec = {
            modes: tabs.map((id) => ({ id, label: t(TAB_KEY[id]), icon: TAB_ICON[id] })),
            value: tab,
            onChange: (id: string) => { V.tab = id; V.sel = 0; if (S.open) rememberTab(S.open.id, id); emit() },
          }
          if (modes) modes.update(spec)
          else { modes = setViewModes(el, spec); modes.actions.classList.add('dt', 'dt-hosttools'); stopActions = wire(modes.actions) }
          modes.actions.replaceChildren(...tools)
          root.dataset.hosthead = ''
        } else {
          bar.append(h('div', { class: 'dt-tabs', role: 'tablist' }, ...tabs.map((id) => h('button', { type: 'button', role: 'tab', class: id === tab ? 'on' : null, 'aria-selected': id === tab, 'data-act': 'tab', 'data-v': id }, t(TAB_KEY[id])))),
            h('span', { class: 'dt-sp' }), ...tools)
        }
        head = h('div', { class: 'dt-head' },
          h('h1', { class: 'dt-h1', contenteditable: 'plaintext-only', spellcheck: 'false', 'data-field': 'recTitle' }, rec.title),
          h('div', { class: 'dt-meta' }), h('div', { class: 'dt-model-controls' }))
        if (tab === 'split') {
          const a = transcriptPane(); const b = notesPane(); panes = [a, b]
          body.append(h('div', { class: 'dt-chead' }, head), h('div', { class: 'dt-two' }, a.el, b.el))
        } else {
          const pane = tab === 'transcript' ? transcriptPane() : tab === 'notes' ? notesPane() : summaryPane()
          panes = [pane]; pane.col.prepend(head); body.append(pane.el)
        }
      }
    }
    const modelHost = root.querySelector<HTMLElement>('.dt-model-controls')
    if (modelHost && !modelCleanup) modelCleanup = mountModelControls(modelHost, rec)
    // 提示条:出错、上次没正常结束
    const note = S.error || (rec && S.healed === rec.id ? t('interrupted') : '') || (!rec ? '' : !canAi() && rec.target ? t('needAi') : '')
    const slot = root.querySelector<HTMLElement>('[data-slot="error"]')
    if (slot) { slot.textContent = S.error; banner.hidden = true } else { banner.hidden = !note; banner.textContent = note }
    const go = root.querySelector<HTMLButtonElement>('.dt-go'); if (go) go.disabled = S.phase !== 'idle'
    if (!rec || !S.vault) return

    if (head) {
      const h1 = head.firstElementChild as HTMLElement
      if (document.activeElement !== h1 && h1.textContent !== rec.title) h1.textContent = rec.title
      const live = isLive(rec); const when = new Date(rec.createdAt)
      const meta: HTMLElement[] = [h('span', null, when.toLocaleString(getLocale() === 'zh' ? 'zh-CN' : 'en-GB', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }))]
      if (live && S.phase !== 'idle') meta.push(h('span', { class: S.phase === 'paused' ? '' : 'rec' }, h('i'), S.phase === 'paused' ? t('paused') : S.phase === 'importing' ? t('importing') : t('recording')))
      else meta.push(h('span', null, duration(rec.duration)))
      meta.push(h('span', null, rec.source === 'file' ? t('sourceFile') : t('srcMic')))
      if (rec.audio) meta.push(h('span', null, t('savedAudio')))
      const failures = rec.segments.filter(s => s.trState === 'fail' || (s.fail && canRetry(rec, s.id))).length
      if (failures) meta.push(h('span', { class: 'dt-retry-row' }, t('failedCount', { n: failures }), btn('retryAll', S.retrying === rec.id ? t('retrying') : t('retryAll'), { text: true, cls: 'dt-link', disabled: !!S.retrying })))
      const sig = meta.map((m) => m.textContent).join('|') + (live ? S.phase : '')
      const box = head.querySelector<HTMLElement>('.dt-meta')!
      if (box.dataset.sig !== sig) { box.dataset.sig = sig; box.replaceChildren(...meta) }
    }
    for (const pane of panes) pane.update(rec)
    const pick = (modes?.actions ?? bar).querySelector<HTMLSelectElement>('select')
    if (pick && document.activeElement !== pick && pick.value !== rec.target) pick.value = rec.target

    const dsig = dockKey(rec)
    if (dsig !== dockSig) { dockSig = dsig; dockEl?.remove(); dockEl = dsig ? dock(rec) : null; if (dockEl) root.append(dockEl) }
    if (dockEl) dockUpdate(dockEl, rec)
    const msig = V.menu ? [p.layout, p.display, V.armDelete, getLocale(), rec.id].join('|') : ''
    if (msig !== menuSig) { menuSig = msig; menuEl?.remove(); menuEl = V.menu ? menu(rec) : null; if (menuEl) root.append(menuEl) }
  }

  let raf = 0
  const off = on(() => { if (!raf) raf = requestAnimationFrame(() => { raf = 0; draw() }) })
  const stopUi = wire(root)
  void vaultReady().then((ok) => { if (S.vault !== ok) { S.vault = ok; emit() } })
  draw()
  return () => { off(); stopUi(); modelCleanup?.(); dropModes(); cancelAnimationFrame(raf); root.remove() }
}

// ── 点击和输入(主页面、底部字幕、章节共用)────────────────────────────────────────────────────────────


function wire(root: HTMLElement): () => void {
  const click = (e: MouseEvent): void => {
    const hit = (e.target as HTMLElement).closest<HTMLElement>('[data-act]')
    if (V.menu && !(e.target as HTMLElement).closest('.dt-menu, [data-act="menu"]')) { V.menu = false; V.armDelete = false; emit() }
    if (!hit || !root.contains(hit)) return
    const d = hit.dataset; const rec = S.open; const segId = Number(d.seg)
    const seg = rec?.segments.find((s) => s.id === segId)
    switch (d.act) {
      case 'tab': V.tab = d.v || ''; V.sel = 0; if (rec && V.tab) rememberTab(rec.id, V.tab); break
      case 'sel': if (!String(window.getSelection() || '') && !hit.closest('.compact')) V.sel = V.sel === segId ? 0 : segId; break
      case 'seek': if (rec) void seek(rec, Number(d.t) || 0, true); return
      case 'play': if (rec) { if (A.rec === rec.id && A.el && A.on) A.el.pause(); else void seek(rec, A.rec === rec.id ? A.time : 0, true) } return
      case 'rate': A.rate = A.rate >= 2 ? 1 : A.rate >= 1.5 ? 2 : A.rate + 0.25; if (A.el) A.el.playbackRate = A.rate; break
      case 'mark': if (rec) act({ c: 'mark', rec: rec.id, seg: segId }); return
      case 'markNow': act({ c: 'mark' }); return
      case 'quote': if (rec && seg) engage(rec, { quote: `[${clock(seg.start)}] ${seg.text}` }); return
      case 'revert': if (rec) act({ c: 'revert', rec: rec.id, seg: segId }); return
      case 'term': act({ c: 'term', from: d.from || '', to: d.to || '' }); ctx.notify?.(t('termAdded'), { level: 'success' }); return
      case 'retryAll': if (rec) act({ c: 'retryAll', rec: rec.id }); return
      case 'glossary': showGlossary(root); return
      case 'retry': if (rec) act({ c: 'retry', rec: rec.id, seg: segId }); return
      case 'delNote': if (rec) act({ c: 'delNote', rec: rec.id, note: Number(d.note) }); return
      case 'pause': act({ c: 'pause' }); return
      case 'resume': act({ c: 'resume' }); return
      case 'stop': act({ c: 'stop' }); return
      case 'summarize': if (rec) act({ c: 'summarize', rec: rec.id, style: prefs().style }); return
      case 'start': {
        const p = recordingDraft
        act({ c: 'start', title: root.querySelector<HTMLInputElement>('[data-field="title"]')?.value || '', target: p.target, spoken: p.spoken, keep: p.keep, asrModel: p.asrModel, translationModel: p.translationModel })
        return
      }
      case 'import': pickImport(); return
      // 快捷提问:只把话放进输入框,发不发由用户决定。
      case 'ask': if (rec) engage(rec, { ask: t(d.ask === 'askRecent' ? 'askRecentPrompt' : 'askSoFarPrompt') }); return
      case 'chatOpen': if (rec) engage(rec); return
      case 'menu': V.menu = !V.menu; V.armDelete = false; break
      // 主动换布局 = 落到新布局的第一格,并记给这次记录(不然按记录记住的那格会把「并排」拉回「纪要」)
      case 'layout': { const l = d.v as Layout; setPref('layout', l); V.tab = TABS[l]?.[0] ?? ''; if (rec && V.tab) rememberTab(rec.id, V.tab); V.menu = false; syncCaptions(); return }
      case 'display': setPref('display', d.v as Prefs['display']); V.menu = false; return
      case 'openMd': if (rec) ctx.app.openNote?.(`${rec.folder}/${d.f}`); V.menu = false; break
      case 'reveal': if (rec) ctx.app.reveal?.(`${rec.folder}/${FILES.transcript}`); V.menu = false; break
      case 'delete': if (!rec) return; if (!V.armDelete) { V.armDelete = true; break } V.menu = false; V.armDelete = false; act({ c: 'delete', rec: rec.id }); ctx.notify?.(t('deleted'), { level: 'info' }); return
      case 'goto': { const s = rec?.segments.find((x) => x.start >= Number(d.t) - 0.05) || rec?.segments[rec.segments.length - 1]; if (s) { V.sel = s.id; V.scrollTo = s.id; V.tab = prefs().layout === 'split' ? 'split' : 'transcript' } break }
      default: return
    }
    emit()
  }
  const change = (e: Event): void => {
    const el = e.target as HTMLInputElement | HTMLSelectElement
    const rec = S.open
    switch (el.dataset.change) {
      case 'target': if (rec) { const value = el.value; el.value = rec.target; chooseTarget(rec, value, root) } break
      case 'prefTarget': recordingDraft.target = el.value; break
      case 'prefSpoken': recordingDraft.spoken = el.value; break
      case 'keep': recordingDraft.keep = (el as HTMLInputElement).checked; break
      case 'style': setPref('style', el.value as SummaryStyle); break
      default:
    }
  }
  const input = (e: Event): void => {
    const el = e.target as HTMLInputElement
    if (el.dataset.field === 'title') recordingDraft.title = el.value
    if (el.dataset.input === 'scrub' && S.open) void seek(S.open, Number(el.value), false)
  }
  const down = (e: Event): void => { if ((e.target as HTMLElement).dataset?.input === 'scrub') V.dragging = true }
  const up = (): void => { if (V.dragging) { V.dragging = false; emit() } }
  const keydown = (e: KeyboardEvent): void => {
    const el = e.target as HTMLElement
    if (e.key === 'Escape' && V.menu) { V.menu = false; emit() }
    if (el.dataset?.field === 'recTitle' && e.key === 'Enter') { e.preventDefault(); el.blur() }
    if (el.dataset?.field === 'title' && e.key === 'Enter' && !e.isComposing) root.querySelector<HTMLElement>('.dt-go')?.click()
  }
  const blur = (e: FocusEvent): void => {
    const el = e.target as HTMLElement; const rec = S.open
    if (el.dataset?.field !== 'recTitle' || !rec) return
    const title = (el.textContent || '').replace(/\s+/g, ' ').trim()
    if (title && title !== rec.title) act({ c: 'rename', rec: rec.id, title }); else el.textContent = rec.title
  }
  root.addEventListener('click', click); root.addEventListener('change', change); root.addEventListener('input', input)
  root.addEventListener('pointerdown', down); window.addEventListener('pointerup', up)
  root.addEventListener('keydown', keydown); root.addEventListener('focusout', blur)
  return () => window.removeEventListener('pointerup', up)
}

/** 一个跟着状态重画的小视图:draw 自己判断要不要动 DOM。 */
function mountLive(el: HTMLElement, root: HTMLElement, draw: () => void, cleanup?: () => void): () => void {
  el.append(root)
  let raf = 0
  const off = on(() => { if (!raf) raf = requestAnimationFrame(() => { raf = 0; draw() }) })
  const stopUi = wire(root)
  draw()
  return () => { off(); stopUi(); cancelAnimationFrame(raf); cleanup?.(); root.remove() }
}

// ── 底部面板:字幕(「笔记为主」的布局里,转写在这里滚)──────────────────────────────────────────────────

export function mountCaptions(el: HTMLElement): () => void {
  const root = h('div', { class: 'dt dt-capview' })
  let id = ''; let pane: Pane | null = null
  return mountLive(el, root, () => {
    const rec = S.open || S.live
    root.dataset.display = rec?.target ? 'paired' : 'original'
    const next = `${rec?.id ?? ''}|${getLocale()}`
    if (next !== id) { id = next; pane = rec ? transcriptPane(true) : null; root.replaceChildren(pane ? pane.el : h('p', { class: 'dt-empty big' }, t('captionsIdle'))) }
    if (rec && pane) pane.update(rec)
  })
}

// ── 右栏:对话(宿主的原生对话,工作目录就是这次记录的文件夹)和章节 ───────────────────────────────────────

let chat: { handle: HostChatMount; rec: string } | null = null
let pendingQuote = ''
let pendingAsk = ''
/** 这次运行里用户点过提问的记录(存盘要等主窗口,先在本窗口记一下)。 */
const engaged = new Set<string>()

/** 宿主的原生对话一挂上就会建一条真的会话(主区的会话列表里也看得到)。所以等用户真的要问了才挂:
 *  没问过的记录只画一个像输入框的按钮和两条快捷提问。 */
function engage(rec: Rec, o: { quote?: string; ask?: string } = {}): void {
  if (o.quote) pendingQuote = o.quote
  if (o.ask) pendingAsk = o.ask
  if (chat && chat.rec === rec.id) { flushChat(); return }
  engaged.add(rec.id)
  if (!rec.chat) act({ c: 'chatOn', rec: rec.id })
  ctx.openView('chat', { location: 'right' })
  emit()
}
function flushChat(): void {
  if (!chat) return
  if (pendingQuote) { chat.handle.quote(pendingQuote); pendingQuote = '' }
  if (pendingAsk) { chat.handle.prefill(pendingAsk); pendingAsk = '' }
}

export function mountChatView(el: HTMLElement): () => void {
  const host = h('div', { class: 'dt-chat-host' }); const sugg = h('div', { class: 'dt-sugg' }); const empty = h('p', { class: 'dt-empty' })
  const opener = btn('chatOpen', t('askPlaceholder'), { text: true, cls: 'dt-ask' })
  const root = h('div', { class: 'dt-side dt-chat' }, empty, host, sugg, opener)
  let cur = '\u0000'
  return mountLive(el, root, () => {
    const rec = S.open
    const mount = ctx.tangu?.mountChat
    const on = !!rec && !!mount && (rec.chat === true || engaged.has(rec.id))
    const next = `${rec?.id ?? ''}|${on}|${getLocale()}`
    if (next === cur) return
    const same = !!chat && chat.rec === (rec?.id ?? '') && on
    cur = next
    sugg.replaceChildren(); opener.textContent = t('askPlaceholder')
    if (!mount || !rec) {
      chat?.handle.dispose(); chat = null
      empty.textContent = mount ? t('chatEmpty') : t('chatUnavailable'); empty.hidden = false; host.hidden = true; opener.hidden = true
      return
    }
    empty.hidden = true; host.hidden = !on; opener.hidden = on
    for (const k of ['askRecent', 'askSoFar'] as const) sugg.append(btn('ask', t(k), { text: true, data: { 'data-ask': k } }))
    if (same) return
    chat?.handle.dispose(); chat = null
    if (!on) return
    // 随包带的「谛听」Agent 知道去读这个文件夹里的转写;引擎还没把它装好时用默认的。
    const agent = ctx.tangu?.agents?.().some((a) => a.slug === AGENT) ? AGENT : undefined
    chat = { handle: mount(host, { agent, folder: rec.folder, title: rec.title }), rec: rec.id }
    flushChat()
  }, () => { chat?.handle.dispose(); chat = null })
}

export function mountChapters(el: HTMLElement): () => void {
  const root = h('div', { class: 'dt-side dt-ol' })
  let sig = '\u0000'
  return mountLive(el, root, () => {
    const rec = S.open
    const marks = rec ? rec.segments.filter((s) => s.mark) : []
    const next = JSON.stringify([rec?.id, rec?.chapters, marks.map((s) => [s.id, s.text]), getLocale()])
    if (next === sig) return
    sig = next
    root.replaceChildren()
    if (!rec || (!rec.chapters.length && !marks.length)) { root.append(h('p', { class: 'dt-empty' }, t('chaptersEmpty'))); return }
    const row = (sec: number, text: string): HTMLElement => h('button', { type: 'button', class: 'row', 'data-act': 'goto', 'data-t': sec }, h('time', null, clock(sec)), h('span', null, text))
    if (rec.chapters.length) root.append(h('div', { class: 'dt-side-h' }, t('chapters')), ...rec.chapters.map((c) => row(c.t, c.title)))
    if (marks.length) root.append(h('div', { class: 'dt-side-h' }, t('marks')), ...marks.map((s) => row(s.start, s.text)))
  })
}

// ── Mini 小窗 ─────────────────────────────────────────────────────────────────────────────────────

export function mountMini(el: HTMLElement, view?: HostViewContext): () => void {
  const root = h('div', { class: 'dt-mini' })
  const note = h('input', { class: 'dt-note-in', type: 'text', placeholder: t('miniNote'), 'aria-label': t('miniNote') }) as HTMLInputElement
  note.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' || e.isComposing || !note.value.trim() || !S.live) return
    act({ c: 'note', rec: S.live.id, text: note.value, t: S.seconds }); note.value = ''
  })
  const top = h('div', { class: 'hd' }); const lines = h('div', { class: 'lines' })
  root.append(top, lines, note)
  root.addEventListener('click', (e) => { if ((e.target as HTMLElement).closest('[data-act="back"]')) { if (view?.showInMainPanel) view.showInMainPanel(); else ctx.openView('session', { location: 'main' }) } })
  let headKey = '\u0000'; let sig = ''
  return mountLive(el, root, () => {
    const rec = S.live; const busy = !!rec && S.phase !== 'idle'; const paused = S.phase === 'paused'
    note.hidden = !busy || S.phase === 'importing' || S.phase === 'stopping'
    // 头部的按钮只在换状态时重搭(每秒重搭会吞掉点击),时间就地改。
    const hk = `${busy ? S.phase : 'idle'}|${getLocale()}`
    if (hk !== headKey) {
      headKey = hk
      if (!busy) top.replaceChildren(h('span', { class: 'st' }, t('miniIdle')), h('span', { class: 'dt-sp' }), btn('back', t('miniOpen'), { icon: 'open' }))
      else {
        top.replaceChildren(h('i', { class: `dot${paused ? ' off' : ''}` }), h('span', { class: 'tm' }), h('span', { class: 'st' }), h('span', { class: 'dt-sp' }))
        if (S.phase === 'live' || paused) top.append(paused ? btn('resume', t('resume'), { icon: 'play' }) : btn('pause', t('pause'), { icon: 'pause' }), btn('markNow', t('mark'), { icon: 'star' }), btn('stop', t('stop'), { icon: 'stop' }))
        top.append(btn('back', t('miniOpen'), { icon: 'open' }))
      }
      sig = ''
    }
    if (busy) {
      const tm = top.querySelector<HTMLElement>('.tm')!; const st = top.querySelector<HTMLElement>('.st')!
      const now = clock(S.seconds); if (tm.textContent !== now) tm.textContent = now
      const label = S.phase === 'importing' ? `${t('importing')} ${Math.round(S.progress * 100)}%` : S.phase === 'stopping' ? t('finishing') : paused ? t('paused') : t('recording')
      if (st.textContent !== label) st.textContent = label
    }
    const tail = rec ? rec.segments.filter((s) => s.text).slice(-3) : []
    const next = JSON.stringify([busy, S.partial, S.error, tail.map((s) => [s.id, s.text, s.tr, s.mark]), S.phase === 'idle', rec?.target])
    if (next === sig) return
    sig = next
    if (!busy) { lines.replaceChildren(h('p', { class: 'dt-err' }, S.error), btn('start', t('miniStart'), { icon: 'mic', text: true, cls: 'dt-go', disabled: S.phase !== 'idle' })); return }
    lines.replaceChildren(...tail.map((s, i) => h('div', { class: `ln${i < tail.length - 1 ? ' prev' : ''}${s.mark ? ' mark' : ''}` }, h('div', { class: 'o' }, s.text), rec?.target && s.tr ? h('div', { class: 't' }, s.tr) : null)))
    if (S.partial) lines.append(h('div', { class: 'ln live' }, h('div', { class: 'o' }, S.partial)))
    else if (!tail.length) lines.append(h('p', { class: 'dt-empty' }, S.error || t('noSpeechYet')))
    lines.scrollTop = lines.scrollHeight
  })
}

// ── 设置页 ────────────────────────────────────────────────────────────────────────────────────────

export function mountSettings(el: HTMLElement): () => void {
  const root = h('div', { class: 'dt-set' })
  let sig = ''
  const draw = (): void => {
    const p = prefs()
    const next = JSON.stringify(p) + getLocale()
    if (next === sig) return
    sig = next
    const row = (label: string, control: HTMLElement, hint?: string): HTMLElement => h('div', { class: 'dt-row' }, h('label', null, label, hint ? h('small', null, hint) : null), control)
    const sw = (key: 'keep' | 'autoSummary' | 'fix'): HTMLElement => h('input', { type: 'checkbox', class: 'dt-sw', 'data-pref': key, checked: p[key] })
    const sel = (key: 'target' | 'spoken' | 'partial' | 'style', options: Array<[string, string]>): HTMLElement => { const s = select('', options, String(p[key])); s.dataset.pref = key; return s }
    const terms = Object.entries(p.terms)
    root.replaceChildren(
      h('div', { class: 'dt-set-h' }, t('setLayout')),
      h('div', { class: 'dt-cards', role: 'radiogroup' }, ...LAYOUTS.map(([id, key, hint]) => h('button', { type: 'button', role: 'radio', 'aria-checked': p.layout === id, class: `dt-card${p.layout === id ? ' on' : ''}`, 'data-layout': id },
        h('span', { class: `pic ${id}`, html: '<i></i><i></i><i></i>' }), h('b', null, t(key)), h('small', null, t(hint))))),
      row(t('setSpoken'), sel('spoken', spokenOptions()), t('setSpokenHint')),
      row(t('setTarget'), sel('target', targetOptions()), ctx.tangu?.translate ? t('setTargetHint') : undefined),
      // 旧宿主没有专门的翻译口子,翻译时一直是顺带改的,没有可选的余地,这一行不出。
      ...(ctx.tangu?.translate ? [row(t('setFix'), sw('fix'), t('setFixHint'))] : []),
      row(t('setKeep'), sw('keep'), t('keepHint')),
      row(t('setPartial'), sel('partial', [['auto', t('partialAuto')], ['on', t('on')], ['off', t('off')]]), t('setPartialHint')),
      row(t('setAutoSummary'), sw('autoSummary'), t('setAutoSummaryHint')),
      row(t('setStyle'), sel('style', STYLES.map(([id, key]): [string, string] => [id, t(key)]))),
      h('div', { class: 'dt-set-h' }, t('setGlossary')), btn('glossary', t('glossaryAdd'), { text: true, cls: 'dt-btn' }), h('p', { class: 'dt-hint' }, t('setGlossaryHint')),
      terms.length ? h('div', { class: 'dt-terms' }, ...terms.map(([from, to]) => h('div', null, h('span', null, from), h('span', null, '→'), h('span', null, to), btn('', t('del'), { icon: 'x', cls: 'dt-x', data: { 'data-term': from } })))) : h('p', { class: 'dt-empty' }, t('glossaryEmpty')),
    )
  }
  root.addEventListener('click', (e) => {
    const card = (e.target as HTMLElement).closest<HTMLElement>('[data-layout]'); const term = (e.target as HTMLElement).closest<HTMLElement>('[data-term]')
    if (card) setPref('layout', card.dataset.layout as Layout)
    if (term) act({ c: 'termRemove', from: term.dataset.term || '' })
    if ((e.target as HTMLElement).closest('[data-act=glossary]')) showGlossary(root)
  })
  root.addEventListener('change', (e) => {
    const c = e.target as HTMLInputElement; const key = c.dataset.pref as keyof Prefs | undefined
    if (key) setPref(key, (c.type === 'checkbox' ? c.checked : c.value) as never)
  })
  el.append(root)
  const off = on(draw)
  draw()
  return () => { off(); root.remove() }
}
