const test = require('brittle')
const { create } = require('./helpers')

test('cache', async function (t) {
  const a = await create({ cache: true })
  await a.append(['a', 'b', 'c'])

  const p = a.get(0)
  const q = a.get(0)

  t.is(await p, await q, 'blocks are identical')
})

test('session cache', async function (t) {
  const a = await create({ cache: true })
  await a.append(['a', 'b', 'c'])

  const s = a.session()

  const p = a.get(0)
  const q = s.get(0)

  t.is(await p, await q, 'blocks are identical')
})

test('session cache opt-out', async function (t) {
  const a = await create({ cache: true })
  await a.append(['a', 'b', 'c'])

  const s = a.session({ cache: false })

  const p = a.get(0)
  const q = s.get(0)

  t.not(await p, await q, 'blocks are not identical')
})

test('clear cache on truncate', async function (t) {
  const a = await create({ cache: true })
  await a.append(['a', 'b', 'c'])

  const p = a.get(0)

  await a.truncate(0)
  await a.append('d')

  const q = a.get(0)

  t.alike(await p, Buffer.from('a'))
  t.alike(await q, Buffer.from('d'))
})
