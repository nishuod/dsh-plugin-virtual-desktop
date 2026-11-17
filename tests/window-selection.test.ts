import test from 'node:test'
import assert from 'node:assert/strict'
import { compareWindowSamples } from '../src/window-selection.ts'

test('SDK comparison accounts for every unmatched raw window without inventing SDK reasons',()=>{
  const report=compareWindowSamples([
    {id:'1',visible:true,minimized:false,boundsValid:true},
    {id:'2',visible:false,minimized:true,boundsValid:false},
    {id:'3',visible:true,minimized:true,boundsValid:false},
    {id:'4',visible:true,minimized:false,boundsValid:false},
    {id:'5',visible:true,minimized:false,boundsValid:true},
  ],['1','6'])
  assert.equal(report.notCandidate,4)
  assert.equal(report.candidateNotInRaw,1)
  assert.deepEqual(report.observedStates,{notVisible:1,minimized:1,invalidBounds:1,otherOrUnknown:1})
  assert.equal(Object.values(report.observedStates).reduce((sum,n)=>sum+n,0),report.notCandidate)
  assert.match(report.note,/不代表 SDK/)
})
