const uint64le = require('uint64le')
const sodium = require('sodium-native')
const tape = require('tape')
const { create, replicate } = require('./helpers')

function InvertedPromise () {
  let res
  let rej

  const promise = new Promise((resolve, reject) => {
    res = resolve
    rej = reject
  })

  promise.resolve = res
  promise.reject = rej

  return promise
}

tape('anyone can write', async function (t) {
  const logic = {
    signedBy () { return true },
    signable () { return Buffer.alloc(1) },
    verificationInfo () { return '' }
  }

  const a = await create(null, { logic })

  await a.append(['a', 'b', 'c', 'd', 'e'])

  const b = await create(a.key, {
    sign () { return Buffer.alloc(0) },
    logic
  })

  let d = 0
  let e = 0
  b.on('download', () => d++)
  a.on('download', () => e++)

  replicate(a, b)

  const r = b.download({ start: 0, end: a.length })

  await r.downloaded()
  await b.append('f')

  const r2 = a.download({ start: 0, end: b.length })
  await r2.downloaded()

  t.same(d, 5)
  t.same(e, 1)
  t.same(b.length, 6)
  t.same(a.length, 6)
  t.end()
})

tape('proof of work', async function (t) {
  function sign (data) {
    const sig = Buffer.alloc(16)
    for (let i = 0; ;) {
      hash(sig, [data, Buffer.from((i++).toString(16), 'hex')])
      let test = 0
      for (let j = 0; j < 1; j++) test |= sig[j]
      if (test) continue
      return sig
    }
  }

  const logic = {
    signable (self) { return signable(self.hash(), self.length, self.fork) },
    signedBy (self, n) {
      let test = 0
      for (let j = 0; j < n; j++) test |= self.signature[j]
      return test === 0
    },
    verificationInfo () {
      return 1
    }
  }

  const a = await create(null, { sign, logic })

  await a.append(['a', 'b', 'c', 'd', 'e'])

  const b = await create(a.key, {
    sign,
    logic
  })

  let d = 0
  let e = 0
  b.on('download', () => d++)
  a.on('download', () => e++)

  replicate(a, b)

  const r = b.download({ start: 0, end: a.length })

  await r.downloaded()
  await b.append('f')

  const r2 = a.download({ start: 0, end: b.length })
  await r2.downloaded()

  t.same(d, 5)
  t.same(e, 1)
  t.same(b.length, 6)
  t.same(a.length, 6)
  t.end()
})

tape('proof of work fails', async function (t) {
  function sign (data) {
    const sig = Buffer.alloc(16)
    for (let i = 0; ;) {
      hash(sig, [data, Buffer.from((i++).toString(16), 'hex')])
      let test = 0
      for (let j = 0; j < 1; j++) test |= sig[j]
      if (test) continue
      return sig
    }
  }

  const logic = {
    signable (self) { return signable(self.hash(), self.length, self.fork) },
    signedBy (self, n) {
      let test = 0
      const sig = self.signable()
      for (let j = 0; j < n; j++) test |= sig[j]
      return test === 0
    },
    verificationInfo () {
      return 4
    }
  }

  const a = await create(null, { sign, logic })

  await a.append(['a', 'b', 'c', 'd', 'e'])

  const b = await create(a.key, {
    sign,
    logic
  })

  const fail = InvertedPromise()

  const [s1, s2] = replicate(a, b)

  s1.on('error', () => {})
  s2.on('error', () => {
    t.pass('proof of work should fail')
    fail.resolve()
  })

  await fail

  t.end()
})

function signable (hash, length, fork) {
  const buf = Buffer.alloc(48)
  hash.copy(buf)
  uint64le.encode(length, buf, 32)
  uint64le.encode(fork, buf, 40)
  return buf
}

function hash (out, data) {
  sodium.crypto_generichash(out, Buffer.concat(data))
}
