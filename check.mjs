#!/usr/bin/env node
// 不开界面的自检:纯逻辑(切句、数据模型、文案成对)+ 发布物和源码是否一致。  node check.mjs
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { options } from './build.mjs'

const dir = mkdtempSync(join(tmpdir(), 'diting-check-'))
let n = 0
const test = (name, fn) => { fn(); n++; console.log(`✓ ${name}`) }
try {
  await build({ entryPoints: ['src/model.ts', 'src/vad.ts', 'src/i18n.ts', 'src/ai.ts'], bundle: true, format: 'esm', outdir: dir, outExtension: { '.js': '.mjs' }, logLevel: 'silent' })
  const load = (f) => import(pathToFileURL(join(dir, f)).href)
  globalThis.document = { documentElement: { dataset: {} } }; globalThis.localStorage = { getItem: () => null, setItem: () => undefined }
  const M = await load('model.mjs'); const V = await load('vad.mjs'); const I = await load('i18n.mjs'); const A = await load('ai.mjs')

  test('文案:zh / en 键一样、占位符一样、英文里没有中文', () => {
    const { zh, en } = I.MSG
    assert.deepEqual(Object.keys(zh).sort(), Object.keys(en).sort())
    const names = new Set(['langZh', 'langJa', 'langKo']) // 语言名用它自己的文字写,不算
    for (const k of Object.keys(zh)) {
      assert.deepEqual((zh[k].match(/\{\w+\}/g) || []).sort(), (en[k].match(/\{\w+\}/g) || []).sort(), k)
      if (!names.has(k)) assert.ok(!/[぀-ヿ㐀-鿿가-힯]/.test(en[k]), `en.${k} 里有中日韩文字`)
    }
  })
  test('文案:占位符只替一趟', () => { I.setLocale('zh'); assert.equal(I.t('fixed', { from: '{to}', to: 'B' }), '听成了 {to}，按上下文改成 B') })
  test('提示词不超过一次性补全的指令上限', () => {
    assert.ok(A.PROMPTS.translate('Simplified Chinese').length < 2000)
    for (const s of ['class', 'meeting', 'interview']) assert.ok(A.PROMPTS.summary(s, 'Simplified Chinese', 12, 12).length < 2000, s)
    assert.ok(!/[㐀-鿿]/.test(A.PROMPTS.translate('English') + A.PROMPTS.summary('class', 'English', 1, 1)), '给模型的提示词应该是英文')
  })

  test('时间:写出去再读回来', () => {
    for (const s of [0, 59, 60, 754, 3599, 3600, 7325]) assert.equal(M.parseClock(M.clock(s)), s)
    assert.equal(M.clock(754), '12:34'); assert.equal(M.clock(3723), '1:02:03'); assert.equal(M.parseClock('abc'), null)
  })
  test('文件夹名:去掉不能用的字符', () => {
    assert.equal(M.folderName(new Date(2026, 9, 13, 9, 5), 'PHYS3721: 第 2 讲 / 原子?'), '2026-10-13 0905 PHYS3721 第 2 讲 原子')
    assert.equal(M.folderName(new Date(2026, 9, 13, 9, 5), ''), '2026-10-13 0905')
    assert.equal(M.safeName('..  a\u0000b  '), 'a b')
  })
  test('读回来的记录:形状不对给 null,缺的字段补上', () => {
    assert.equal(M.reviveRec(null, 'f'), null); assert.equal(M.reviveRec({ id: 1, segments: [] }, 'f'), null)
    const r = M.reviveRec({ id: 'a', segments: [{ text: 'hi', start: 'x' }, { nope: 1 }], status: 'live', notes: 'bad' }, 'dir')
    assert.equal(r.folder, 'dir'); assert.equal(r.segments.length, 1); assert.equal(r.segments[0].start, 0); assert.equal(r.segments[0].id, 1); assert.deepEqual(r.notes, []); assert.equal(r.status, 'live')
  })
  const rec = (segs, extra = {}) => ({ ...M.newRec({ id: 'r', folder: 'f', title: 'T', now: new Date(0), source: 'mic', target: 'zh' }), segments: segs, ...extra })
  test('转写落成 Markdown:时间在前,译文是引用块,没转写成的不写', () => {
    const md = M.transcriptMd(rec([{ id: 1, start: 5, end: 9, text: 'Hello.', tr: '你好。', mark: true }, { id: 2, start: 10, end: 12, text: '', fail: true }, { id: 3, start: 65, end: 70, text: 'Bye.' }]))
    assert.equal(md, '# T\n\n**[00:05]** Hello. ★\n\n> 你好。\n\n**[01:05]** Bye.\n')
  })
  test('长转写按字数分块,不从一句中间切', () => {
    const segs = Array.from({ length: 50 }, (_, i) => ({ id: i + 1, start: i, end: i + 1, text: 'x'.repeat(91) }))
    const chunks = M.chunkSegments(segs, 1000)
    assert.equal(chunks.flat().length, 50); assert.ok(chunks.length === 5 && chunks.every((c) => c.reduce((a, s) => a + s.text.length + 9, 0) <= 1000))
    assert.equal(M.chunkSegments([{ id: 1, start: 0, end: 1, text: 'y'.repeat(5000) }], 1000).length, 1)
  })
  test('模型回话:从代码块和废话里取出 JSON、取出标签', () => {
    assert.deepEqual(M.looseJson('Sure!\n```json\n{"a": "x}y", "b": {"c": 1}}\n```\nDone'), { a: 'x}y', b: { c: 1 } })
    assert.equal(M.looseJson('no json'), null); assert.equal(M.looseJson('{broken'), null)
    assert.equal(M.tagOf('<source>He said "hi"</source>\n<translation>他说「你好」</translation>', 'translation'), '他说「你好」')
    assert.equal(M.tagOf('nothing', 'translation'), '')
  })
  test('按上下文改错:小改动收,整句重写不收', () => {
    const raw = 'this is known as the rabbi frequency of the transition'
    assert.ok(M.acceptFix(raw, 'this is known as the Rabi frequency of the transition'))
    assert.ok(!M.acceptFix(raw, 'the transition has a frequency that people call Rabi')); assert.ok(!M.acceptFix(raw, raw)); assert.ok(!M.acceptFix(raw, ''))
    assert.deepEqual(M.changes(raw, 'this is known as the Rabi frequency of the transition'), [{ from: 'rabbi', to: 'Rabi' }])
    assert.deepEqual(M.changes('known as the rabbi frequency, which we write as capital Oh my god.', 'known as the Rabi frequency, which we write as capital omega.'), [{ from: 'rabbi', to: 'Rabi' }, { from: 'Oh my god', to: 'omega' }])
    assert.deepEqual(M.changes('今天我们讲旋转拨近似,它成立。', '今天我们讲旋转波近似，它成立。'), [{ from: '拨', to: '波' }])
    assert.deepEqual(M.changes('Okay, so.', 'okay so'), [])
    assert.ok(M.acceptFix('今天我们讲旋转拨近似', '今天我们讲旋转波近似'))
  })
  test('已经是目标语言的不翻', () => {
    assert.ok(M.alreadyIn('今天讲旋转波近似。', 'zh')); assert.ok(!M.alreadyIn('The rotating wave approximation.', 'zh')); assert.ok(M.alreadyIn('The rotating wave approximation.', 'en'))
    assert.ok(!M.alreadyIn('今日は量子力学です。', 'zh')); assert.ok(!M.alreadyIn('Hello', 'ja'))
  })
  test('没人说话时识别吐出来的东西当成空的', () => {
    for (const s of ['', '.', 'The.', '嗯。', ' uh ', 'A', 'Thank.', 'Thank you.']) assert.ok(M.isJunk(s), s)
    for (const s of ['Okay, so.', 'The atom.', '好的。']) assert.ok(!M.isJunk(s), s)
  })
  test('术语表:整词替换、不分大小写、不碰别的词', () => {
    assert.equal(M.applyTerms('The rabbi frequency, Rabbi oscillations and rabbis.', { rabbi: 'Rabi' }), 'The Rabi frequency, Rabi oscillations and rabbis.')
    assert.equal(M.applyTerms('旋转拨近似', { 旋转拨: '旋转波' }), '旋转波近似'); assert.equal(M.applyTerms('a+b', { 'a+b': 'c' }), 'c'); assert.equal(M.applyTerms('x', { '': 'y', x: 'x' }), 'x')
  })
  test('左栏分组:进行中 / 本周 / 更早', () => {
    const now = new Date(2026, 9, 15, 12) // 周四
    const row = (d, status = 'done') => ({ id: 'a', folder: 'f', title: 't', createdAt: d.toISOString(), duration: 0, status })
    assert.equal(M.groupOf(row(new Date(2026, 9, 12, 0, 1)), now), 'week'); assert.equal(M.groupOf(row(new Date(2026, 9, 11, 23, 59)), now), 'earlier'); assert.equal(M.groupOf(row(new Date(2020, 0, 1), 'paused'), now), 'live')
  })
  test('纪要:模型回的结构规整后落成 Markdown,多块合并', () => {
    const a = M.readSummary({ lead: 'L1', points: [{ t: '01:05', text: 'P1' }, { text: '' }, 'junk'], todos: [{ t: 30, text: 'T1' }], terms: [{ term: 'Rabi', meaning: 'm', t: '00:10' }, { term: 'x' }], chapters: [{ t: '02:00', title: 'B' }, { t: '00:00', title: 'A' }] })
    assert.deepEqual(a.points, [{ t: 65, text: 'P1' }]); assert.deepEqual(a.chapters.map((c) => c.title), ['A', 'B'])
    const m = M.mergeSummaries([a, M.readSummary({ lead: 'L2', terms: [{ term: 'rabi', meaning: 'dup', t: 0 }], chapters: [{ t: '01:00', title: 'C' }] })])
    assert.equal(m.lead, 'L1 L2'); assert.equal(m.terms.length, 1); assert.deepEqual(m.chapters.map((c) => c.title), ['A', 'C', 'B'])
    assert.equal(M.summaryMd(m, { points: '要点', todos: '待办', terms: '术语' }), 'L1 L2\n\n## 要点\n\n- P1 [01:05]\n\n## 待办\n\n- [ ] T1 [00:30]\n\n## 术语\n\n- **Rabi**:m [00:10]')
    assert.equal(M.summaryMd(M.readSummary(null), { points: 'a', todos: 'b', terms: 'c' }), '')
  })

  // 切句:用合成的声音(响的一段 = 说话,安静的一段 = 停顿)
  const RATE = 16000
  const sig = (parts) => { const out = new Float32Array(parts.reduce((a, [sec]) => a + Math.round(sec * RATE), 0)); let o = 0; for (const [sec, amp] of parts) { const len = Math.round(sec * RATE); for (let i = 0; i < len; i++) out[o + i] = amp ? amp * Math.sin((2 * Math.PI * 220 * i) / RATE) : (Math.random() - 0.5) * 0.001; o += len } return out }
  const run = (pcm, step = 4096) => { const s = new V.Slicer(); const us = []; for (let o = 0; o < pcm.length; o += step) us.push(...s.push(pcm.subarray(o, Math.min(pcm.length, o + step)))); const last = s.flush(); if (last) us.push(last); return { us, s } }
  test('切句:两句话中间停顿够长就切成两句,时间对得上', () => {
    const { us, s } = run(sig([[1, 0], [2, 0.2], [1.6, 0], [3, 0.2], [2, 0]]))
    assert.equal(us.length, 2)
    assert.ok(Math.abs(us[0].start - 0.8) < 0.15 && Math.abs(us[0].end - 3.16) < 0.15, JSON.stringify([us[0].start, us[0].end]))
    assert.ok(Math.abs(us[1].start - 4.4) < 0.15 && Math.abs(us[1].end - 7.76) < 0.15, JSON.stringify([us[1].start, us[1].end]))
    assert.ok(Math.abs(s.seconds - 9.6) < 0.05); assert.ok(us[0].rms > 0.1 && us[0].rms < 0.2)
  })
  test('切句:一句话里换气的短停顿不切', () => { assert.equal(run(sig([[0.5, 0], [1.5, 0.2], [0.5, 0], [1.5, 0.2], [2, 0]])).us.length, 1) })
  test('切句:说了一阵以后,短一点的停顿就切', () => { assert.equal(run(sig([[0.5, 0], [6, 0.2], [0.8, 0], [2, 0.2], [2, 0]])).us.length, 2) })
  test('切句:一下咔哒声、全程安静都不算说话', () => {
    assert.equal(run(sig([[1, 0], [0.04, 0.5], [3, 0], [0.2, 0.3], [3, 0]])).us.length, 0); assert.equal(run(sig([[20, 0]])).us.length, 0)
  })
  test('切句:刚够长的一个词(0.32 秒)留得住', () => {
    assert.equal(run(sig([[1, 0], [0.32, 0.3], [3, 0]])).us.length, 1)
  })
  test('切句:一直说不停,最长 18 秒硬切,采样一个不丢', () => {
    const { us } = run(sig([[0.5, 0], [50, 0.2], [2, 0]]))
    assert.ok(us.length >= 3 && us.every((u) => u.end - u.start <= 18.05), JSON.stringify(us.map((u) => u.end - u.start)))
    assert.ok(Math.abs(us.reduce((a, u) => a + (u.end - u.start), 0) - 50) < 0.6)
  })
  test('切句:喂的块大小不影响结果', () => {
    const pcm = sig([[1, 0], [2, 0.2], [1.6, 0], [3, 0.2], [2, 0]])
    const a = run(pcm, 4096).us.map((u) => [u.start, u.end]); const b = run(pcm, 317).us.map((u) => [u.start, u.end])
    assert.deepEqual(a, b)
  })
  test('切句:底噪大的房间(持续的嗡嗡声)里照样切得开', () => {
    const noisy = sig([[1, 0], [2, 0.2], [1.6, 0], [3, 0.2], [2, 0]]); for (let i = 0; i < noisy.length; i++) noisy[i] += (Math.random() - 0.5) * 0.02
    assert.equal(run(noisy).us.length, 2)
  })
  test('WAV:头写对了', () => {
    const b = V.wavBytes(new Float32Array([0, 1, -1, 0.5]), 16000); const dv = new DataView(b.buffer)
    assert.equal(b.length, 52); assert.equal(String.fromCharCode(...b.subarray(0, 4)), 'RIFF'); assert.equal(dv.getUint32(24, true), 16000); assert.equal(dv.getInt16(46, true), 32767); assert.equal(dv.getInt16(48, true), -32768)
    assert.equal(V.base64(new Uint8Array([104, 105])), 'aGk=')
  })

  // ── 落盘:用内存里的假库跑引擎里不碰麦克风的那几条路(代码评审里查出来会丢数据的地方)──
  {
    const files = new Map(); let gate = Promise.resolve(); const calls = []
    globalThis.window = globalThis
    const ls = new Map(); Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { getItem: (k) => ls.get(k) ?? null, setItem: (k, v) => { ls.set(k, String(v)) } } }) // 偏好存在 localStorage
    globalThis.ctx = {
      app: {
        readFile: async (p) => files.get(p) ?? null, writeFile: async (p, s) => { files.set(p, s) }, workFolder: () => '谛听', vaultRoot: () => '/v',
        trash: async (f) => { for (const k of [...files.keys()]) if (k.startsWith(`${f}/`)) files.delete(k) },
      },
      tangu: { complete: async (q) => { calls.push(['complete', q.selection]); await gate; return { text: '<source>今天讲拉比频率。</source><translation>T</translation>' } } },
      notify() {},
    }
    await build({ stdin: { contents: `export * as E from './src/engine'; export * as St from './src/store'; export { S, prefs, setPref } from './src/state'`, resolveDir: process.cwd(), loader: 'ts' }, bundle: true, format: 'esm', outfile: join(dir, 'owner.mjs'), logLevel: 'silent' })
    const { E, St, S, prefs, setPref } = await load('owner.mjs')
    assert.equal(prefs().target, '')
    n++; console.log('✓ 翻译默认关(没选过语言的人不会一装上就每句调用模型)')
    const seed = (id, extra = {}) => {
      const folder = `谛听/${id}`
      const rec = { ...M.newRec({ id, folder, title: id, now: new Date('2026-10-01T08:00:00Z'), source: 'mic', target: '' }), status: 'done', segments: [{ id: 1, start: 0, end: 2, text: '今天讲拉比频率。' }], ...extra }
      files.set(`${folder}/.record.json`, JSON.stringify(rec))
      return M.rowOf(rec)
    }
    const rows = [seed('a'), seed('b'), seed('c', { target: 'en', segments: [{ id: 1, start: 0, end: 2, text: '今天讲拉比频率。', tr: 'old', trState: 'done' }] }), seed('d', { status: 'live' }), seed('e', { segments: [{ id: 1, start: 0, end: 2, text: '今天讲拉比贫率。' }] })]
    files.set('谛听/.diting-index.json', JSON.stringify(rows))
    const settle = async () => { for (let i = 0; i < 5; i++) { await new Promise((r) => setTimeout(r, 5)); await St.queued(async () => undefined) } }
    const disk = (id) => JSON.parse(files.get(`谛听/${id}/.record.json`) || 'null')
    const pass = (name) => { n++; console.log(`✓ ${name}`) }

    await Promise.all([St.init(), St.init()]); await settle()
    assert.equal(S.index.length, 5); assert.equal(disk('d').status, 'done')
    pass('开场:读列表,上次没收尾的记录改成已结束')

    await Promise.all([E.apply({ c: 'note', rec: 'a', text: '第一条', t: 1 }), E.apply({ c: 'note', rec: 'a', text: '第二条', t: 2 })]); await settle()
    assert.deepEqual(disk('a').notes.map((x) => x.text), ['第一条', '第二条'])
    pass('同时到的两条修改都留得住(主窗口里一条记录只有一个对象)')

    await E.apply({ c: 'target', rec: 'c', target: 'ja' }); await settle()
    assert.equal(disk('c').segments[0].tr, 'T'); assert.equal(disk('c').trLang, 'ja')
    pass('换翻译语言:已有的译文重译,不留旧语言的')

    let open; gate = new Promise((r) => { open = r })
    await E.apply({ c: 'target', rec: 'b', target: 'en' })
    await E.apply({ c: 'delete', rec: 'b' }); open(); await settle()
    assert.equal(disk('b'), null); assert.ok(!S.index.some((r) => r.id === 'b')); assert.ok(!JSON.parse(files.get('谛听/.diting-index.json')).some((r) => r.id === 'b'))
    pass('删掉的记录:还在路上的翻译回来以后不会把它写回去')

    // 宿主有专门的翻译口子:默认走它(只翻译、不改原文);打开「顺带纠正」才回到聊天模型那条
    const seen = []
    globalThis.ctx.tangu.translate = async (q) => { seen.push(q); return { text: ' 今日はラビ周波数。 ' } }
    calls.length = 0
    await E.apply({ c: 'target', rec: 'e', target: 'ja' }); await settle()
    assert.deepEqual([seen.length, seen[0].text, seen[0].language, calls.length], [1, '今天讲拉比贫率。', 'Japanese', 0])
    assert.deepEqual([disk('e').segments[0].tr, disk('e').segments[0].text, disk('e').segments[0].raw], ['今日はラビ周波数。', '今天讲拉比贫率。', undefined])
    pass('宿主有翻译口子:逐句走它(用「翻译」模型槽),只取译文、不动原文')
    setPref('fix', true)
    await E.apply({ c: 'target', rec: 'e', target: 'en' }); await settle()
    assert.deepEqual([seen.length, calls.length, disk('e').segments[0].tr, disk('e').segments[0].text, disk('e').segments[0].raw], [1, 1, 'T', '今天讲拉比频率。', '今天讲拉比贫率。'])
    setPref('fix', false)
    pass('打开「翻译时顺带纠正听错的词」:回到聊天模型那条,原文被改正、留着改之前的')
  }

  test('发布物:main.js 就是当前源码打出来的,版本号对得上', async () => 0)
  const out = await build({ ...options, write: false, minify: true, logLevel: 'silent' })
  assert.equal(readFileSync('main.js', 'utf8'), out.outputFiles[0].text, 'main.js 和源码不一致:先跑 node build.mjs')
  const pkg = JSON.parse(readFileSync('package.json', 'utf8')); const man = JSON.parse(readFileSync('manifest.json', 'utf8')); const space = JSON.parse(readFileSync('spaces/diting/space.json', 'utf8'))
  assert.equal(man.version, pkg.version); assert.equal(space.version, pkg.version)
  assert.ok(new RegExp(`^version = "${pkg.version.replace(/\./g, '\\.')}"$`, 'm').test(readFileSync('agents/diting-companion/config.toml', 'utf8')))
  assert.ok(man.descriptionEn && man.nameEn && man.onboarding.en.steps.length === man.onboarding.steps.length)
  new Function('ctx', readFileSync('main.js', 'utf8'))
  console.log(`\n${n} 项全过`)
} finally { rmSync(dir, { recursive: true, force: true }) }
