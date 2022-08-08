const test = require('brittle')
const { create, replicate } = require('./helpers')

test('clear', async function (t) {
  const a = await create()
  await a.append(['a', 'b', 'c'])

  t.is(a.contiguousLength, 3)

  await a.clear(1)

  t.is(a.contiguousLength, 1, 'contig updated')

  t.ok(await a.has(0), 'has 0')
  t.absent(await a.has(1), 'has not 1')
  t.ok(await a.has(2), 'has 2')
})

test('clear during replication', async function (t) {
  const a = await create()
  const b = await create(a.key)

  replicate(a, b, t)

  await a.append(['a', 'b', 'c'])
  await b.download({ start: 0, end: 3 }).downloaded()

  await a.clear(1)

  t.absent(await a.has(1), 'a cleared')

  t.alike(await a.get(1), Buffer.from('b'), 'a downloaded from b')
})
