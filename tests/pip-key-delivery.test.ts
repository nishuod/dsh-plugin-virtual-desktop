import assert from 'node:assert/strict'
import {test} from 'node:test'
import {actionSchema} from '../src/native-contract.ts'
import {childDelivery} from '../src/child-delivery.ts'

test('PiP admits background enter, esc and ctrl-letter plus double click',()=>{
  for(const action of [
    {type:'key',key:'enter'}, {type:'key',key:'esc'}, {type:'key',key:'a',modifiers:['ctrl']},
    {type:'click',button:'left',count:2},
  ]) assert.equal(childDelivery(actionSchema.parse({x:1,y:1,...action})),'background')
})

test('PiP key whitelist rejects shell shortcuts and unlisted combinations',()=>{
  for(const action of [
    {key:'f4',modifiers:['alt']},{key:'tab',modifiers:['alt']},{key:'escape',modifiers:['ctrl']},
    {key:'a',modifiers:['ctrl','shift']},{key:'f5',modifiers:['ctrl']},{key:'a',modifiers:[]},
  ]) assert.throws(()=>childDelivery(actionSchema.parse({x:1,y:1,type:'key',...action})))
})
