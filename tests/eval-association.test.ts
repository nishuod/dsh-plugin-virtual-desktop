import {test} from 'node:test'
import assert from 'node:assert/strict'
import {decodeChildAssociation} from '../scripts/eval-contract.mjs'

test('live eval accepts only proven absent child and never hides an existing or uncertain association',()=>{
  assert.equal(decodeChildAssociation(1,0xffffffff,0),null)
  assert.equal(decodeChildAssociation(0,0xffffffff,1168),null)
  assert.equal(decodeChildAssociation(1,7,0),7)
  for(const [id,error] of [[0,1168],[7,1168],[0xffffffff,5],[0xffffffff,0]])assert.throws(()=>decodeChildAssociation(0,id,error),/Unable to verify/)
})
