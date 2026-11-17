import assert from 'node:assert/strict'
import { test } from 'node:test'
import { randomUUID } from 'node:crypto'
import { access, readFile, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import sharp from 'sharp'
import { FrameStore } from '../src/frame-store.ts'
import { admitFrameResult } from '../src/frame-attachment.ts'

test('JPEG remains readable when durable attachment storage rejects, and ends with its connection',async()=>{
  const root=await mkdtemp(join(tmpdir(),'dsh-frame-test-')), store=new FrameStore(root)
  try{
    await store.begin(randomUUID())
    const bytes=await sharp({create:{width:32,height:24,channels:3,background:'red'}}).jpeg().toBuffer()
    const frame=await store.save({id:randomUUID(),windowId:randomUUID(),epoch:1,capturedAt:Date.now(),width:32,height:24,mimeType:'image/jpeg',data:bytes.toString('base64'),source:'window',tree:''})
    const ctx={get:()=>({saveImage:async()=>{throw Object.assign(new Error('disk quota exhausted'),{code:'EDQUOT'})}})} as any
    const result=await admitFrameResult(ctx,{content:[{type:'image',mimeType:frame.mimeType,data:frame.data}],structuredContent:{filePath:frame.filePath,tree:'button Fixture'}})
    assert.equal(result.structuredContent?.imageMode,'unavailable')
    assert.deepEqual(result.structuredContent?.nextToolArgs,{file_path:frame.filePath})
    assert.equal(result.structuredContent?.tree,'button Fixture')
    assert.deepEqual(result.structuredContent?.attachmentError,{name:'Error',message:'disk quota exhausted',code:'EDQUOT'})
    assert.match((result.content[0] as {text:string}).text,/disk quota exhausted/)
    assert.deepEqual(await readFile(frame.filePath!),bytes)
    assert.equal((await sharp(frame.filePath!).metadata()).width,32)
    await store.close();await assert.rejects(access(frame.filePath!),{code:'ENOENT'})
    await assert.rejects(store.save(frame),/关闭/)
  }finally{await store.close();await rm(root,{recursive:true,force:true})}
})

test('attachment success yields a native durable image reference with one storage call',async()=>{
  let calls=0
  const ref={attachmentId:'test',mediaType:'image/jpeg',width:32,height:24,bytes:120}
  const result=await admitFrameResult({get:()=>({saveImage:async()=>{calls++;return ref}})} as any,{content:[{type:'image',mimeType:'image/jpeg',data:'AA=='}],structuredContent:{filePath:'C:/temp/frame.jpg'}})
  assert.equal(calls,1)
  assert.equal(result.structuredContent?.imageMode,'attachment')
  assert.deepEqual(result.content.at(-1),{type:'image',attachment:ref})
})

test('frame paths cannot escape the Host-owned connection directory',async()=>{
  const store=new FrameStore()
  await assert.rejects(store.begin('../outside'))
})
