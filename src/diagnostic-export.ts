import { randomUUID, createHash } from 'node:crypto'
import { mkdir, appendFile, stat, rename, rm, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { homedir } from 'node:os'
import type { DesktopFrame } from './native-contract.ts'
import { pluginBuild } from './build-identity.ts'

// Store-only ZIP: no command interpreter, archive inputs, or caller-chosen paths.
export function diagnosticZip(entries: {name:string;data:Buffer}[]): Buffer {
  const files:Buffer[]=[]; const directory:Buffer[]=[]; let offset=0
  for (const entry of entries) {
    if (!/^[a-zA-Z0-9._/-]+$/.test(entry.name) || entry.name.includes('..')) throw new Error('Invalid ZIP entry')
    const name=Buffer.from(entry.name);let crc=0xffffffff
    for(const byte of entry.data){crc^=byte;for(let bit=0;bit<8;bit++)crc=(crc>>>1)^((crc&1)?0xedb88320:0)}
    crc=(crc^0xffffffff)>>>0
    const local=Buffer.alloc(30);local.writeUInt32LE(0x04034b50);local.writeUInt16LE(20,4)
    local.writeUInt32LE(crc,14);local.writeUInt32LE(entry.data.length,18);local.writeUInt32LE(entry.data.length,22);local.writeUInt16LE(name.length,26)
    const central=Buffer.alloc(46);central.writeUInt32LE(0x02014b50);central.writeUInt16LE(20,4);central.writeUInt16LE(20,6)
    central.writeUInt32LE(crc,16);central.writeUInt32LE(entry.data.length,20);central.writeUInt32LE(entry.data.length,24);central.writeUInt16LE(name.length,28);central.writeUInt32LE(offset,42)
    files.push(local,name,entry.data);directory.push(central,name);offset+=local.length+name.length+entry.data.length
  }
  const size=directory.reduce((sum,item)=>sum+item.length,0),end=Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50);end.writeUInt16LE(entries.length,8);end.writeUInt16LE(entries.length,10);end.writeUInt32LE(size,12);end.writeUInt32LE(offset,16)
  return Buffer.concat([...files,...directory,end])
}

/** A bounded owner-local journal. Scrubbing is injected at every output boundary. */
export class DiagnosticJournal {
  private readonly id=randomUUID()
  private queue:Promise<void>=Promise.resolve()
  private frames:DesktopFrame[]=[]
  private failures=0
  private readonly header:string
  constructor(private readonly scrub:(value:unknown)=>unknown,
    private readonly root=join(process.env.LOCALAPPDATA??join(homedir(),'AppData','Local'),'dsh-virtual-desktop')) {
    this.header = pluginBuild
      ? JSON.stringify(this.scrub({at:new Date().toISOString(),event:'plugin-build',plugin:pluginBuild}))+'\n'
      : ''
    if (this.header) this.enqueue('')
  }
  record(event:string,value:unknown):void {
    const payload=this.scrub({at:new Date().toISOString(),event,value})
    const serialized=JSON.stringify(payload)
    const line=(serialized.length<=32000?serialized:JSON.stringify({at:new Date().toISOString(),event,truncated:true,summary:serialized.slice(0,30000)}))+'\n'
    this.enqueue(line)
  }
  private enqueue(line:string):void {
    this.queue=this.queue.then(async()=>{
      const directory=join(this.root,'logs');await mkdir(directory,{recursive:true})
      const file=join(directory,`${this.id}.jsonl`)
      const current=await stat(file).catch((error:NodeJS.ErrnoException)=>{
        if(error.code==='ENOENT')return null
        throw error
      })
      let size=current?.size??0
      if(size>1_000_000){
        await rm(`${file}.2`,{force:true});await rename(`${file}.1`,`${file}.2`).catch(()=>{});await rename(file,`${file}.1`)
        size=0
      }
      await appendFile(file,(size===0?this.header:'')+line,'utf8')
    }).catch(()=>{this.failures++})
  }
  frame(frame:DesktopFrame):void {
    // Old callers without a privacy receipt cannot contribute pixels to an archive.
    if(!frame.privacy)return
    this.frames.push({...frame,filePath:undefined});if(this.frames.length>5)this.frames.shift()
  }
  clearFrames():void {this.frames=[]}
  async export(snapshot:unknown,recentFrames:number):Promise<{filePath:string;sha256:string;frames:number;logWriteFailures:number}> {
    if(!Number.isInteger(recentFrames)||recentFrames<0||recentFrames>5)throw new Error('recentFrames must be 0..5')
    await this.queue
    const chosen=recentFrames?this.frames.slice(-recentFrames):[]
    const entries=[{name:'diagnostics.json',data:Buffer.from(JSON.stringify(this.scrub({snapshot,logWriteFailures:this.failures}),null,2))}]
    for(const suffix of ['', '.1','.2']){
      const log=await readFile(join(this.root,'logs',`${this.id}.jsonl${suffix}`)).catch(()=>null)
      if(log)entries.push({name:`logs/runtime${suffix}.jsonl`,data:log})
    }
    for(const [index,frame] of chosen.entries()){
      const {data,filePath,...metadata}=frame
      entries.push({name:`frames/${index}.jpg`,data:Buffer.from(data,'base64')},{name:`frames/${index}.json`,data:Buffer.from(JSON.stringify(this.scrub(metadata)))})
    }
    const bytes=diagnosticZip(entries),directory=join(this.root,'exports');await mkdir(directory,{recursive:true})
    const filePath=join(directory,`diagnostics-${randomUUID()}.zip`);await writeFile(filePath,bytes,{flag:'wx'})
    return {filePath,sha256:createHash('sha256').update(bytes).digest('hex'),frames:chosen.length,logWriteFailures:this.failures}
  }
}
