const test = require('brittle')
const { create } = require('./helpers')

test('clear', async function (t) {
  const a = await create()
  await a.append(['a', 'b', 'c'])

  await a.clear(1)

  t.ok(await a.has(0))
  t.absent(await a.has(1))
  t.ok(await a.has(2))
})
