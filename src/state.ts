// 这个窗口里的状态和偏好。主窗口里由录音引擎直接改;小窗 / 分出去的窗口里由 sync.ts 照着主窗口的快照改。
// 视图只读这里、只订阅这里,不关心自己在哪个窗口。

import { getLocale } from './i18n'
import type { IndexRow, Layout, Rec, SummaryStyle } from './model'

export type Phase = 'idle' | 'starting' | 'live' | 'paused' | 'stopping' | 'importing'

export const S = {
  phase: 'idle' as Phase,
  /** 正在进行的那一次(没有就是 null)。 */
  live: null as Rec | null,
  seconds: 0,
  /** 0..1,只有主窗口有(不跨窗口同步)。 */
  level: 0,
  /** 正在说、还没说完的那一句。 */
  partial: '',
  error: '',
  /** 导入文件的进度 0..1。 */
  progress: 0,
  index: [] as IndexRow[],
  /** 这个窗口正在看的记录(可能就是 live 那个对象)。 */
  open: null as Rec | null,
  /** 正在写纪要的记录 id。 */
  summarizing: '',
  summaryError: '',
  /** 主窗口每存一次盘加一;别的窗口看到变了就从库里重读。 */
  saved: 0,
  /** 有没有打开的笔记库(没有就什么都存不了)。 */
  vault: true,
  /** 上次没正常结束、被收尾的记录 id(看到一次就清)。 */
  healed: '',
}

/** 这个窗口是不是管录音的那个。Mini 和分出去的窗口各有一份插件实例,它们只照着主窗口显示、把操作发回去。 */
export const OWNER = (document.documentElement.dataset.window || 'main') === 'main'

const subs = new Set<() => void>()
export const on = (fn: () => void): (() => void) => { subs.add(fn); return () => { subs.delete(fn) } }
export function emit(): void { for (const fn of [...subs]) { try { fn() } catch (e) { console.error('[diting]', e) } } }

// 偏好:和宿主 registerSetting 同一个键名口径(plugin.<id>.<key>),所以别的窗口改了这边也读得到。
const PREF = 'plugin.diting.'
export interface Prefs { layout: Layout; display: 'stacked' | 'paired' | 'original'; target: string; keep: boolean; partial: 'auto' | 'on' | 'off'; autoSummary: boolean; style: SummaryStyle; terms: Record<string, string> }
const DEFAULTS = (): Prefs => ({ layout: 'transcript', display: 'stacked', target: getLocale(), keep: true, partial: 'auto', autoSummary: true, style: 'class', terms: {} })

export function prefs(): Prefs {
  const d = DEFAULTS(); const out = { ...d } as Record<string, unknown>
  for (const k of Object.keys(d)) {
    let raw: string | null = null
    try { raw = localStorage.getItem(PREF + k) } catch { /* 读不到就用默认 */ }
    if (raw == null) continue
    const def = (d as unknown as Record<string, unknown>)[k]
    if (typeof def === 'boolean') out[k] = raw === 'true'
    else if (typeof def === 'object') { try { const j = JSON.parse(raw); if (j && typeof j === 'object') out[k] = j } catch { /* 坏了用默认 */ } }
    else out[k] = raw
  }
  const p = out as unknown as Prefs
  if (!['transcript', 'notes', 'split'].includes(p.layout)) p.layout = d.layout
  if (!['stacked', 'paired', 'original'].includes(p.display)) p.display = d.display
  if (!['auto', 'on', 'off'].includes(p.partial)) p.partial = d.partial
  if (!['class', 'meeting', 'interview'].includes(p.style)) p.style = d.style
  return p
}

export function setPref<K extends keyof Prefs>(key: K, value: Prefs[K]): void {
  try { localStorage.setItem(PREF + key, typeof value === 'object' ? JSON.stringify(value) : String(value)) } catch { /* 存不上就只在这次生效不了,不拦操作 */ }
  emit()
}

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
