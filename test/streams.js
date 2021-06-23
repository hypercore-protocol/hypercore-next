const { create } = require('./helpers')
const tape = require('tape')

function test (batch = 1) {
  tape('createReadStream to createWriteStream', async function (t) {
    let p = InvertedPromise()

    const feed1 = await create()
    const feed2 = await create()

    await feed1.append(['hello', 'world'])
    const r = feed1.createReadStream({ batch })
    const w = feed2.createWriteStream()

    r.pipe(w).on('finish', p.resolve)
    await p

    const data = await collect(feed2.createReadStream({ batch }))

    t.same(data, [Buffer.from('hello'), Buffer.from('world')])

    t.end()
  })

  tape('createReadStream with start, end', async function (t) {
    const feed = await create({ valueEncoding: 'utf-8' })

    await feed.append(['hello', 'multiple', 'worlds'])
    const data = await collect(feed.createReadStream({ start: 1, end: 2, batch }))

    t.same(data, ['multiple'])

    t.end()
  })

  tape('createReadStream with start, no end', async function (t) {
    const feed = await create({ valueEncoding: 'utf-8' })

    await feed.append(['hello', 'multiple', 'worlds'])

    const data = await collect(feed.createReadStream({ start: 1, batch }))

    t.same(data, ['multiple', 'worlds'])

    t.end()
  })

  tape('createReadStream with no start, end', async function (t) {
    const feed = await create({ valueEncoding: 'utf-8' })

    await feed.append(['hello', 'multiple', 'worlds'])
    const data = await collect(feed.createReadStream({ end: 2, batch }))
    t.same(data, ['hello', 'multiple'])

    t.end()
  })

  tape('createReadStream with live: true', async function (t) {
    const feed = await create({ valueEncoding: 'utf-8' })
    const expected = ['a', 'b', 'c', 'd', 'e']

    t.plan(expected.length)

    const rs = feed.createReadStream({ live: true, batch })

    rs.on('data', function (data) {
      t.same(data, expected.shift())
    })

    rs.on('end', function () {
      t.fail('should never end')
    })

    await feed.append('a')
    await feed.append('b')
    await feed.append(['c', 'd', 'e'])
    await new Promise(resolve => setImmediate(resolve))
  })

  tape('createReadStream with live: true after append', async function (t) {
    const feed = await create({ valueEncoding: 'utf-8' })
    const expected = ['a', 'b', 'c', 'd', 'e']

    t.plan(expected.length)

    await feed.append(['a', 'b'])
    const rs = feed.createReadStream({ live: true, batch })

    rs.on('data', function (data) {
      t.same(data, expected.shift())
    })

    rs.on('end', function () {
      t.fail('should never end')
    })

    await feed.append(['c', 'd', 'e'])
    await new Promise(resolve => setImmediate(resolve))
  })

  tape('createReadStream with live: true and tail: true', async function (t) {
    const feed = await create({ valueEncoding: 'utf-8' })
    const expected = ['c', 'd', 'e']

    t.plan(expected.length)

    await feed.append(['a', 'b'])
    const rs = feed.createReadStream({ live: true, tail: true, batch })

    rs.on('data', function (data) {
      t.same(data, expected.shift())
    })

    rs.on('end', function () {
      t.fail('should never end')
    })

    await new Promise(resolve => setImmediate(resolve))
    await feed.append(['c', 'd', 'e'])

    await new Promise(resolve => setImmediate(resolve))
  })
}

tape('createWriteStream with maxBlockSize', async function (t) {
  t.plan(11 + 1)

  const feed = await create()

  const ws = feed.createWriteStream({ maxBlockSize: 100 * 1024 })

  ws.write(Buffer.alloc(1024 * 1024))

  const p = InvertedPromise()
  ws.end(p.resolve)

  await p

  t.same(feed.length, 11)

  await sameSize(0, 100 * 1024)
  await sameSize(1, 100 * 1024)
  await sameSize(2, 100 * 1024)
  await sameSize(3, 100 * 1024)
  await sameSize(4, 100 * 1024)
  await sameSize(5, 100 * 1024)
  await sameSize(6, 100 * 1024)
  await sameSize(7, 100 * 1024)
  await sameSize(8, 100 * 1024)
  await sameSize(9, 100 * 1024)
  await sameSize(10, 1024 * 1024 - 10 * 100 * 1024)
  p.resolve()

  async function sameSize (idx, size) {
    try {
      const blk = await feed.get(idx)
      t.same(blk.length, size)
    } catch (err) {
      t.error(err, 'no error')
    }
  }
})

test()
test(10)

function InvertedPromise () {
  let res
  let rej

  const p = new Promise((resolve, reject) => {
    res = resolve
    rej = reject
  })

  p.resolve = res
  p.reject = rej

  return p
}

async function collect (stream) {
  const all = []
  for await (const data of stream) all.push(data)
  return all
}
