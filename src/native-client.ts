import { spawn, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { MAX_NATIVE_BYTES,nativeReplySchema } from './native-contract.ts'
import { assertSupportedPlatform } from './platform.ts'
export class NativeTransportError extends Error {}

/** Private bounded RPC to our fixed native worker, with no model-controlled executable. */
export class NativeClient {
  private child:ChildProcess|undefined
  private pending=new Map<string,{resolve:(value:unknown)=>void;reject:(error:Error)=>void;cleanup:()=>void}>()
  private closing:Promise<void>|undefined
  private heartbeat:ReturnType<typeof setInterval>|undefined
  constructor(private readonly timeoutMs:number, private readonly childSession = false) {}
  get pid(): number | undefined { return this.child?.pid }
  async call(method:string,payload:unknown,signal:AbortSignal):Promise<unknown> {
    signal.throwIfAborted()
    if(this.closing) throw new NativeTransportError('本机执行器已关闭；需要重新授权')
    if(!this.child) this.start()
    const value=await this.send(method,payload,signal)
    signal.throwIfAborted()
    return value
  }
  private start() {
    assertSupportedPlatform()
    this.child=spawn(process.execPath,[fileURLToPath(new URL('./native-worker.js',import.meta.url)), ...(this.childSession ? ['--child-session'] : [])],{
      windowsHide:true,stdio:['ignore','ignore','ignore','ipc'],
      env:{...Object.fromEntries(['SystemRoot','WINDIR','TEMP','TMP','USERPROFILE','LOCALAPPDATA','APPDATA'].flatMap(key=>process.env[key]===undefined?[]:[[key,process.env[key]]])),...(process.versions.electron?{ELECTRON_RUN_AS_NODE:'1'}:{})},
    })
    const child=this.child
    child.on('message',(raw:unknown)=>{
      try {
        if(Buffer.byteLength(JSON.stringify(raw))>MAX_NATIVE_BYTES) throw new Error('执行器响应超过限制')
        const reply=nativeReplySchema.parse(raw);const pending=this.pending.get(reply.id)
        if(!pending) throw new Error('未知或重复的执行器响应')
        this.pending.delete(reply.id);pending.cleanup()
        if(reply.ok) pending.resolve(reply.value)
        else pending.reject(Object.assign(new Error(reply.error??'执行器拒绝'), reply.details))
      } catch { void this.close() }
    })
    child.on('error',()=>{void this.close()})
    child.on('close',()=>{
      if(this.heartbeat)clearInterval(this.heartbeat)
      for(const pending of this.pending.values()){pending.cleanup();pending.reject(new NativeTransportError('执行器退出；未确认的输入结果未知'))}
      this.pending.clear()
    })
    this.heartbeat=setInterval(()=>{
      if(this.pending.size===0 && !this.closing) void this.send('status',null,new AbortController().signal).catch(()=>{})
    },3000)
  }
  private async send(method:string,payload:unknown,signal:AbortSignal):Promise<unknown> {
    const child=this.child
    if(!child?.connected) throw new NativeTransportError('执行器未连接')
    const id=randomUUID()
    return await new Promise((resolve,reject)=>{
      const cancel=()=>{void this.close().then(()=>reject(new NativeTransportError('调用已取消或超时；输入未回滚，未确认的结果未知')))}
      const timer=setTimeout(cancel,this.timeoutMs)
      const cleanup=()=>{clearTimeout(timer);signal.removeEventListener('abort',cancel)}
      this.pending.set(id,{resolve,reject,cleanup});signal.addEventListener('abort',cancel,{once:true})
      if(signal.aborted){cancel();return}
      const message={version:1,id,method,payload}
      if(Buffer.byteLength(JSON.stringify(message))>MAX_NATIVE_BYTES){this.pending.delete(id);cleanup();reject(new Error('请求过大'));return}
      child.send(message,error=>{if(error)void this.close()})
    })
  }
  close():Promise<void> {
    if(this.closing)return this.closing
    if(this.heartbeat)clearInterval(this.heartbeat)
    const child=this.child
    this.closing=(async()=>{
      if(!child || child.exitCode!==null || child.signalCode!==null)return
      const exited=new Promise<void>(resolve=>child.once('close',()=>resolve()))
      if(child.connected) {
        const id=randomUUID()
        child.send({version:1,id,method:'shutdown',payload:null},()=>{})
        // A shutdown reply is known but not exposed as a user request.
        this.pending.set(id,{resolve:()=>{},reject:()=>{},cleanup:()=>{}})
      }
      const kill=setTimeout(()=>child.kill(),5000)
      await exited;clearTimeout(kill)
    })()
    return this.closing
  }
}
