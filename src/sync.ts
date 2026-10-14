// 跨窗口。Mini 小窗和分出去的窗口各是一个独立的渲染进程、各有一份插件实例,录音只在主窗口。
// 主窗口把「现在的样子」写进 localStorage,别的窗口靠 storage 事件照着显示;它们的操作写成一条命令发回主窗口。
// 别的窗口从不写库。快照里只有最近几句(小窗够用);要看全文的窗口在主窗口存盘以后自己从库里读。

import { apply, type Cmd } from './engine'
import type { Rec } from './model'
import { emit, OWNER, S, type Phase } from './state'
import { loadIndex, loadRec } from './store'

const SNAP = 'diting.live'
const CMD = 'diting.cmd'
const TAIL = 8
const NOTES = 200

interface Snap { phase: Phase; seconds: number; partial: string; error: string; progress: number; saved: number; summarizing: string; summaryError: string; retrying?: string; rec: Rec | null }

let last = ''

/** 主窗口:把现在的样子发出去(内容没变就不写)。 */
export function publish(): void {
  if (!OWNER) return
  const r = S.live
  const snap: Snap = {
    phase: S.phase, seconds: Math.floor(S.seconds), partial: S.partial, error: S.error, progress: Math.round(S.progress * 100) / 100, saved: S.saved, summarizing: S.summarizing, summaryError: S.summaryError, retrying: S.retrying,
    // 笔记整份带上(短、少,别的窗口以它为准);句子只带最近几句,全文让别的窗口自己从库里读。
    rec: r ? { ...r, segments: r.segments.slice(-TAIL), notes: r.notes.slice(-NOTES), chapters: [], summary: undefined } : null,
  }
  const text = JSON.stringify(snap)
  if (text === last) return
  last = text
  try { localStorage.setItem(SNAP, text) } catch { /* 存不上,别的窗口就看不到,不影响录音 */ }
}

/** 这个窗口从库里读到的、正在进行的那条的全文(只有在看它的时候才读)。 */
let full: Rec | null = null
let seenSaved = -1
/** 已经为「哪一条的哪一次存盘」读过全文。 */
let fullFor = ''

function take(text: string | null): void {
  let snap: Snap | null = null
  try { snap = text ? JSON.parse(text) : null } catch { /* 坏了当没有 */ }
  if (!snap) return
  const viewingLive = !!S.open && !!snap.rec && S.open.id === snap.rec.id
  S.phase = snap.phase; S.seconds = snap.seconds; S.partial = snap.partial; S.error = snap.error; S.progress = snap.progress; S.summarizing = snap.summarizing; S.summaryError = snap.summaryError; S.retrying = snap.retrying || ''
  if (snap.rec) {
    const tail = snap.rec.segments; const ids = new Set(tail.map((s) => s.id))
    const base = full && full.id === snap.rec.id ? full : null
    S.live = base ? { ...snap.rec, segments: [...base.segments.filter((s) => !ids.has(s.id)), ...tail].sort((a, b) => a.start - b.start), notes: snap.rec.notes } : snap.rec
    if (viewingLive) S.open = S.live
  } else S.live = null
  // 主窗口存了盘、或者这个窗口刚开始看正在进行的那条(暂停着的时候不会有新的存盘):去库里读全文。
  const key = viewingLive ? `${snap.rec!.id}:${snap.saved}` : ''
  if (snap.saved !== seenSaved || (key && key !== fullFor)) { seenSaved = snap.saved; if (key) fullFor = key; void reload(viewingLive ? snap.rec!.folder : '') }
  emit()
}

/** 这个窗口刚打开了正在进行的那条:照快照再对一遍(会顺带去读全文)。 */
export function refresh(): void { if (!OWNER) { try { take(localStorage.getItem(SNAP)) } catch { /* 读不到 */ } } }

async function reload(liveFolder: string): Promise<void> {
  await loadIndex().catch(() => undefined)
  // 读到全文以后要再照快照合一遍,不然这个窗口还停在只有最近几句的样子上。
  if (liveFolder) { full = await loadRec(liveFolder).catch(() => null); if (full) { refresh(); return } } else if (S.open && S.open !== S.live) {
    const again = await loadRec(S.open.folder).catch(() => null)
    if (again) S.open = again
  }
  emit()
}

export function act(cmd: Cmd): void {
  if (OWNER) { void apply(cmd).catch((e) => { S.error = e instanceof Error ? e.message : String(e); emit() }); return }
  // 带一个每次都不同的号:连着发两次同样的命令,第二次也要触发 storage 事件。
  try { localStorage.setItem(CMD, JSON.stringify({ n: `${Date.now()}.${Math.random()}`, cmd })) } catch { /* 发不出去 */ }
}

export function startSync(): () => void {
  const onStorage = (e: StorageEvent): void => {
    if (e.key === CMD && OWNER && e.newValue) { try { const m = JSON.parse(e.newValue); if (m?.cmd?.c) void apply(m.cmd as Cmd).catch(() => undefined) } catch { /* 不认识的丢掉 */ } }
    else if (e.key === SNAP && !OWNER) take(e.newValue)
    else if (e.key?.startsWith('plugin.diting.')) emit()
  }
  window.addEventListener('storage', onStorage)
  if (OWNER) publish(); else { try { take(localStorage.getItem(SNAP)) } catch { /* 读不到 */ } }
  return () => window.removeEventListener('storage', onStorage)
}
