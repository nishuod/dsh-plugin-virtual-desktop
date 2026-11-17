export function validateScenarios(scenarios) {
  if (!Array.isArray(scenarios) || scenarios.length !== 20) throw new Error('Evaluation catalog must contain exactly 20 cases')
  const ids = new Set(), tiers = new Set()
  for (const scenario of scenarios) {
    if (!scenario || typeof scenario !== 'object' || !/^[a-z][a-z0-9-]+$/.test(scenario.id) || ids.has(scenario.id)) throw new Error('Invalid or duplicate scenario ID')
    if (!['basic','application','failure'].includes(scenario.tier) || typeof scenario.app !== 'string' || !scenario.app || typeof scenario.initial !== 'string' || !scenario.initial || !Array.isArray(scenario.steps) || scenario.steps.length < 3 || scenario.steps.some(step => typeof step !== 'string' || !step)) throw new Error(`Incomplete scenario: ${scenario.id}`)
    const expected = scenario.expected
    const observationOnly = scenario.tier === 'application' && expected?.verification === 'observation'
    if (!expected || (scenario.tier === 'failure'
      ? typeof expected.reason !== 'string' || expected.inputDelivered !== false
      : typeof expected.outcome !== 'string' || typeof expected.assertion !== 'string' ||
        expected.uiaChanged !== !observationOnly || expected.screenshotHashChanged !== !observationOnly)) throw new Error(`Missing assertion: ${scenario.id}`)
    ids.add(scenario.id); tiers.add(scenario.tier)
  }
  if (tiers.size !== 3) throw new Error('All three evaluation tiers are required')
  return scenarios
}
/** Same no-child contract as the native broker: an arbitrary query failure is not absence. */
export function decodeChildAssociation(success,id,error){
  if(success)return id===0xffffffff?null:id
  if(error===1168&&id===0xffffffff)return null
  throw new Error(`Unable to verify Windows child association (error ${error}); no test started`)
}

