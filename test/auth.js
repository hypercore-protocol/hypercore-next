const test = require('brittle')
const ram = require('random-access-memory')
const crypto = require('hypercore-crypto')
const sodium = require('sodium-universal')
const { eventFlush, replicate } = require('./helpers')

const Hypercore = require('../')

test('multisig hypercore', async function (t) {
  t.plan(2)

  const k1 = crypto.keyPair()
  const k2 = crypto.keyPair()

  const auth = {
    sign: (signable) => {
      const sig1 = crypto.sign(signable, k1.secretKey)
      const sig2 = crypto.sign(signable, k2.secretKey)

      return Buffer.concat([sig1, sig2])
    },
    verify: (signable, signature) => {
      const sig1 = signature.subarray(0, 64)
      const sig2 = signature.subarray(64)

      return crypto.verify(signable, sig1, k1.publicKey) &&
        crypto.verify(signable, sig2, k2.publicKey)
    }
  }

  const a = new Hypercore(ram, null, {
    valueEncoding: 'utf-8',
    auth
  })

  await a.ready()

  const b = new Hypercore(ram, a.key, {
    valueEncoding: 'utf-8',
    auth
  })

  await b.ready()

  await a.append(['a', 'b', 'c', 'd', 'e'])

  t.is(a.length, 5)

  replicate(a, b, t)

  const r = b.download({ start: 0, end: a.length })
  await r.downloaded()

  t.is(b.length, 5)
  t.end()
})

test('multisig hypercore with extension', async function (t) {
  t.plan(3)

  const aKey = crypto.keyPair()
  const bKey = crypto.keyPair()

  const sigs = []

  const auth = {
    sign: (signable) => {
      console.log('hell')
      const remote = sigs.find(findBySignable)
      const local = crypto.sign(signable, aKey.secretKey)

      return Buffer.concat([local, Buffer.from(remote.signature, 'base64')])

      function findBySignable ({ data }) {
        const batch = a.core.tree.batch()
        batch.append(a._encode(a.valueEncoding, data))
        return Buffer.compare(batch.signable(), signable) === 0
      }
    },
    verify: (signable, signature) => {
      const sig1 = signature.subarray(0, 64)
      const sig2 = signature.subarray(64)

      return crypto.verify(signable, sig1, aKey.publicKey) &&
        crypto.verify(signable, sig2, bKey.publicKey)
    }
  }

  const a = new Hypercore(ram, null, {
    valueEncoding: 'utf-8',
    auth
  })

  await a.ready()

  const b = new Hypercore(ram, a.key, {
    valueEncoding: 'utf-8',
    auth: {
      ...auth,
      sign: null
    }
  })

  await b.ready()

  replicate(a, b, t)

  a.registerExtension('multisig-extension', {
    encoding: 'json',
    onmessage: (message, peer) => {
      sigs.push(message)
    }
  })

  const ext = b.registerExtension('multisig-extension', {
    encoding: 'json',
    onmessage: (message, peer) => {
    }
  })

  await eventFlush()
  t.is(b.peers.length, 1)

  const data = 'hello'

  const batch = b.core.tree.batch()
  batch.append(b._encode(b.valueEncoding, data))

  const signable = batch.signable()
  const signature = crypto.sign(signable, bKey.secretKey).toString('base64')

  ext.send({ data, signature, length: a.length }, b.peers[0])

  await eventFlush()

  await a.append('hello')

  t.is(a.length, 1)

  const r = b.download({ start: 0, end: a.length })
  await r.downloaded()

  t.is(a.length, 1)

  t.end()
})

test('proof-of-work hypercore', async function (t) {
  t.plan(2)

  const ZEROES = 8

  const auth = {
    sign: (signable) => {
      const sig = new Uint8Array(32)
      const view = new DataView(sig.buffer)

      for (let i = 0; ;) {
        view.setUint32(0, i++, true)
        const buf = hash(signable, sig)

        let test = 0
        for (let j = 0; j < ZEROES / 8; j++) test |= buf[j]

        if (test) continue
        return sig
      }
    },
    verify: (signable, signature) => {
      const buf = hash(signable, signature)

      let test = 0
      for (let j = 0; j < ZEROES / 8; j++) test |= buf[j]
      return test === 0
    }
  }

  const a = new Hypercore(ram, null, {
    valueEncoding: 'utf-8',
    auth
  })

  await a.ready()

  const b = new Hypercore(ram, a.key, {
    valueEncoding: 'utf-8',
    auth
  })

  await b.ready()

  await a.append(['a', 'b', 'c', 'd', 'e'])

  t.is(a.length, 5)

  replicate(a, b, t)

  const r = b.download({ start: 0, end: a.length })
  await r.downloaded()

  t.is(b.length, 5)
})

test('core using custom sign fn', async function (t) {
  t.plan(2)

  const keyPair = crypto.keyPair()

  const a = new Hypercore(ram, null, {
    valueEncoding: 'utf-8',
    sign: (signable) => crypto.sign(signable, keyPair.secretKey),
    keyPair: {
      publicKey: keyPair.publicKey
    }
  })

  await a.ready()

  const b = new Hypercore(ram, a.key, { valueEncoding: 'utf-8' })
  await b.ready()

  await a.append(['a', 'b', 'c', 'd', 'e'])

  t.is(a.length, 5)

  replicate(a, b, t)

  const r = b.download({ start: 0, end: a.length })
  await r.downloaded()

  t.is(b.length, 5)
  t.end()
})

function hash (...data) {
  const out = Buffer.alloc(32)
  sodium.crypto_generichash(out, Buffer.concat(data))
  return out
}
