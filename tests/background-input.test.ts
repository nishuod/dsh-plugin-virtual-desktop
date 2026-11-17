import assert from 'node:assert/strict'
import {test} from 'node:test'
import {WindowsBackgroundInput, BackgroundInputRefused, type BackgroundInputPort} from '../src/background-input.ts'
import {childKey} from '../src/child-key.ts'

const root=0x100n, child=0x200n, pid=0xffffffe0
function fixture(){
  let targetSession=2, focus=child, result:'delivered'|'access-denied'|'unknown'='delivered', control=false
  const windows=new Map<bigint,NonNullable<ReturnType<BackgroundInputPort['window']>>>([
    [root,{pid,thread:22,root,bounds:[-100,0,500,400]}],
    [child,{pid,thread:22,root,bounds:[-50,50,300,300]}],
  ])
  const calls:Parameters<BackgroundInputPort['send']>[]=[]
  let scopes=0
  const port:BackgroundInputPort={
    withPerMonitorV2:op=>op(), sessionOf:other=>other===pid?targetSession:2,
    window:hwnd=>windows.get(hwnd), focus:()=>focus,
    clientPoint(hwnd,p){const b=windows.get(hwnd)?.bounds;return b?{x:p.x-b[0],y:p.y-b[1],width:b[2]-b[0],height:b[3]-b[1]}:undefined},
    childAt:hwnd=>hwnd===root?child:hwnd, hitTest:()=>1, scanCode:()=>30,
    withControlState(_thread,op){scopes++;control=true;try{return op()}finally{control=false}},
    send(...args){calls.push(args);if(args[2]===65n)assert.equal(control,true);return result},
  }
  const input=new WindowsBackgroundInput(port)
  return{input,port,calls,windows,setFocus:(v:bigint)=>focus=v,setSession:(v:number)=>targetSession=v,setResult:(v:typeof result)=>result=v,control:()=>control,scopes:()=>scopes}
}

test('background keys send explicit down/up to the owned focus HWND; Ctrl state is scoped and restored',()=>{
  const f=fixture()
  f.input.key(root.toString(),pid,'enter',[])
  assert.deepEqual(f.calls.map(([hwnd,msg,key,flags])=>[hwnd,msg,key,flags]),[
    [child,0x100,13n,1n|(30n<<16n)],[child,0x101,13n,1n|(30n<<16n)|0xc0000000n],
  ])
  f.calls.length=0
  f.input.key(root.toString(),pid,'a',['ctrl'])
  assert.deepEqual(f.calls.map(([,message,key])=>[message,key]),[[0x100,17n],[0x100,65n],[0x101,65n],[0x101,17n]])
  assert.equal(f.scopes(),1)
  assert.equal(f.control(),false)
  f.input.key(root.toString(),pid,'esc',[])
  assert.equal(f.calls.at(-1)?.[2],27n)
})

test('all and only the documented unmodified keys and Ctrl letters enter the child whitelist',()=>{
  for(const key of ['enter','return','esc','escape','tab','backspace','left','right','up','down','space','home','end','pageup','pagedown','f5']) assert.ok(childKey(key,[]),key)
  for(const key of ['a','Z'])assert.ok(childKey(key,['ctrl']))
  for(const [key,modifiers]of [['f4',['alt']],['tab',['alt']],['escape',['ctrl']],['f5',['ctrl']],['a',[]],['a',['ctrl','ctrl']],['a',['ctrl','shift']]]as const)assert.equal(childKey(key,modifiers),undefined)
})
test('standard EDIT text keys include character translation and Ctrl+A uses only fixed select-all',()=>{
  const f=fixture();f.port.standardEdit=hwnd=>hwnd===child
  for(const [key,value] of [['enter',13n],['backspace',8n],['space',32n]] as const){
    f.calls.length=0;f.input.key(String(root),pid,key,[])
    assert.deepEqual(f.calls.map(([hwnd,message,vk])=>[hwnd,message,vk]),[[child,0x100,value],[child,0x102,value],[child,0x101,value]])
  }
  f.calls.length=0;f.input.key(String(root),pid,'a',['ctrl'])
  assert.deepEqual(f.calls.at(-1),[child,0xb1,0n,-1n,750]);assert.equal(f.calls.length,5)
  assert.equal(f.control(),false)
})
test('edit character completion stops on changed focus and does not replay an uncertain send',()=>{
  const f=fixture();f.port.standardEdit=()=>true
  const send=f.port.send;f.port.send=(...args)=>{const result=send(...args);f.setFocus(root);return result}
  assert.throws(()=>f.input.key(String(root),pid,'enter',[]),/焦点/)
  assert.equal(f.calls.length,1)
  const other=fixture();other.port.standardEdit=()=>true;other.setResult('unknown')
  assert.throws(()=>other.input.key(String(root),pid,'backspace',[]),/结果未知/)
  assert.equal(other.calls.length,1)
})
test('focused standard EDIT selection is replaced once without reclicking; non-edit or other target never dispatches',()=>{
  const f=fixture();f.port.standardEdit=()=>true;const texts:unknown[]=[]
  f.port.replaceSelection=(hwnd,text)=>{texts.push([hwnd,text]);return 'delivered'}
  assert.equal(f.input.replaceText(String(root),pid,{x:0,y:80},'Replacement'),true)
  assert.deepEqual(texts,[[child,'Replacement']]);assert.equal(f.calls.length,0)
  assert.equal(f.input.replaceText(String(root),pid,{x:400,y:80},'Other control'),false)
  f.port.standardEdit=()=>false;assert.equal(f.input.replaceText(String(root),pid,{x:0,y:80},'Not EDIT'),false)
  assert.equal(texts.length,1)
  f.port.standardEdit=()=>true;f.port.replaceSelection=()=>{texts.push('uncertain');return 'unknown'}
  assert.throws(()=>f.input.replaceText(String(root),pid,{x:0,y:80},'Unknown'),/结果未知/);assert.equal(texts.length,2)
  assert.throws(()=>f.input.replaceText(String(root),pid,{x:0,y:80},'bad\0text'),BackgroundInputRefused)
})

test('focused text replacement never dispatches to a foreign PID, root, thread or session',()=>{
  for(const [mutate,refused] of [
    [(f:ReturnType<typeof fixture>)=>f.windows.set(child,{...f.windows.get(child)!,pid:42}),false],
    [(f:ReturnType<typeof fixture>)=>f.windows.set(child,{...f.windows.get(child)!,root:999n}),false],
    [(f:ReturnType<typeof fixture>)=>f.windows.set(child,{...f.windows.get(child)!,thread:99}),false],
    [(f:ReturnType<typeof fixture>)=>f.setSession(3),true],
  ] as const){
    const f=fixture();let replacements=0
    f.port.standardEdit=()=>true;f.port.replaceSelection=()=>{replacements++;return 'delivered'}
    mutate(f)
    const replace=()=>f.input.replaceText(String(root),pid,{x:0,y:80},'Replacement')
    if(refused)assert.throws(replace,BackgroundInputRefused)
    else assert.equal(replace(),false)
    assert.equal(replacements,0);assert.deepEqual(f.calls,[])
  }
})

test('focused text replacement refuses geometry or focus changes before dispatch',()=>{
  for(const mutate of [
    (f:ReturnType<typeof fixture>)=>{const read=f.port.window;let reads=0;f.port.window=hwnd=>{if(hwnd===root&&++reads===2)f.windows.set(root,{...f.windows.get(root)!,bounds:[-90,0,510,400]});return read(hwnd)}},
    (f:ReturnType<typeof fixture>)=>{const read=f.port.window;let reads=0;f.port.window=hwnd=>{if(hwnd===child&&++reads===2)f.windows.set(child,{...f.windows.get(child)!,bounds:[-40,50,310,300]});return read(hwnd)}},
    (f:ReturnType<typeof fixture>)=>{let reads=0;f.port.focus=()=>++reads===1?child:root},
  ]){
    const f=fixture();let replacements=0
    f.port.standardEdit=()=>true;f.port.replaceSelection=()=>{replacements++;return 'delivered'}
    mutate(f)
    assert.throws(()=>f.input.replaceText(String(root),pid,{x:0,y:80},'Replacement'),BackgroundInputRefused)
    assert.equal(replacements,0);assert.deepEqual(f.calls,[])
  }
})

test('focused text replacement rejects nonfinite points before target lookup or dispatch',()=>{
  for(const point of [{x:NaN,y:80},{x:0,y:NaN},{x:Infinity,y:80},{x:-Infinity,y:80},{x:0,y:Infinity},{x:0,y:-Infinity}]){
    const f=fixture();let replacements=0,lookups=0
    f.port.standardEdit=()=>true;f.port.replaceSelection=()=>{replacements++;return 'delivered'}
    const read=f.port.window;f.port.window=hwnd=>{lookups++;return read(hwnd)}
    assert.throws(()=>f.input.replaceText(String(root),pid,point,'Replacement'),BackgroundInputRefused)
    assert.equal(lookups,0);assert.equal(replacements,0);assert.deepEqual(f.calls,[])
  }
})

test('background keys fail closed for a foreign PID/root/thread/session or changing focus',()=>{
  for(const mutate of [
    (f:ReturnType<typeof fixture>)=>f.windows.set(child,{...f.windows.get(child)!,pid:42}),
    (f:ReturnType<typeof fixture>)=>f.windows.set(child,{...f.windows.get(child)!,root:999n}),
    (f:ReturnType<typeof fixture>)=>f.windows.set(child,{...f.windows.get(child)!,thread:99}),
    (f:ReturnType<typeof fixture>)=>f.setSession(3),
    (f:ReturnType<typeof fixture>)=>f.setFocus(0n),
    (f:ReturnType<typeof fixture>)=>{let reads=0;f.port.focus=()=>++reads===1?child:root},
  ]){
    const f=fixture();mutate(f)
    assert.throws(()=>f.input.key(root.toString(),pid,'enter',[]),BackgroundInputRefused)
    assert.deepEqual(f.calls,[])
  }
})

test('double click targets the deepest owned client HWND and uses the Win32 double-click sequence',()=>{
  const f=fixture()
  f.input.doubleClick(root.toString(),pid,0,80)
  assert.deepEqual(f.calls.map(([hwnd,msg,wParam,lParam])=>[hwnd,msg,wParam,lParam]),[
    [child,0x201,1n,(30n<<16n)|50n],[child,0x202,0n,(30n<<16n)|50n],
    [child,0x203,1n,(30n<<16n)|50n],[child,0x202,0n,(30n<<16n)|50n],
  ])
  assert.ok(f.calls.every((args)=>args[4]===750))
})

test('caption minimization dispatches only for a verified HTMINBUTTON in the owned child window', () => {
  const f = fixture()
  const point = { x: 300, y: 18 }
  let dispatches = 0
  const mark = () => { dispatches++ }
  assert.equal(f.input.tryMinimizeCaption(String(root), pid, point, mark), false)
  f.port.hitTest = () => 8
  assert.equal(f.input.tryMinimizeCaption(String(root), pid, { x: 600, y: 18 }, mark), false)
  assert.equal(dispatches, 0)
  assert.equal(f.input.tryMinimizeCaption(String(root), pid, point, mark), true)
  assert.deepEqual(f.calls, [[root, 0x112, 0xf020n, (18n << 16n) | 300n, 750]])
  assert.equal(dispatches, 1)
  f.calls.length = 0
  f.port.hitTest = () => { f.setSession(3); return 8 }
  assert.throws(() => f.input.tryMinimizeCaption(String(root), pid, point, mark), BackgroundInputRefused)
  assert.deepEqual(f.calls, [])
  assert.equal(dispatches, 1)
})

test('caption hit evidence reads and reports physical window bounds inside the DPI scope', () => {
  const f = fixture()
  let dpiScope = false, reads = 0
  f.port.withPerMonitorV2 = work => { dpiScope = true; try { return work() } finally { dpiScope = false } }
  const window = f.port.window
  f.port.window = hwnd => {
    assert.equal(dpiScope, true, 'GetWindowRect must use the same physical pixel context as WM_NCHITTEST')
    reads++
    return window(hwnd)
  }
  f.port.hitTest = (_hwnd, point) => { assert.equal(dpiScope, true); assert.deepEqual(point, { x: 300, y: 18 }); return 8 }
  const evidence: unknown[] = []
  assert.equal(f.input.tryMinimizeCaption(String(root), pid, { x: 300, y: 18 }, () => {
    assert.equal(dpiScope, true)
  }, hit => evidence.push(hit)), true)
  assert.deepEqual(evidence, [{
    point: { x: 400, y: 18 }, screenPoint: { x: 300, y: 18 }, windowOrigin: { x: -100, y: 0 },
    windowRelative: true, class: 'HTMINBUTTON', code: 8,
  }])
  assert.equal(reads, 2)
  assert.equal(dpiScope, false)
  assert.equal(f.calls.length, 1)
})

test('double click refuses outside-client hits, foreign controls and unstable geometry before dispatch',()=>{
  for(const mutate of [
    (f:ReturnType<typeof fixture>)=>f.windows.set(child,{...f.windows.get(child)!,pid:42}),
    (f:ReturnType<typeof fixture>)=>{const read=f.port.window;let reads=0;f.port.window=hwnd=>{if(hwnd===child&&++reads===2)f.windows.set(child,{...f.windows.get(child)!,bounds:[-40,50,300,300]});return read(hwnd)}},
  ]){
    const f=fixture();mutate(f)
    assert.throws(()=>f.input.doubleClick(root.toString(),pid,0,80),BackgroundInputRefused)
    assert.deepEqual(f.calls,[])
  }
  const f=fixture()
  assert.throws(()=>f.input.doubleClick(root.toString(),pid,-200,80),BackgroundInputRefused)
  assert.throws(()=>f.input.doubleClick(root.toString(),pid,32768,80),BackgroundInputRefused)
  assert.deepEqual(f.calls,[])
})

test('unknown sends stop the sequence and restore scoped Ctrl state; access refusal remains distinct',()=>{
  const f=fixture();f.setResult('unknown')
  assert.throws(()=>f.input.key(root.toString(),pid,'a',['ctrl']),error=>error instanceof Error&&!(error instanceof BackgroundInputRefused)&&/结果未知/.test(error.message))
  assert.equal(f.calls.length,1)
  assert.equal(f.control(),false)
  f.calls.length=0;f.setResult('access-denied')
  assert.throws(()=>f.input.doubleClick(root.toString(),pid,0,80),BackgroundInputRefused)
  assert.equal(f.calls.length,1)
  f.calls.length=0;f.setResult('delivered')
  const send=f.port.send
  f.port.send=(...args)=>f.calls.length===1?(f.calls.push(args),'unknown'):send(...args)
  assert.throws(()=>f.input.doubleClick(root.toString(),pid,0,80),error=>error instanceof Error&&!(error instanceof BackgroundInputRefused))
  assert.equal(f.calls.length,2)
})
