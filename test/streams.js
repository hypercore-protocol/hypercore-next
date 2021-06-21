const { create } = require('./helpers')
const tape = require('tape')
var collect = require('stream-collector')

function test (batch = 1) {
  tape('createReadStream to createWriteStream', async function (t) {
    let p = InvertedPromise()

    var feed1 = await create()
    var feed2 = await create()

    await feed1.append(['hello', 'world'])
    var r = feed1.createReadStream({ batch })
    var w = feed2.createWriteStream()

    r.pipe(w).on('finish', p.resolve)
    await p

    p = InvertedPromise()
    collect(feed2.createReadStream({ batch }), function (err, data) {
      t.error(err, 'no error')
      t.same(data, [Buffer.from('hello'), Buffer.from('world')])
      p.resolve()
    })
    await p

    t.end()
  })

  tape('createReadStream with start, end', async function (t) {
    var feed = await create({ valueEncoding: 'utf-8' })

    await feed.append(['hello', 'multiple', 'worlds'])
    let p = InvertedPromise()
    collect(feed.createReadStream({ start: 1, end: 2, batch }), function (err, data) {
      t.error(err, 'no error')
      t.same(data, ['multiple'])
      p.resolve()
    })
    await p

    t.end()
  })

  tape('createReadStream with start, no end', async function (t) {
    var feed = await create({ valueEncoding: 'utf-8' })

    await feed.append(['hello', 'multiple', 'worlds'])

    let p = InvertedPromise()
    collect(feed.createReadStream({ start: 1, batch }), function (err, data) {
      t.error(err, 'no error')
      t.same(data, ['multiple', 'worlds'])
      p.resolve()
    })
    await p

    t.end()
  })

  tape('createReadStream with no start, end', async function (t) {
    var feed = await create({ valueEncoding: 'utf-8' })

    await feed.append(['hello', 'multiple', 'worlds'])
    let p = InvertedPromise()
    collect(feed.createReadStream({ end: 2, batch }), function (err, data) {
      t.error(err, 'no error')
      t.same(data, ['hello', 'multiple'])
      p.resolve()
    })
    await p

    t.end()
  })

  tape('createReadStream with live: true', async function (t) {
    var feed = await create({ valueEncoding: 'utf-8' })
    var expected = ['a', 'b', 'c', 'd', 'e']

    t.plan(expected.length)

    var rs = feed.createReadStream({ live: true, batch })

    rs.on('data', function (data) {
      t.same(data, expected.shift())
    })

    rs.on('end', function () {
      t.fail('should never end')
    })

    rs.on('drain', function () {
      console.log('draaaaainnned')
    })

    await feed.append('a')
    await feed.append('b')
    await feed.append(['c', 'd', 'e'])
    await sleep(100)
  })

  tape('createReadStream with live: true after append', async function (t) {
    var feed = await create({ valueEncoding: 'utf-8' })
    var expected = ['a', 'b', 'c', 'd', 'e']

    t.plan(expected.length)

    await feed.append(['a', 'b'])
    var rs = feed.createReadStream({ live: true, batch })

    rs.on('data', function (data) {
      t.same(data, expected.shift())
    })

    rs.on('end', function () {
      t.fail('should never end')
    })

    await feed.append(['c', 'd', 'e'])
    await sleep(100)
  })

  tape('createReadStream with live: true and tail: true', async function (t) {
    var feed = await create({ valueEncoding: 'utf-8' })
    var expected = ['c', 'd', 'e']

    t.plan(expected.length)

    await feed.append(['a', 'b'])
    var rs = feed.createReadStream({ live: true, tail: true, batch })

    rs.on('data', function (data) {
      t.same(data, expected.shift())
    })

    rs.on('end', function () {
      t.fail('should never end')
    })

    setImmediate(async function () {
      await feed.append(['c', 'd', 'e'])
    })
    await sleep(100)
  })
}

tape('createWriteStream with maxBlockSize', async function (t) {
  t.plan(11 + 1)

  var feed = await create()

  var ws = feed.createWriteStream({ maxBlockSize: 100 * 1024 })

  ws.write(Buffer.alloc(1024 * 1024))

  const p = InvertedPromise()
  ws.end(async function () {
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
  await p
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

async function sleep (n) {
  return new Promise(resolve => {
    setTimeout(resolve, n)
  })
}

