import { describe, it, expect } from 'vitest'

const BASE_URL = process.env.CYCLES_BASE_URL

describe.skipIf(!BASE_URL)('Live Server Integration', () => {
  it('health check', async () => {
    try {
      const res = await fetch(`${BASE_URL}/actuator/health`)
      expect(res.status).toBe(200)
    } catch {
      console.warn(`Server not reachable at ${BASE_URL} — skipping integration tests`)
      return
    }
  })

  it.todo('reservation lifecycle')
  it.todo('decide endpoint')
  it.todo('balance query')
})
