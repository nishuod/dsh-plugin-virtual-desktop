import { z } from 'zod'
import { privacyOptionsSchema, redactText } from './privacy.ts'
import {visualOptionsSchema} from './visual-targets.ts'
import { NativeRuntime } from './native-runtime.ts'
import { WindowsBackgroundScroller } from './background-scroll.ts'
import { WindowsBackgroundInput } from './background-input.ts'
import { nativeRequestSchema, MAX_NATIVE_BYTES, cropSchema, restoreWindowSchema, windowFailure } from './native-contract.ts'
import { valueCheckSchema } from './task-contract.ts'
import { vmwareCommandScopeSchema } from './vmware-command.ts'

if (!process.send) throw new Error('Native worker requires an owned IPC channel')
const childSession = process.argv[2] === '--child-session'
let runtime: NativeRuntime | undefined
let lastHeartbeat=Date.now()
const limitsSchema=z.strictObject({frameAgeMs:z.int().min(1000).max(120000),maxDimension:z.int().min(320).max(1920),imageBytes:z.int().min(32000).max(512000),privacy:privacyOptionsSchema.optional(),visualCandidates:visualOptionsSchema.optional()})
const selectSchema = z.strictObject({ windowId: z.uuid(), foreground: z.boolean(), expectedEpoch: z.int().nonnegative().optional() })
const heartbeat=setInterval(()=>{ if (Date.now()-lastHeartbeat>15000) void end() },3000)
async function end() {
  clearInterval(heartbeat)
  const deadline=setTimeout(()=>process.exit(2),5000)
  try { await runtime?.pause(true) } finally { clearTimeout(deadline); if(process.connected) process.disconnect() }
}
process.on('disconnect',()=>{ void end() })
process.on('message',(raw:unknown)=>{
  void (async()=>{
    let id: string|undefined
    try {
      const json=JSON.stringify(raw)
      if (Buffer.byteLength(json)>MAX_NATIVE_BYTES) throw new Error('IPC 消息过大')
      const request=nativeRequestSchema.parse(raw); id=request.id;lastHeartbeat=Date.now()
      let value: unknown
      if(request.method==='enable') {
        runtime ??= new NativeRuntime(limitsSchema.parse(request.payload), undefined, undefined,
          childSession ? new WindowsBackgroundScroller() : undefined, childSession,
          childSession ? new WindowsBackgroundInput() : undefined)
        value=await runtime.enable()
      } else {
        if(!runtime) throw new Error(childSession ? '画中画执行器尚未授权' : '本机执行器尚未授权')
        switch(request.method) {
          case 'launch':
          case 'appCommand': throw new Error('应用命令只能通过已核实的子会话桥接发送')
          case 'appCommandScope':
            value = runtime.appCommandScope(vmwareCommandScopeSchema.parse(request.payload))
            break
          case 'windows': value=await runtime.listWindows();break
          case 'select': {
            const input = selectSchema.parse(request.payload)
            value = await runtime.select(input.windowId, input.foreground, input.expectedEpoch)
            break
          }
          case 'restore': {
            const input = restoreWindowSchema.parse(request.payload)
            value = await runtime.restore(input.windowId, input.pid, input.expectedEpoch)
            break
          }
          case 'capture': {
            const input = z.strictObject({
              source: z.enum(['window', 'desktop']),
              crop: cropSchema.optional(),
              check: valueCheckSchema.optional(),
              verifyVisual: z.literal(true).optional(),
            }).parse(request.payload)
            if (input.check && (input.source !== 'window' || input.crop)) throw new Error('验收须观察完整目标窗口')
            value = await runtime.capture(input.source, input.crop, input.check, input.verifyVisual)
            break
          }
          case 'execute': value=await runtime.execute(request.payload);break
          case 'pause': value=await runtime.pause();break
          case 'resume': value=await runtime.resume();break
          case 'stop': value=await runtime.pause(true);break
          case 'status': value=runtime.snapshot();break
          case 'shutdown': value=await runtime.pause(true);break
        }
      }
      process.send?.({version:1,id,ok:true,value},()=>{ if(request.method==='shutdown') void end() })
    } catch(error) {
      if(!id) { await end();return }
      process.send?.({version:1,id,ok:false,value:null,error:error instanceof Error?redactText(error.message).slice(0,1000):'执行器失败',...(windowFailure(error) ? {details:windowFailure(error)} : {})})
    }
  })()
})
