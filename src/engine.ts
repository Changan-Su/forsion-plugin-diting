// 录音引擎,只在主窗口跑。状态挂在模块上而不是视图上:切到别的 Space、关掉标签页、把主窗口收进托盘,它都继续。
// ⚠️这里不许用定时器驱动采集和转写:窗口隐藏时定时器会被降频。一切由音频回调和 IPC 的回执推着走。
//
//   麦克风 → AudioContext(16 kHz) → ScriptProcessor → Slicer(按停顿切句) → 识别队列 → Segment → 翻译
//           └→ MediaRecorder(保留录音时) → 录音.webm
// 时间轴用「喂给 Slicer 的采样数」算,不看墙上的钟:暂停时不走,和录音文件里的时间对得上。

import { cancelSegment, cancelWaiting, onChanged, summarize, translate } from './ai'
import { captureModel, resolveModel } from './models'
import { t } from './i18n'
import { applyTerms, FILES, folderName, isJunk, newRec, type Rec, type Segment, type SummaryStyle, type ModelReceipt, type ChangeScope } from './model'
import { emit, prefs, S, setPref, sleep } from './state'
import { drop, init, loadRec, queued, remember, removeRow, root, saveRec, vaultReady } from './store'
import { base64, Slicer, wavBytes, type Utterance } from './vad'

const RATE = 16000
const IMPORT_MAX_HOURS = 2

let stream: MediaStream | null = null
let ac: AudioContext | null = null
let proc: ScriptProcessorNode | null = null
let media: MediaRecorder | null = null
let slicer: Slicer | null = null
let chunks: Blob[] = []
/** 每句带着它属于哪条记录:识别回来得晚(上一条已经收尾、下一条已经开始)时不能落错地方。 */
let queue: Array<{ u: Utterance; rec: Rec; choice: ReturnType<typeof captureModel> }> = []
let pumping: Promise<void> | null = null
let seq = 0
let rmsAvg = 0
/** 「标刚才这句」按下去的时候那句还没出字:记下按的时刻,等它出来再标。 */
let pendingMark: number | null = null
let dirty = false
let lastSave = 0
let lastPartial = 0
let partialBusy = false
let partialOn = false
let cancelImport = false
/** 插件被停用 / 重载时加一:还在等权限、等建文件夹的那次「开始」回来发现对不上,就把麦克风关掉,什么都不做。 */
let epoch = 0
/** 没转写成的那几段的声音先留在内存里,好让用户点「重试」。 */
const failed = new Map<string, Utterance>()
const failKey = (rec: Rec, segId: number): string => `${rec.id}:${segId}`
let onTick: () => void = () => undefined
/** 每次音频回调后叫一下(主窗口用它更新状态栏、把快照发给别的窗口)。 */
export const setTick = (fn: () => void): void => { onTick = fn }

const msg = (e: unknown): string => (e instanceof Error ? e.message : String(e))

const TIMEOUT = 'speech recognition timed out'

async function recognize(u: Utterance, choice = captureModel('asr', S.live?.asrModel), language = ''): Promise<string> {
  const captured = await choice
  if (captured.error || !captured.model) throw captured.error || new Error(t('modelUnavailable'))
  const model = captured.model
  const fn = window.tangu?.transcribeAudio
  if (!fn) throw new Error('speech recognition is not available in this window')
  // 识别一直不回来(云端卡住)时不能把后面的句子全堵死。
  // ponytail: 这是兜底用的定时器,不推采集和转写;窗口隐藏时它会被降频,45 秒可能拖到一两分钟才到,只是晚一点放行。
  const r = await Promise.race([fn({ audioBase64: base64(wavBytes(u.pcm, RATE)), mime: 'audio/wav', ...(language ? { language } : {}), ...(ctx.tangu?.modelCatalog ? { backend: model.backend, ...(model.id && model.id !== 'local' ? { modelId: model.id } : {}) } : {}) }), sleep(45_000).then(() => { throw new Error(TIMEOUT) })])
  return (typeof r === 'string' ? r : r?.text || '').trim()
}

function enqueue(u: Utterance, rec: Rec | null = S.live): void {
  if (!rec) return
  queue.push({ u, rec, choice: captureModel('asr', rec.asrModel) })
  pumping ??= pump().finally(() => { pumping = null })
}

// ponytail: 队列不设上限。识别出错的每句试三次、超时的不再试,就记成「没转写成」;云端一直超时的时候队列会越积越长,
// 到那一步该提示用户换本机模型,而不是继续排。
async function pump(): Promise<void> {
  while (queue.length) {
    const job = queue[0]; const { u, rec } = job
    let text = ''; let err: unknown = null
    // 窗口隐藏时定时器会被降频(几百毫秒能等成一分钟),所以隐藏时连着试,不等。
    for (let i = 0; i < 3; i++) {
      try { text = await recognize(u, job.choice, rec.spoken); err = null; break } catch (e) { err = e; if (msg(e) === TIMEOUT) break; if (i < 2 && !document.hidden) await sleep(700 * (i + 1)) }
    }
    // 收尾等不及时队列会被清掉、这句已经记成「没转写成」;迟到的结果直接不要,更不能落进后来开始的那条记录里。
    if (queue[0] !== job) continue
    queue.shift()
    if (S.live !== rec) continue
    if (err) { S.error = t('noAsr', { e: msg(err) }); addSegment(rec, u, '') } else if (!isJunk(text)) { S.error = ''; addSegment(rec, u, text, ctx.tangu?.modelCatalog ? (await job.choice).model || undefined : undefined) }
    S.partial = ''
    touch()
  }
}

function addSegment(rec: Rec, u: Utterance, raw: string, asrModel?: ModelReceipt): void {
  const text = applyTerms(raw, prefs().terms)
  // 比平时小很多的声音多半是离麦克风远的人(问问题的学生、会议室另一头),识别结果标成「没听清」。
  const low = !!text && rmsAvg > 0 && u.rms < rmsAvg * 0.25
  if (text && !low) rmsAvg = rmsAvg ? rmsAvg * 0.8 + u.rms * 0.2 : u.rms
  const seg: Segment = { ...(asrModel ? { asrModel } : {}), id: ++seq, start: Math.round(u.start * 10) / 10, end: Math.round(u.end * 10) / 10, text }
  if (low) seg.low = true
  if (!text) { seg.fail = true; failed.set(failKey(rec, seg.id), u); if (failed.size > 20) failed.delete(failed.keys().next().value!) }
  if (pendingMark != null && text) {
    // 按下去以后隔了很久才有下一句(当时那段声音没识别出东西):标的是按之前的那一句。
    const before = seg.start - pendingMark > 6 ? [...rec.segments].reverse().find((x) => x.text) : null
    ;(before || seg).mark = true; pendingMark = null
  }
  rec.segments.push(seg)
  rec.segments.sort((a, b) => a.start - b.start)
  if (text) translate(rec, seg)
}

/** 进行中的记录:标脏,攒着存(两秒一次,由音频回调带着走)。暂停时没有音频回调,当场存。 */
function touch(): void { dirty = true; if (S.phase === 'paused') void saveNow(); emit() }

function saveNow(): Promise<void> {
  const rec = S.live
  if (!rec) return Promise.resolve()
  dirty = false; lastSave = Date.now()
  rec.duration = Math.round(S.seconds)
  return saveRec(rec).catch((e) => { S.error = msg(e); emit() })
}

onChanged((rec) => { if (rec === S.live) touch(); else { void saveRec(rec).catch(() => undefined); emit() } })

function tick(): void {
  if (!slicer) return
  S.seconds = slicer.seconds
  S.level = slicer.level
  if (dirty && Date.now() - lastSave > 2000) void saveNow()
  if (partialOn) partial()
  onTick()
  emit()
}

// 「边说边显示」:一句话还没说完,先拿已经说出来的部分识别一次。只在识别队列空着的时候做,不跟正式的抢。
function partial(): void {
  if (!slicer || partialBusy || queue.length) return
  if (!slicer.speaking) return
  if (slicer.seconds - lastPartial < 1.6) return
  const cur = slicer.current()
  if (!cur) return
  lastPartial = slicer.seconds; partialBusy = true
  const partialRec = S.live; const selected = partialRec?.asrModel
  recognize(cur, captureModel('asr', selected), partialRec?.spoken).then((text) => { if (S.live === partialRec && S.live?.asrModel === selected && slicer?.speaking && !queue.length) S.partial = isJunk(text) ? '' : applyTerms(text, prefs().terms) }).catch(() => undefined).finally(() => { partialBusy = false })
}

function resample(input: Float32Array, from: number): Float32Array {
  const n = Math.floor((input.length * RATE) / from); const out = new Float32Array(n); const step = from / RATE
  for (let i = 0; i < n; i++) { const p = i * step; const a = Math.floor(p); const b = Math.min(a + 1, input.length - 1); out[i] = input[a] + (input[b] - input[a]) * (p - a) }
  return out
}

async function create(o: { title: string; target: string; spoken?: string; source: Rec['source']; asrModel?: string; translationModel?: string }): Promise<Rec> {
  if (!(await vaultReady())) throw new Error(t('noVault'))
  await init()
  const now = new Date()
  const base = `${root()}/${folderName(now, o.title)}`; let folder = base
  // 同一分钟里同名的往后编号,直到列表里和盘上都没有这个文件夹:绝不写进一条已有的记录里。
  for (let n = 2; S.index.some((r) => r.folder === folder) || (await ctx.app.readFile(`${folder}/${FILES.record}`).catch(() => null)); n++) folder = `${base} ${n}`
  const rec = newRec({ id: `${now.getTime().toString(36)}${Math.random().toString(36).slice(2, 6)}`, folder, title: o.title.trim() || t('untitled'), now, source: o.source, target: o.target })
  rec.spoken = o.spoken ?? prefs().spoken; rec.asrModel = o.asrModel ?? prefs().asrModel; rec.translationModel = o.translationModel ?? prefs().translationModel
  seq = 0; rmsAvg = 0; pendingMark = null; queue = []; chunks = []
  remember(rec)
  S.live = rec; S.open = rec; S.seconds = 0; S.partial = ''; S.error = ''; S.progress = 0
  await saveRec(rec)
  return rec
}

export async function start(o: { title?: string; target?: string; spoken?: string; keep?: boolean; asrModel?: string; translationModel?: string } = {}): Promise<void> {
  if (S.phase !== 'idle') { ctx.notify?.(t('busy'), { level: 'warning' }); return }
  const p = prefs(); const my = epoch
  const alive = (): void => { if (my !== epoch) throw new Error('disposed') }
  S.phase = 'starting'; S.error = ''; emit()
  let mic: MediaStream | null = null
  try {
    // 先拿到麦克风再建记录:没权限时不留下一个空文件夹。
    mic = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: false, noiseSuppression: true, autoGainControl: true } })
    alive()
    // 要等的事(问宿主用哪种识别、建文件夹)都放在开录之前:开录以后一步都不等,录音文件和时间轴才是同时起步的。
    const backend = (await resolveModel('asr', o.asrModel ?? p.asrModel)).backend || (await window.tangu?.getConfig?.().catch(() => null))?.asrBackend
    const rec = await create({ title: o.title || '', target: o.target ?? p.target, spoken: o.spoken, source: 'mic', asrModel: o.asrModel, translationModel: o.translationModel })
    alive()
    stream = mic
    ac = new AudioContext({ sampleRate: RATE })
    await ac.resume().catch(() => undefined)
    alive()
    const from = ac.sampleRate
    slicer = new Slicer({ rate: RATE })
    const src = ac.createMediaStreamSource(stream)
    proc = ac.createScriptProcessor(4096, 1, 1)
    // ScriptProcessor 要接到输出上才会被调;中间垫一个音量为 0 的节点,保证什么都放不出来。
    const mute = ac.createGain(); mute.gain.value = 0
    // ponytail: 暂停 / 继续是按 4096 采样一块对齐的,录音文件和时间轴每次暂停会差出 ±0.1 秒左右(有正有负,不会一直往一边偏)。
    proc.onaudioprocess = (e) => {
      if (S.phase !== 'live' || !slicer) return
      const input = e.inputBuffer.getChannelData(0)
      for (const u of slicer.push(from === RATE ? input : resample(input, from))) enqueue(u, rec)
      tick()
    }
    src.connect(proc); proc.connect(mute); mute.connect(ac.destination)
    // 麦克风被拔掉 / 系统收回了设备:声音不会再来了,把已经记下的收尾存好,别停在「正在记录」上空转。
    stream.getAudioTracks()[0]?.addEventListener('ended', () => { if (S.live === rec) void stop() })
    // 系统睡眠醒来后音频可能被挂起:试着接着录。
    const ctxNow = ac
    ctxNow.onstatechange = () => { if (ac === ctxNow && ctxNow.state !== 'running' && ctxNow.state !== 'closed' && S.phase === 'live') void ctxNow.resume().catch(() => undefined) }

    if ((o.keep ?? p.keep) && typeof MediaRecorder !== 'undefined' && ctx.app.writeBytes) {
      const mime = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4'].find((m) => MediaRecorder.isTypeSupported(m))
      media = new MediaRecorder(stream, { ...(mime ? { mimeType: mime } : {}), audioBitsPerSecond: 32000 })
      rec.audio = `录音.${mime?.includes('mp4') ? 'm4a' : 'webm'}`
      // 每 10 秒出一块;第一块和之后每三分钟把整份录音覆盖写一遍,中途崩了也留得住大部分。
      // 顺带标脏:一直没人说话的时候,录音文件名和已经录了多久也要存下去。
      // ponytail: 每次都是整份重写(50 分钟约 12 MB),写到一半崩了这份文件可能是坏的。录到几小时会变重,到时候换成宿主的追加写接口。
      media.ondataavailable = (e) => { if (e.data.size) { chunks.push(e.data); if (chunks.length % 18 === 1) { void writeAudio(rec); dirty = true } } }
      media.onerror = () => { ctx.notify?.(t('audioNotSaved'), { level: 'warning' }) }
      media.start(10_000)
    }
    partialOn = p.partial === 'on' || (p.partial === 'auto' && backend === 'local')
    S.phase = 'live'; lastSave = Date.now(); dirty = true
    emit(); onTick()
  } catch (e) {
    mic?.getTracks().forEach((tr) => tr.stop())
    teardown()
    S.phase = 'idle'
    if (S.live) { S.live.status = 'done'; void saveRec(S.live).catch(() => undefined); S.live = null }
    if (my === epoch) {
      const name = (e as { name?: string })?.name
      S.error = name === 'NotAllowedError' || name === 'SecurityError' ? t('micDenied') : msg(e) === t('noVault') ? msg(e) : t('noMic', { e: msg(e) })
    }
    emit(); onTick()
  }
}

/** 插件被停用 / 重载:正在录的收尾存盘,还没录起来的作废。不留一个没人管的麦克风。 */
export function dispose(): void {
  epoch++
  if (S.live && S.phase !== 'starting') void stop()
  flush()
}

/** 返回有没有写成。 */
function writeAudio(rec: Rec): Promise<boolean> {
  if (!rec.audio || !chunks.length || !ctx.app.writeBytes) return Promise.resolve(true)
  const parts = chunks.slice(); const path = `${rec.folder}/${rec.audio}`
  return queued(async () => { await ctx.app.writeBytes!(path, new Uint8Array(await new Blob(parts).arrayBuffer())) }).then(() => true, (e) => { console.warn('[diting] audio', e); return false })
}

function teardown(): void {
  try { proc?.disconnect() } catch { /* 已经断开 */ }
  if (proc) proc.onaudioprocess = null
  stream?.getTracks().forEach((tr) => tr.stop())
  void ac?.close().catch(() => undefined)
  proc = null; ac = null; stream = null; media = null; slicer = null; partialOn = false; S.level = 0
}

export function pause(): void {
  if (S.phase !== 'live' || !S.live || !slicer) return
  S.phase = 'paused'; S.live.status = 'paused'
  const u = slicer.flush(); if (u) enqueue(u, S.live)
  try { media?.pause() } catch { /* 没在录 */ }
  S.partial = ''; S.level = 0
  void saveNow(); emit(); onTick()
}

export function resume(): void {
  if (S.phase !== 'paused' || !S.live) return
  try { media?.resume() } catch { /* 没在录 */ }
  S.phase = 'live'; S.live.status = 'live'
  emit(); onTick()
}

export async function stop(): Promise<void> {
  const rec = S.live
  if (!rec || (S.phase !== 'live' && S.phase !== 'paused' && S.phase !== 'importing')) return
  if (S.phase === 'importing') { cancelImport = true; return }
  S.phase = 'stopping'; emit(); onTick()
  const u = slicer?.flush(); if (u) enqueue(u, rec)
  const duration = slicer?.seconds ?? S.seconds
  const rec0 = media
  if (rec0 && rec0.state !== 'inactive') { const done = new Promise<void>((r) => { rec0.onstop = () => r() }); try { rec0.stop() } catch { /* 已经停了 */ } await Promise.race([done, sleep(3000)]) }
  teardown()
  await finish(rec, duration)
}

/** 收尾:等识别队列走完(最多一分钟,剩下的记成没转写成,不丢时间段)→ 写录音 → 写文件 → 才算结束。 */
async function finish(rec: Rec, duration: number): Promise<void> {
  if (pumping) await Promise.race([pumping, sleep(60_000)])
  for (const job of queue.splice(0)) if (job.rec === rec) addSegment(rec, job.u, '')
  if (pendingMark != null) { const last = [...rec.segments].reverse().find((x) => x.text); if (last) last.mark = true; pendingMark = null }
  rec.duration = Math.round(duration); rec.status = 'done'
  // 最后这一次写不下去(库被关了、盘满了)就再试一次;还是不行要明说,不能装作存好了。
  // ponytail: 只试两次。记录本身还在内存里(之后任何一次修改都会再存),录音那几块到下次开始记录时才丢。
  let audioOk = await writeAudio(rec); if (!audioOk) { await sleep(1500); audioOk = await writeAudio(rec) }
  let err = ''
  await saveRec(rec).catch((e) => { err = msg(e) })
  if (err) { await sleep(1500); err = ''; await saveRec(rec).catch((e) => { err = msg(e) }) }
  if (audioOk) chunks = []
  S.live = null; S.phase = 'idle'; S.partial = ''; S.seconds = 0; S.progress = 0
  if (err) S.error = err
  if (!audioOk) ctx.notify?.(t('audioNotSaved'), { level: 'warning' })
  emit(); onTick()
  if (prefs().autoSummary && rec.segments.some((s) => s.text)) void summarize(rec, prefs().style)
}

/** 导入一个音频 / 视频文件:解码成 16 kHz 单声道,走和麦克风同一条路(切句 → 识别 → 翻译)。全程不出声。 */
export async function importFile(file: File, options: { asrModel?: string; translationModel?: string; target?: string; spoken?: string; keep?: boolean } = {}): Promise<void> {
  if (S.phase !== 'idle') { ctx.notify?.(t('busy'), { level: 'warning' }); return }
  S.phase = 'starting'; S.error = ''; emit()
  let rec: Rec | null = null
  try {
    const bytes = await file.arrayBuffer()
    // ponytail: 整个文件解码进内存(两小时单声道约 460 MB),所以设了时长上限。更长的要靠宿主按路径转写的接口。
    const off = new OfflineAudioContext(1, 1, RATE)
    const buf = await off.decodeAudioData(bytes.slice(0))
    if (buf.duration > IMPORT_MAX_HOURS * 3600) throw new Error(t('importTooLong', { h: IMPORT_MAX_HOURS }))
    const pcm = new Float32Array(buf.length)
    for (let c = 0; c < buf.numberOfChannels; c++) { const ch = buf.getChannelData(c); for (let i = 0; i < ch.length; i++) pcm[i] += ch[i] / buf.numberOfChannels }
    const p = { ...prefs(), ...options }
    await resolveModel('asr', p.asrModel)
    rec = await create({ title: file.name.replace(/\.[^.]+$/, ''), target: p.target, spoken: p.spoken, source: 'file', asrModel: p.asrModel, translationModel: p.translationModel })
    if (p.keep && ctx.app.writeBytes) {
      const ext = (/\.([a-z0-9]{2,5})$/i.exec(file.name)?.[1] || 'audio').toLowerCase()
      rec.audio = `录音.${ext}`
      await queued(() => ctx.app.writeBytes!(`${rec!.folder}/${rec!.audio}`, new Uint8Array(bytes)))
    }
    S.phase = 'importing'; cancelImport = false; emit(); onTick()
    const sl = new Slicer({ rate: RATE })
    for (let o = 0; o < pcm.length && !cancelImport; o += RATE) {
      const us = sl.push(pcm.subarray(o, Math.min(pcm.length, o + RATE)))
      for (const u of us) { enqueue(u, rec); await pumping }
      S.seconds = sl.seconds; S.progress = Math.min(1, o / pcm.length)
      if (dirty && Date.now() - lastSave > 2000) void saveNow()
      if (us.length) { onTick(); emit() }
    }
    const last = sl.flush(); if (last && !cancelImport) enqueue(last, rec)
    await finish(rec, cancelImport ? sl.seconds : buf.duration)
  } catch (e) {
    S.phase = 'idle'
    if (rec && S.live === rec) { rec.status = 'done'; void saveRec(rec).catch(() => undefined); S.live = null }
    S.error = msg(e) === t('noVault') || msg(e).startsWith(t('importTooLong', { h: IMPORT_MAX_HOURS }).slice(0, 6)) ? msg(e) : t('importFailed', { e: msg(e) })
    emit(); onTick()
  }
}

// ── 对一条记录的修改(进行中的、看着的旧记录都走这里;别的窗口发来的操作也落到这里)──────────────────────────

export type Cmd =
  | { c: 'start'; title?: string; target?: string; spoken?: string; keep?: boolean; asrModel?: string; translationModel?: string }
  | { c: 'pause' } | { c: 'resume' } | { c: 'stop' }
  | { c: 'mark'; rec?: string; seg?: number }
  | { c: 'note'; rec: string; text: string; t: number }
  | { c: 'delNote'; rec: string; note: number }
  | { c: 'rename'; rec: string; title: string }
  | { c: 'revert'; rec: string; seg: number }
  | { c: 'term'; from: string; to: string }
  | { c: 'retry'; rec: string; seg: number }
  | { c: 'retryAll'; rec: string }
  | { c: 'termRemove'; from: string }
  | { c: 'model'; rec: string; kind: 'asr' | 'translation'; value: string; scope?: ChangeScope }
  | { c: 'target'; rec: string; target: string; scope?: ChangeScope }
  | { c: 'summarize'; rec: string; style: SummaryStyle }
  | { c: 'delete'; rec: string }
  | { c: 'chatOn'; rec: string }

const modelChanges = new Map<string, number>()
async function find(id: string): Promise<Rec | null> {
  if (S.live?.id === id) return S.live
  if (S.open?.id === id) return S.open
  const row = S.index.find((r) => r.id === id)
  return row ? loadRec(row.folder) : null
}

function commit(rec: Rec): void {
  if (rec === S.live) touch(); else { void saveRec(rec).catch((e) => { S.error = msg(e); emit() }); emit() }
}

export async function apply(cmd: Cmd): Promise<void> {
  switch (cmd.c) {
    case 'start': return start(cmd)
    case 'pause': return pause()
    case 'resume': return resume()
    case 'stop': return stop()
    case 'term': {
      const from = cmd.from.trim(); const to = cmd.to.trim()
      if (from && to && from.toLowerCase() !== to.toLowerCase()) setPref('terms', { ...prefs().terms, [from]: to })
      return
    }
    case 'termRemove': { const terms = { ...prefs().terms }; delete terms[cmd.from]; setPref('terms', terms); return }
    case 'delete': {
      if (S.live?.id === cmd.rec) return
      const row = S.index.find((r) => r.id === cmd.rec)
      if (!row) return
      // 文件夹里全是这次记录自己的东西(转写、笔记、纪要、录音),整个进回收站。
      // 先立碑(还在路上的翻译 / 纪要回来不许再存),再排在已有的写盘后面进回收站。
      const removing = await find(row.id); if (removing) cancelWaiting(removing)
      drop(row)
      if (ctx.app.trash) await queued(() => ctx.app.trash!(row.folder)).catch((e) => console.warn('[diting] trash', e))
      await removeRow(row.id)
      if (S.open?.id === row.id) S.open = null
      emit()
      return
    }
    default:
  }
  const live = S.live
  const rec = cmd.c === 'mark' && !cmd.rec ? live : await find((cmd as { rec: string }).rec)
  if (!rec) return
  switch (cmd.c) {
    case 'mark': {
      if (cmd.seg != null) { const s = rec.segments.find((x) => x.id === cmd.seg); if (s) s.mark = !s.mark || undefined }
      // 没指定哪一句 = 「刚才这句」:正在说或者还在识别的,等它出来再标。
      else if (rec === live && (slicer?.speaking || queue.length)) pendingMark = slicer?.seconds ?? S.seconds
      else { const s = [...rec.segments].reverse().find((x) => x.text); if (s) s.mark = true }
      break
    }
    case 'note': { const text = cmd.text.trim(); if (text) rec.notes.push({ id: rec.notes.reduce((m, n) => Math.max(m, n.id), 0) + 1, t: Math.max(0, Math.round(cmd.t)), text }); break }
    case 'delNote': rec.notes = rec.notes.filter((n) => n.id !== cmd.note); break
    case 'rename': { const title = cmd.title.trim(); if (title) rec.title = title; break }
    case 'revert': { const s = rec.segments.find((x) => x.id === cmd.seg); if (s?.raw) { cancelSegment(rec, s); s.text = s.raw; s.raw = undefined } break }
    case 'retry': {
      const s = rec.segments.find((x) => x.id === cmd.seg)
      if (!s) break
      const u = s.fail ? failed.get(failKey(rec, s.id)) : null
      if (u) {
        const choice = captureModel('asr', rec.asrModel)
        try { const text = applyTerms(await recognize(u, choice, rec.spoken), prefs().terms); if (!isJunk(text)) { s.text = text; s.asrModel = ctx.tangu?.modelCatalog ? (await choice).model || undefined : undefined; s.fail = undefined; failed.delete(failKey(rec, s.id)); S.error = ''; translate(rec, s) } } catch (e) { S.error = t('noAsr', { e: msg(e) }) }
      } else if (s.text) { s.trState = undefined; translate(rec, s) }
      break
    }
    case 'retryAll': {
      if (S.retrying) return
      S.retrying = rec.id; emit()
      try { for (const seg of rec.segments.filter(s => s.trState === 'fail' || (s.fail && canRetry(rec, s.id)))) await apply({ c: 'retry', rec: rec.id, seg: seg.id }) }
      finally { S.retrying = ''; emit() }
      break
    }
    case 'model': {
      const changeKey = `${rec.id}:${cmd.kind}`; const revision = (modelChanges.get(changeKey) || 0) + 1; modelChanges.set(changeKey, revision)
      const choice = await resolveModel(cmd.kind, cmd.value)
      if (modelChanges.get(changeKey) !== revision) return
      if (cmd.kind === 'asr') { rec.asrModel = cmd.value; if (rec === S.live) { partialOn = prefs().partial === 'on' || (prefs().partial === 'auto' && choice.backend === 'local'); S.partial = '' } }
      else { rec.translationModel = cmd.value; retranslate(rec, cmd.scope || 'future') }
      break
    }
    case 'target': {
      if (rec.target === cmd.target) return
      for (const seg of rec.segments) if (seg.tr && !seg.trTarget) seg.trTarget = rec.trLang || rec.target
      rec.target = cmd.target
      if (!cmd.target) cancelWaiting(rec)
      else { rec.trLang = cmd.target; retranslate(rec, cmd.scope || 'all') }
      break
    }
    case 'summarize': void summarize(rec, cmd.style); return
    case 'chatOn': if (rec.chat) return; rec.chat = true; break
    default: return
  }
  commit(rec)
}

function retranslate(rec: Rec, scope: ChangeScope): void {
  if (!rec.target || scope === 'future') return
  if (scope === 'all') cancelWaiting(rec)
  for (const seg of rec.segments) if (seg.text && !seg.fail && (scope === 'all' || seg.trState === 'fail')) translate(rec, seg)
}

/** 这一段还能不能重试(声音还在内存里)。 */
export const canRetry = (rec: Rec, segId: number): boolean => failed.has(failKey(rec, segId))

/** 退出 / 刷新前把攒着的写下去(能写多少算多少)。 */
export function flush(): void { if (S.live && dirty) void saveNow() }
