import {test} from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,readFile,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {DiagnosticJournal,diagnosticZip} from '../src/diagnostic-export.ts'
import {redactDiagnostics} from '../src/redaction.ts'
import {ApplicationAdapterRegistry} from '../src/application-adapters.ts'
import {suggestedTargets} from '../src/accessibility-targets.ts'

test('journal exports scrubbed evidence and ZIP structures without external commands',async()=>{
  const root=await mkdtemp(join(tmpdir(),'dsh-journal-test-'))
  try{
    const journal=new DiagnosticJournal(redactDiagnostics,root)
    journal.record('failure',{argv:['vmrun','-gu','alice','-gp','supersecret'],path:'C:\\Users\\alice\\file'})
    const result=await journal.export({password:'supersecret'},0)
    const bytes=await readFile(result.filePath),text=bytes.toString('utf8')
    assert.equal(bytes.readUInt32LE(0),0x04034b50);assert.equal(bytes.readUInt32LE(bytes.length-22),0x06054b50)
    assert.ok(text.includes('diagnostics.json'));assert.ok(text.includes('[redacted]'));assert.ok(!text.includes('alice'));assert.ok(!text.includes('supersecret'))
    await assert.rejects(journal.export({},6));assert.throws(()=>diagnosticZip([{name:'../escape',data:Buffer.alloc(0)}]))
  }finally{await rm(root,{recursive:true,force:true})}
})
test('adapter registry never expands action/command whitelist',()=>{
  const registry=new ApplicationAdapterRegistry()
  const adapter={id:'third-party',actions:['click'],commands:[],matchesExecutable:()=>true,mainWindow:()=>true,readyEvidence:()=>true}
  registry.register(adapter);assert.throws(()=>registry.register(adapter))
  assert.throws(()=>registry.register({...adapter,id:'shell',commands:['exec']}))
  assert.throws(()=>registry.register({...adapter,id:'keyboard',actions:['shell']}))
})
test('UIA bounds map negative desktop origins and cropped resized frames without clipped targets',()=>{
  const targets=suggestedTargets([{name:'Save',controlType:'Button',enabled:true,bounds:{x:-849,y:151,width:100,height:50}}],
    {x:-900,y:100,width:902,height:602},{width:900,height:600},{x:0,y:0,width:900,height:600},{width:450,height:300})
  assert.equal(targets.length,1);assert.deepEqual(targets[0].bbox,{x:25,y:25,width:50,height:25})
  assert.equal(suggestedTargets([{name:'Clipped',controlType:'Button',enabled:true,bounds:{x:-910,y:150,width:100,height:50}}],
    {x:-900,y:100,width:902,height:602},{width:900,height:600},{x:0,y:0,width:900,height:600},{width:450,height:300}).length,0)
})
