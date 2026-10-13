// 按停顿把连续的声音切成一句一句(纯函数式的小状态机,不碰 DOM;check.mjs 直接测)。
// 输入:16 kHz 单声道的帧,怎么来的不管(麦克风、导入的文件都走这里)。
// 输出:一句话的起止时间和它的采样。没人说话的时候什么都不输出,所以静音不会被送去识别。

export interface Utterance { start: number; end: number; pcm: Float32Array; /** 出声部分的平均音量,用来判断是不是离麦克风很远的人。 */ rms: number }

export interface SlicerOptions {
  rate?: number
  /** 停顿多久算一句话说完(不管这句多短)。 */
  minSilenceMs?: number
  /** 说了这么久以后,短一点的停顿(midSilenceMs)也算说完。 */
  midLenMs?: number
  midSilenceMs?: number
  /** 短于这个的声音当成杂音丢掉。 */
  minSpeechMs?: number
  /** 一句话超过这么长,就在下一个短停顿处切开。 */
  softMaxMs?: number
  /** 说到这么长还不停,硬切。 */
  hardMaxMs?: number
}

const FRAME_MS = 20

export class Slicer {
  readonly rate: number
  private readonly frame: number
  private readonly minSilence: number
  private readonly midLen: number
  private readonly midSilence: number
  private readonly shortSilence: number
  private readonly minSpeech: number
  private readonly softMax: number
  private readonly hardMax: number
  private readonly preRoll: number
  private readonly tail: number

  /** 已经处理过的采样数(= 记录的时间轴)。 */
  private total = 0
  private carry = new Float32Array(0)
  /** 底噪的估计:没人说话时慢慢跟上去,安静下来立刻跟下来。 */
  private floor = 0.002
  private buf: Float32Array[] = []
  private bufLen = 0
  private pre: Float32Array[] = []
  private preLen = 0
  private inSpeech = false
  private startAt = 0
  private speechRun = 0
  private silenceRun = 0
  private voiced = 0
  private energy = 0
  private runEnergy = 0
  /** 最近一帧的音量(0..1,给界面画音量条)。 */
  level = 0

  constructor(o: SlicerOptions = {}) {
    this.rate = o.rate ?? 16000
    const ms = (v: number): number => Math.round((v / 1000) * this.rate)
    this.frame = ms(FRAME_MS)
    // 人说话中间会顿一下(想词、换气)。停顿一到就切,一句话会被切成好几截,读起来碎、翻译也差,
    // 所以短句要等一个真的停顿(1.2 秒);已经说了一阵的,短一点的停顿就可以切。
    this.minSilence = ms(o.minSilenceMs ?? 1200)
    this.midLen = ms(o.midLenMs ?? 5000)
    this.midSilence = ms(o.midSilenceMs ?? 650)
    this.shortSilence = ms(220)
    this.minSpeech = ms(o.minSpeechMs ?? 300)
    this.softMax = ms(o.softMaxMs ?? 11000)
    this.hardMax = ms(o.hardMaxMs ?? 18000)
    this.preRoll = ms(240)
    this.tail = ms(160)
  }

  get seconds(): number { return this.total / this.rate }
  get speaking(): boolean { return this.inSpeech }
  /** 正在说的这一句到现在为止的采样(给「边说边显示」用);不在说话给 null。 */
  current(): Utterance | null {
    if (!this.inSpeech || this.bufLen < this.rate) return null
    return { start: this.startAt / this.rate, end: this.total / this.rate, pcm: join(this.buf, this.bufLen), rms: Math.sqrt(this.energy / Math.max(1, this.voiced)) }
  }

  push(input: Float32Array): Utterance[] {
    const out: Utterance[] = []
    let data = input
    if (this.carry.length) { data = new Float32Array(this.carry.length + input.length); data.set(this.carry); data.set(input, this.carry.length) }
    let o = 0
    for (; o + this.frame <= data.length; o += this.frame) {
      const u = this.step(data.subarray(o, o + this.frame))
      if (u) out.push(u)
    }
    this.carry = data.slice(o)
    return out
  }

  /** 结束时把还没说完的那一句交出来。 */
  flush(): Utterance | null {
    const u = this.inSpeech ? this.close(0) : null
    this.carry = new Float32Array(0)
    return u
  }

  private step(f: Float32Array): Utterance | null {
    let sum = 0
    for (let i = 0; i < f.length; i++) sum += f[i] * f[i]
    const rms = Math.sqrt(sum / f.length)
    this.level = Math.min(1, rms * 6)
    const thr = Math.max(0.006, this.floor * 3.2)
    const loud = rms > thr
    this.total += f.length

    if (!this.inSpeech) {
      this.floor = rms < this.floor ? rms * 0.5 + this.floor * 0.5 : this.floor * 0.995 + rms * 0.005
      this.pre.push(f.slice()); this.preLen += f.length
      while (this.preLen - this.pre[0].length >= this.preRoll) this.preLen -= this.pre.shift()!.length
      this.speechRun = loud ? this.speechRun + f.length : 0
      this.runEnergy = loud ? this.runEnergy + sum : 0
      // 连着三帧(60 毫秒)都响才算开口,一下的咔哒声不算。
      if (this.speechRun >= this.frame * 3) {
        this.inSpeech = true
        this.buf = this.pre; this.bufLen = this.preLen
        this.startAt = this.total - this.preLen
        this.pre = []; this.preLen = 0
        // 判定开口用掉的这几帧本身就是说话声,要算进去(不然刚够长的一个词会被当成杂音丢掉)。
        this.silenceRun = 0; this.voiced = this.speechRun; this.energy = this.runEnergy; this.speechRun = 0; this.runEnergy = 0
      }
      return null
    }

    this.buf.push(f.slice()); this.bufLen += f.length
    if (loud) { this.silenceRun = 0; this.voiced += f.length; this.energy += sum } else this.silenceRun += f.length
    const need = this.bufLen >= this.softMax ? this.shortSilence : this.bufLen >= this.midLen ? this.midSilence : this.minSilence
    if (this.silenceRun >= need) return this.close(this.silenceRun)
    if (this.bufLen >= this.hardMax) return this.close(0)
    return null
  }

  /** 收一句:尾巴上的静音只留一小段。真正出声的部分太短就当杂音丢掉。 */
  private close(trailingSilence: number): Utterance | null {
    const drop = Math.max(0, trailingSilence - this.tail)
    const len = this.bufLen - drop
    const pcm = join(this.buf, this.bufLen).subarray(0, len)
    const u: Utterance = { start: this.startAt / this.rate, end: (this.startAt + len) / this.rate, pcm, rms: Math.sqrt(this.energy / Math.max(1, this.voiced)) }
    const keep = this.voiced >= this.minSpeech
    this.inSpeech = false; this.buf = []; this.bufLen = 0; this.silenceRun = 0; this.speechRun = 0; this.voiced = 0; this.energy = 0; this.runEnergy = 0
    return keep ? u : null
  }
}

function join(parts: Float32Array[], total: number): Float32Array {
  const out = new Float32Array(total); let o = 0
  for (const p of parts) { out.set(p, o); o += p.length }
  return out
}

/** Float32 PCM([-1,1]) → 16 位单声道 WAV 的字节。 */
export function wavBytes(pcm: Float32Array, rate: number): Uint8Array {
  const n = pcm.length
  const buf = new ArrayBuffer(44 + n * 2); const dv = new DataView(buf)
  const w = (o: number, s: string): void => { for (let i = 0; i < s.length; i++) dv.setUint8(o + i, s.charCodeAt(i)) }
  w(0, 'RIFF'); dv.setUint32(4, 36 + n * 2, true); w(8, 'WAVE'); w(12, 'fmt ')
  dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, 1, true); dv.setUint32(24, rate, true)
  dv.setUint32(28, rate * 2, true); dv.setUint16(32, 2, true); dv.setUint16(34, 16, true); w(36, 'data'); dv.setUint32(40, n * 2, true)
  for (let i = 0; i < n; i++) { const s = Math.max(-1, Math.min(1, pcm[i])); dv.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true) }
  return new Uint8Array(buf)
}

export function base64(bytes: Uint8Array): string {
  let bin = ''
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(bin)
}
