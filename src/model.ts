// 数据模型和纯函数(不碰 ctx、不碰 DOM;check.mjs 直接测)。

export interface ModelReceipt { id: string; name: string; backend?: 'local' | 'cloud' }
export type ChangeScope = 'future' | 'failed' | 'all'
export interface Segment {
  asrModel?: ModelReceipt
  trModel?: ModelReceipt
  trTarget?: string
  id: number
  /** 从记录开始算的秒数。 */
  start: number
  end: number
  text: string
  /** 被按上下文改过时,留着识别出来的原样。 */
  raw?: string
  tr?: string
  /** wait = 等翻译;fail = 翻译没成;skip = 不用翻。没有这个字段 = 没开翻译。 */
  trState?: 'wait' | 'done' | 'fail' | 'skip'
  mark?: boolean
  /** 这句的音量比平时小很多(多半是离麦克风远的人),识别结果不太可信。 */
  low?: boolean
  /** 这一段没转写成(text 是空的)。 */
  fail?: boolean
}
export interface Note { id: number; t: number; text: string }
export interface Chapter { t: number; title: string }
export type Status = 'live' | 'paused' | 'done'
export interface Rec {
  v: 1
  id: string
  /** 库内相对路径。 */
  folder: string
  title: string
  createdAt: string
  duration: number
  status: Status
  source: 'mic' | 'file'
  /** 翻译成什么;'' = 不翻译。 */
  target: string
  /** 说的是什么语言(交给识别当提示);'' = 自动判断。 */
  spoken?: string
  asrModel?: string
  translationModel?: string
  /** 录音的文件名(在 folder 里);没留就没有。 */
  audio?: string
  segments: Segment[]
  notes: Note[]
  chapters: Chapter[]
  summary?: string
  summaryAt?: string
  summaryStyle?: SummaryStyle
  /** 已有的译文是哪种语言的(关掉翻译再开时用来判断要不要重译)。 */
  trLang?: string
  /** 用户对这次记录提过问(宿主那边已经有一条对话了)。没提过就不挂对话,免得每打开一条记录就多一条空会话。 */
  chat?: boolean
}
export interface IndexRow { id: string; folder: string; title: string; createdAt: string; duration: number; status: Status }
export type SummaryStyle = 'class' | 'meeting' | 'interview'
export type Layout = 'transcript' | 'notes' | 'split'

// 落盘的名字钉死(不跟界面语言走):同一个库里中英文界面读写的是同一批文件。
export const FILES = { record: '.record.json', transcript: '转写.md', notes: '笔记.md', summary: '纪要.md', index: '.diting-index.json' } as const

const pad = (n: number): string => String(n).padStart(2, '0')

/** 秒 → 12:34 / 1:02:03。 */
export function clock(sec: number): string {
  const s = Math.max(0, Math.floor(sec))
  const h = Math.floor(s / 3600); const m = Math.floor((s % 3600) / 60)
  return h ? `${h}:${pad(m)}:${pad(s % 60)}` : `${pad(m)}:${pad(s % 60)}`
}

/** 12:34 / 1:02:03 → 秒;认不出给 null。 */
export function parseClock(s: string): number | null {
  const m = /^\s*(?:(\d+):)?(\d{1,2}):(\d{2})\s*$/.exec(String(s))
  if (!m) return null
  return (Number(m[1] || 0)) * 3600 + Number(m[2]) * 60 + Number(m[3])
}

/** 文件夹 / 文件名里不能有的字符换成空格,首尾的点和空格去掉。 */
export function safeName(s: string): string {
  return String(s).replace(/[\\/:*?"<>|#^[\]\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').replace(/^[.\s]+|[.\s]+$/g, '').slice(0, 80)
}

export function folderName(d: Date, title: string): string {
  const stamp = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}${pad(d.getMinutes())}`
  const t = safeName(title)
  return t ? `${stamp} ${t}` : stamp
}

export function newRec(o: { id: string; folder: string; title: string; now: Date; source: Rec['source']; target: string }): Rec {
  return { v: 1, id: o.id, folder: o.folder, title: o.title, createdAt: o.now.toISOString(), duration: 0, status: 'live', source: o.source, target: o.target, segments: [], notes: [], chapters: [] }
}

export const rowOf = (r: Rec): IndexRow => ({ id: r.id, folder: r.folder, title: r.title, createdAt: r.createdAt, duration: r.duration, status: r.status })

/** 读回来的东西不可信(用户可能手改过):缺的字段补上,形状不对给 null。 */
export function reviveRec(raw: unknown, folder: string): Rec | null {
  const r = raw as Partial<Rec> | null
  if (!r || typeof r !== 'object' || typeof r.id !== 'string' || !Array.isArray(r.segments)) return null
  const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0)
  return {
    v: 1, id: r.id, folder, title: typeof r.title === 'string' ? r.title : '', createdAt: typeof r.createdAt === 'string' ? r.createdAt : new Date(0).toISOString(),
    duration: num(r.duration), status: r.status === 'live' || r.status === 'paused' ? r.status : 'done', source: r.source === 'file' ? 'file' : 'mic', target: typeof r.target === 'string' ? r.target : '', spoken: typeof r.spoken === 'string' ? r.spoken : '',
    audio: typeof r.audio === 'string' ? r.audio : undefined,
    asrModel: typeof r.asrModel === 'string' ? r.asrModel : '', translationModel: typeof r.translationModel === 'string' ? r.translationModel : '', trLang: typeof r.trLang === 'string' ? r.trLang : r.target,
    segments: r.segments.filter((s) => s && typeof s.text === 'string').map((s, i) => ({ ...s, id: typeof s.id === 'number' ? s.id : i + 1, start: num(s.start), end: num(s.end) })),
    notes: Array.isArray(r.notes) ? r.notes.filter((n) => n && typeof n.text === 'string').map((n, i) => ({ id: typeof n.id === 'number' ? n.id : i + 1, t: num(n.t), text: n.text })) : [],
    chapters: Array.isArray(r.chapters) ? r.chapters.filter((c) => c && typeof c.title === 'string').map((c) => ({ t: num(c.t), title: c.title })) : [],
    summary: typeof r.summary === 'string' ? r.summary : undefined, summaryAt: typeof r.summaryAt === 'string' ? r.summaryAt : undefined,
    summaryStyle: r.summaryStyle === 'meeting' || r.summaryStyle === 'interview' ? r.summaryStyle : r.summaryStyle === 'class' ? 'class' : undefined,
    chat: r.chat === true ? true : undefined,
  }
}

/** 给人看、也给 Tangu 读的转写:每句一段,时间在前;译文是紧跟着的引用块。 */
export function transcriptMd(r: Rec): string {
  const head = `# ${r.title || '转写'}\n\n`
  const body = r.segments.filter((s) => s.text).map((s) => `**[${clock(s.start)}]** ${s.text}${s.mark ? ' ★' : ''}${s.tr ? `\n\n> ${s.trTarget && s.trTarget !== r.target ? `[${s.trTarget}] ` : ''}${s.tr.replace(/\n+/g, ' ')}` : ''}`).join('\n\n')
  return `${head}${body}\n`
}

export function notesMd(r: Rec): string {
  return `# ${r.title || '笔记'}\n\n${r.notes.map((n) => `- [${clock(n.t)}] ${n.text.replace(/\n+/g, ' ')}`).join('\n')}\n`
}

/** 交给模型的转写正文:一行一句,[mm:ss] 开头。 */
export const plainLines = (segs: Segment[]): string => segs.filter((s) => s.text).map((s) => `[${clock(s.start)}] ${s.text}`).join('\n')

/** 按字数把转写切成几块(一次性补全的正文上限是 2 万字),不从一句中间切。 */
export function chunkSegments(segs: Segment[], maxChars: number): Segment[][] {
  const out: Segment[][] = []; let cur: Segment[] = []; let n = 0
  for (const s of segs) {
    const len = s.text.length + 9
    if (cur.length && n + len > maxChars) { out.push(cur); cur = []; n = 0 }
    cur.push(s); n += len
  }
  if (cur.length) out.push(cur)
  return out
}

/** 模型回的 JSON 常被包在代码块里、前后带话:取第一个配平的 {...}。解析不了给 null。 */
export function looseJson(text: string): any {
  const s = String(text || '')
  const from = s.indexOf('{')
  if (from < 0) return null
  let depth = 0; let inStr = false; let esc = false
  for (let i = from; i < s.length; i++) {
    const c = s[i]
    if (inStr) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === '"') inStr = false; continue }
    if (c === '"') inStr = true
    else if (c === '{') depth++
    else if (c === '}' && --depth === 0) { try { return JSON.parse(s.slice(from, i + 1)) } catch { return null } }
  }
  return null
}

/** 取 <tag>…</tag> 里的字(模型按标签回话比回 JSON 稳:句子里有引号也不会坏)。没有给 ''。 */
export function tagOf(text: string, tag: string): string {
  const m = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, 'i').exec(String(text || ''))
  return m ? m[1].trim() : ''
}

const words = (s: string): string[] => s.toLowerCase().replace(/[^\p{L}\p{N}\s']/gu, ' ').split(/\s+/).filter(Boolean)

/** 两句话差多少(按词的编辑距离 / 原句词数)。中文没有空格,按字算。 */
export function diffRatio(a: string, b: string): number {
  const cjk = /[぀-ヿ㐀-鿿]/.test(a)
  const x = cjk ? [...a.replace(/\s+/g, '')] : words(a); const y = cjk ? [...b.replace(/\s+/g, '')] : words(b)
  if (!x.length) return y.length ? 1 : 0
  let prev = Array.from({ length: y.length + 1 }, (_, i) => i)
  for (let i = 1; i <= x.length; i++) {
    const cur = [i]
    for (let j = 1; j <= y.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (x[i - 1] === y[j - 1] ? 0 : 1))
    prev = cur
  }
  return prev[y.length] / x.length
}

/** 模型说「改成这样」时收不收:只收小改动(改几个听错的词),整句重写的不收。 */
export function acceptFix(original: string, fixed: string): boolean {
  const f = String(fixed || '').trim()
  if (!f || f === original.trim()) return false
  return diffRatio(original, f) <= 0.34
}

/** 改了哪几处(按词对齐;中日韩文字按字)。给「听成了 X,改成 Y」和划线用。只是标点、大小写不同的不算。 */
export function changes(raw: string, fixed: string): Array<{ from: string; to: string }> {
  const cjk = /[぀-ヿ㐀-鿿가-힯]/.test(raw)
  const tok = (s: string): string[] => (cjk ? [...s.replace(/\s+/g, '')] : s.trim().split(/\s+/).filter(Boolean))
  const key = (w: string): string => w.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '')
  const a = tok(raw); const b = tok(fixed); const n = a.length; const m = b.length
  // 最长公共子序列:两句里都有、顺序也一样的词不算改动。
  const L = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1))
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) L[i][j] = key(a[i]) === key(b[j]) ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1])
  const out: Array<{ from: string; to: string }> = []; let fa: string[] = []; let fb: string[] = []
  const strip = (w: string[]): string => w.join(cjk ? '' : ' ').replace(/^[\s\p{P}]+|[\s\p{P}]+$/gu, '')
  const flush = (): void => { const from = strip(fa); const to = strip(fb); if (from || to) out.push({ from, to }); fa = []; fb = [] }
  let i = 0; let j = 0
  while (i < n && j < m) {
    if (key(a[i]) === key(b[j])) { flush(); i++; j++ } else if (L[i + 1][j] >= L[i][j + 1]) fa.push(a[i++]); else fb.push(b[j++])
  }
  fa.push(...a.slice(i)); fb.push(...b.slice(j)); flush()
  return out
}

const CJK = /[぀-ヿ㐀-鿿가-힯]/g
/** 这句话已经是目标语言了吗(粗判:中日韩文字占比)。目标不认识时一律当成要翻。 */
export function alreadyIn(text: string, target: string): boolean {
  const letters = text.replace(/[\s\d\p{P}\p{S}]/gu, '')
  if (!letters) return true
  const ratio = (letters.match(CJK) || []).length / letters.length
  if (target === 'zh') return ratio > 0.5 && !/[぀-ヿ가-힯]/.test(text)
  if (target === 'en') return ratio < 0.1 && /[a-z]/i.test(letters)
  return false
}

/** 识别结果里什么都没有(没人说话的片段会吐出「The.」「.」「Thank you.」这类东西)。 */
export function isJunk(text: string): boolean {
  const bare = String(text || '').replace(/[\s\p{P}\p{S}]/gu, '')
  if (bare.length < 2) return true
  return /^(the|a|an|uh|um|oh|yeah|okay|ok|you|thank|thanks|thankyou|嗯|啊|呃|그)$/i.test(bare)
}

/** 把术语表套到一句话上(不分大小写)。英文这类有空格的按整词换;中日韩文字没有词的边界,直接按字换。没变就是原句。 */
export function applyTerms(text: string, terms: Record<string, string>): string {
  let out = text
  for (const [from, to] of Object.entries(terms)) {
    if (!from.trim() || from === to) continue
    const esc = from.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const cjk = /[\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af]/.test(from)
    out = out.replace(new RegExp(cjk ? esc : `(?<![\\p{L}\\p{N}])${esc}(?![\\p{L}\\p{N}])`, 'giu'), () => to)
  }
  return out
}

/** 左栏分组:进行中 / 本周 / 更早。now 传进来,方便测。 */
export function groupOf(row: IndexRow, now: Date): 'live' | 'week' | 'earlier' {
  if (row.status !== 'done') return 'live'
  const d = new Date(row.createdAt)
  const monday = new Date(now); monday.setHours(0, 0, 0, 0); monday.setDate(monday.getDate() - ((monday.getDay() + 6) % 7))
  return d >= monday ? 'week' : 'earlier'
}

export interface SummaryParts { lead: string; points: Array<{ t: number; text: string }>; todos: Array<{ t: number; text: string }>; terms: Array<{ term: string; meaning: string; t: number }>; chapters: Chapter[] }

const tOf = (v: unknown): number => (typeof v === 'number' ? v : parseClock(String(v ?? '')) ?? 0)
const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '')

/** 模型回的纪要 JSON → 规整的结构(字段不全、类型不对的条目丢掉)。 */
export function readSummary(j: any): SummaryParts {
  const list = (v: unknown): any[] => (Array.isArray(v) ? v : [])
  return {
    lead: str(j?.lead),
    points: list(j?.points).map((p) => ({ t: tOf(p?.t), text: str(p?.text) })).filter((p) => p.text),
    todos: list(j?.todos).map((p) => ({ t: tOf(p?.t), text: str(p?.text) })).filter((p) => p.text),
    terms: list(j?.terms).map((p) => ({ term: str(p?.term), meaning: str(p?.meaning), t: tOf(p?.t) })).filter((p) => p.term && p.meaning),
    chapters: list(j?.chapters).map((p) => ({ t: tOf(p?.t), title: str(p?.title) })).filter((p) => p.title).sort((a, b) => a.t - b.t),
  }
}

export function mergeSummaries(parts: SummaryParts[]): SummaryParts {
  const seen = new Set<string>()
  return {
    lead: parts.map((p) => p.lead).filter(Boolean).join(' '),
    points: parts.flatMap((p) => p.points),
    todos: parts.flatMap((p) => p.todos),
    terms: parts.flatMap((p) => p.terms).filter((x) => { const k = x.term.toLowerCase(); if (seen.has(k)) return false; seen.add(k); return true }),
    chapters: parts.flatMap((p) => p.chapters).sort((a, b) => a.t - b.t),
  }
}

/** 纪要落成 Markdown。标题由调用方给(跟写的时候的界面语言)。时间写成 [mm:ss],页面上会变成能点的时间。 */
export function summaryMd(p: SummaryParts, h: { points: string; todos: string; terms: string }): string {
  const out: string[] = []
  if (p.lead) out.push(p.lead)
  if (p.points.length) out.push(`## ${h.points}\n\n${p.points.map((x) => `- ${x.text} [${clock(x.t)}]`).join('\n')}`)
  if (p.todos.length) out.push(`## ${h.todos}\n\n${p.todos.map((x) => `- [ ] ${x.text} [${clock(x.t)}]`).join('\n')}`)
  if (p.terms.length) out.push(`## ${h.terms}\n\n${p.terms.map((x) => `- **${x.term}**:${x.meaning} [${clock(x.t)}]`).join('\n')}`)
  return out.join('\n\n')
}
