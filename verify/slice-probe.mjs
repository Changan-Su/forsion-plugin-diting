// 把一段真实录音(16 kHz 单声道 WAV)喂给切句器,看切成了多长的句子、停顿到底有多安静。不开界面、不出声。
//   node verify/slice-probe.mjs /path/to/16k-mono.wav        OPTS='{"midSilenceMs":400}' 可以试别的参数
import { build } from 'esbuild'
import { readFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
const wav = process.argv[2]; const repo = new URL('..', import.meta.url).pathname
const dir = mkdtempSync(join(tmpdir(), 'slice-'))
await build({ entryPoints: [join(repo, 'src/vad.ts')], bundle: true, format: 'esm', outfile: join(dir, 'vad.mjs'), logLevel: 'silent' })
const V = await import(pathToFileURL(join(dir, 'vad.mjs')).href)
const b = readFileSync(wav); const data = b.subarray(b.indexOf('data') + 8)
const pcm = new Float32Array(data.length >> 1); for (let i = 0; i < pcm.length; i++) pcm[i] = data.readInt16LE(i * 2) / 32768
const opts = process.env.OPTS ? JSON.parse(process.env.OPTS) : {}
const s = new V.Slicer(opts); const us = []
// 每 20ms 的音量分布,看停顿到底有多安静
const fr = 320; const rms = []; for (let o = 0; o + fr <= pcm.length; o += fr) { let q = 0; for (let i = 0; i < fr; i++) q += pcm[o + i] ** 2; rms.push(Math.sqrt(q / fr)) }
const sorted = [...rms].sort((a, b) => a - b); const pct = (p) => sorted[Math.floor(sorted.length * p)].toFixed(4)
console.log('20ms 帧音量分位:p5', pct(0.05), 'p10', pct(0.1), 'p25', pct(0.25), 'p50', pct(0.5), 'p75', pct(0.75), 'p95', pct(0.95))
for (let o = 0; o < pcm.length; o += 4096) us.push(...s.push(pcm.subarray(o, Math.min(pcm.length, o + 4096))))
const last = s.flush(); if (last) us.push(last)
const len = us.map((u) => u.end - u.start)
console.log('句数', us.length, '总时长', (pcm.length / 16000).toFixed(0), '秒;句长 中位', [...len].sort((a, b) => a - b)[len.length >> 1]?.toFixed(1), '最长', Math.max(...len).toFixed(1), '≥17.5 秒的', len.filter((x) => x >= 17.5).length)
console.log(len.map((x) => x.toFixed(1)).join(' '))
