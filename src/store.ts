// 落盘:每次记录一个文件夹(都在用户的笔记库里),外加一份列表索引。只有主窗口写,别的窗口只读。
//   <工作文件夹>/<日期 时间 标题>/.record.json   全部数据(以它为准)
//                              /转写.md  笔记.md  纪要.md   给人看、给 Tangu 读
//                              /录音.webm
//   <工作文件夹>/.diting-index.json                左栏列表

import { FILES, notesMd, reviveRec, rowOf, transcriptMd, type IndexRow, type Rec } from './model'
import { emit, OWNER, S, sleep } from './state'
import { t } from './i18n'

export const root = (): string => (ctx.app.workFolder?.() || '谛听').replace(/^\/+|\/+$/g, '')

/** 库是惰性恢复的:视图刚挂上那一下 vaultRoot() 可能还是 null。等它有值;一直没有 = 用户没开库。 */
export async function vaultReady(ms = 8000): Promise<boolean> {
  if (!ctx.app.vaultRoot) return true
  const end = Date.now() + ms
  while (!ctx.app.vaultRoot()) { if (Date.now() > end) return false; await sleep(200) }
  return true
}

// 写盘排队:同一个文件不会有两次写交错。
let chain: Promise<unknown> = Promise.resolve()
export function queued<T>(fn: () => Promise<T>): Promise<T> {
  const p = chain.then(fn, fn)
  chain = p.catch(() => undefined)
  return p
}

const hadNotes = new Set<string>()
/** 删掉的记录:还在路上的翻译 / 纪要回来以后不许再存,否则文件夹和列表里那一行会被重新写出来。 */
const gone = new Set<string>()

export function saveRec(rec: Rec): Promise<void> {
  return queued(async () => {
    await upgradeStorage()
    if(S.storageError)throw Error(S.storageError)
    if (gone.has(rec.id)) return
    const f = rec.folder
    await ctx.app.writeFile(`${f}/${FILES.record}`, JSON.stringify(rec))
    await ctx.app.writeFile(`${f}/${FILES.transcript}`, transcriptMd(rec))
    if (rec.notes.length || hadNotes.has(f)) { hadNotes.add(f); await ctx.app.writeFile(`${f}/${FILES.notes}`, notesMd(rec)) }
    if (rec.summary) await ctx.app.writeFile(`${f}/${FILES.summary}`, `# ${rec.title}\n\n${rec.summary}\n`)
    await writeIndex([rowOf(rec), ...S.index.filter((r) => r.id !== rec.id)])
  })
}

// 主窗口里一条记录只有一个对象:同一条记录读出两份、各改各的再各存各的,后存的会把先存的盖掉(丢笔记、丢纪要)。
// 别的窗口不写库,每次都读盘上最新的。
// ponytail: 不淘汰(一条两小时的记录约 300 KB)。别的设备同步过来改了同一条时这里看不到,要等重开应用。
const cache = new Map<string, Promise<Rec | null>>()
export const remember = (rec: Rec): void => { cache.set(rec.folder, Promise.resolve(rec)) }
export const drop = (row: IndexRow): void => { cache.delete(row.folder); gone.add(row.id) }

export function loadRec(folder: string): Promise<Rec | null> {
  if (!OWNER) return readRec(folder)
  let p = cache.get(folder)
  if (!p) { p = readRec(folder); cache.set(folder, p); void p.then((r) => { if (!r && cache.get(folder) === p) cache.delete(folder) }, () => cache.delete(folder)) }
  return p
}

async function readRec(folder: string): Promise<Rec | null> {
  const raw = await ctx.app.readFile(`${folder}/${FILES.record}`)
  if (!raw) return null
  try {
    const rec = reviveRec(JSON.parse(raw), folder)
    // The owner only reads uncached records: no job can still own a persisted waiting state after restart.
    // Secondary windows keep waiting states because the main window may still be processing them.
    if (OWNER && rec) for (const seg of rec.segments) if (seg.trState === 'wait') seg.trState = 'fail'
    if (rec?.notes.length) hadNotes.add(folder)
    return rec
  } catch { return null }
}

async function writeIndex(rows: IndexRow[]): Promise<void> {
  S.index = rows.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
  await ctx.app.writeFile(`${root()}/${FILES.index}`, JSON.stringify(S.index))
  S.saved++
  emit()
}

const LEGACY = ['谛听','Diting']
async function readIndexAt(folder:string):Promise<IndexRow[]> {
  try {
    const raw=await ctx.app.readFile(`${folder}/${FILES.index}`)
    if(raw===null)return []
    const value=JSON.parse(raw)
    if(!Array.isArray(value)||value.some(row=>!row||typeof row.id!=='string'||typeof row.folder!=='string'||typeof row.title!=='string'))throw Error('invalid index')
    return value
  }catch{throw Error(t('storageUnreadable',{folder}))}
}
const upgrades=new Map<string,Promise<void>>(),migrated=new Set<string>()
export function upgradeStorage():Promise<void>{
  const vault=ctx.app.vaultRoot?.(),target=root(),scope=`${vault}\n${target}`
  if(!OWNER||!vault||String(vault).includes('://')||!ctx.app.migrateWorkFolder||localStorage.getItem('plugin.diting.workFolder')||!target.startsWith('Plugins/'))return Promise.resolve()
  if(upgrades.has(scope))return upgrades.get(scope)!
  const task=(async()=>{
    const check=()=>{if(ctx.app.vaultRoot?.()!==vault||root()!==target||!['idle','starting'].includes(S.phase)||S.live||S.summarizing||S.retrying)throw Error(t('recoveryChanged'))}
    check()
    const id='legacy-root-v1'
    if((await ctx.app.migrateWorkFolder!({id,expectedRoot:vault,source:LEGACY[0],target})).status==='complete'){migrated.add(scope);return}
    check()
    const before=await ctx.app.readFile(`${target}/${FILES.index}`);check()
    if((await readIndexAt(target)).length)return // Keep the current collection available; recovery compares both.
    const found:Array<{source:string;rows:IndexRow[]}>=[]
    for(const source of LEGACY){const rows=await readIndexAt(source);check();if(rows.length)found.push({source,rows})}
    if(!found.length)return
    if(found.length!==1)throw Error(t('migrationConflict'))
    const {source,rows}=found[0]
    const edits:Array<{path:string;before:string;after:string}>=[],next:IndexRow[]=[],requiredFiles:string[]=[]
    for(const row of rows){
      if(!row.folder.startsWith(source+'/')||row.folder.split('/').some(x=>!x||x==='.'||x==='..')||row.folder.includes('\\'))throw Error(t('recoveryInvalid',{folder:row.folder}))
      const relative=row.folder.slice(source.length+1),path=`${relative}/${FILES.record}`
      const raw=await ctx.app.readFile(`${source}/${path}`);check()
      const data=raw?JSON.parse(raw):null,rec=data?reviveRec(data,row.folder):null
      if(!rec||rec.id!==row.id||data.folder!==row.folder)throw Error(t('recoveryInvalid',{folder:row.folder}))
      if(rec.audio){if(/[\\/]/.test(rec.audio)||rec.audio==='.'||rec.audio==='..')throw Error(t('recoveryInvalid',{folder:row.folder}));requiredFiles.push(`${relative}/${rec.audio}`)}
      const folder=target+'/'+relative
      edits.push({path,before:raw!,after:JSON.stringify({...data,folder})});next.push({...row,folder})
    }
    const raw=await ctx.app.readFile(`${source}/${FILES.index}`);check()
    if(JSON.stringify(JSON.parse(raw||'null'))!==JSON.stringify(rows))throw Error(t('recoveryChanged'))
    const after=JSON.stringify(next),path=FILES.index
    edits.push({path,before:raw!,after})
    await ctx.app.migrateWorkFolder!({id,expectedRoot:vault,source,target,plan:{index:{path,before,after},edits,requiredFiles}});check()
    migrated.add(scope);cache.clear();hadNotes.clear();ctx.notify?.(t('migrationDone'),{level:'success'})
  })()
  const attempt=task.catch(error=>{upgrades.delete(scope);throw error})
  upgrades.set(scope,attempt);return attempt
}
export async function loadIndex(): Promise<void> {
  const folder=root(),vault=ctx.app.vaultRoot?.()
  let rows:IndexRow[]=[],error=''
  try{await upgradeStorage();rows=await readIndexAt(folder)}catch(e){error=t('migrationFailed',{message:String((e as Error).message)});try{rows=await readIndexAt(folder)}catch{}}
  const recovery:typeof S.recovery=[]
  for(const old of LEGACY){
    if(old===folder||migrated.has(`${vault}\n${folder}`))continue
    try{const previous=await readIndexAt(old);if(previous.length)recovery.push({folder:old,count:previous.length})}
    catch(e){recovery.push({folder:old,count:0,error:String((e as Error).message)})}
  }
  if(root()!==folder||ctx.app.vaultRoot?.()!==vault)return
  S.index=rows;S.storageError=error;S.recovery=recovery;S.recoveryVault=vault;S.recoveryFolder=folder;emit()
}
/** Confirmation changes only the standard work-folder setting. Original record paths stay valid. */
export function reconnectLegacy(folder:string,expectedVault:string|null|undefined,expectedFolder:string):Promise<void>{
  return queued(async()=>{
    if(!OWNER||S.phase!=='idle'||S.summarizing||S.retrying)throw Error(t('recoveryBusy'))
    if(!LEGACY.includes(folder))throw Error(t('recoveryChanged'))
    const check=()=>{
      if(S.phase!=='idle'||S.summarizing||S.retrying)throw Error(t('recoveryBusy'))
      if(ctx.app.vaultRoot?.()!==expectedVault||root()!==expectedFolder)throw Error(t('recoveryChanged'))
    }
    check()
    await readIndexAt(expectedFolder);check()
    const rows=await readIndexAt(folder);check()
    if(!rows.length)throw Error(t('recoveryChanged'))
    for(const row of rows){
      if(!row.folder.startsWith(folder+'/')||row.folder.split('/').some(part=>part==='..'))throw Error(t('recoveryInvalid',{folder:row.folder}))
      const raw=await ctx.app.readFile(`${row.folder}/${FILES.record}`);check()
      let rec:Rec|null=null
      try{rec=raw ? reviveRec(JSON.parse(raw),row.folder):null}catch{}
      if(!rec||rec.id!==row.id)throw Error(t('recoveryInvalid',{folder:row.folder}))
    }
    check();localStorage.setItem('plugin.diting.workFolder',folder)
    cache.clear();hadNotes.clear();S.open=null;ready=null;S.saved++
    await loadIndex();ctx.notify?.(t('recoveryDone'),{level:'success'})
  })
}

export const removeRow = (id: string): Promise<void> => queued(() => writeIndex(S.index.filter((r) => r.id !== id)))

/** 上次没正常结束的记录(退出应用、崩溃):状态改成已结束,已经记下的内容原样留着。只在主窗口启动时跑一次。 */
export async function heal(): Promise<void> {
  for (const row of S.index.filter((r) => r.status !== 'done' && r.id !== S.live?.id)) {
    const rec = await loadRec(row.folder)
    if (!rec) { await removeRow(row.id); continue }
    rec.status = 'done'
    if (!rec.duration && rec.segments.length) rec.duration = rec.segments[rec.segments.length - 1].end
    await saveRec(rec)
    S.healed = rec.id
  }
}

let ready: Promise<void> | null = null,readyScope=''
/** 主窗口的开场:读列表、把上次没收尾的收尾。新建记录之前必须等它:没读过列表就写,会拿空列表把盘上的盖掉。 */
export function init(): Promise<void> {
  const scope=`${ctx.app.vaultRoot?.()}\n${root()}`
  if(scope!==readyScope){readyScope=scope;ready=null}
  return (ready ??= (async () => {
    try {
      // 库还没开:这次不算,下次再来。
      if (!(await vaultReady())) { ready = null; return }
      await loadIndex(); if(S.storageError)throw Error(S.storageError);await heal()
    } catch (e) { ready = null; throw e }
  })())
}
