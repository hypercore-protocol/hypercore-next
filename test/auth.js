const test = require('brittle')
const ram = require('random-access-memory')
const crypto = require('hypercore-crypto')
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
      const sig1 = signature.slice(0, 64)
      const sig2 = signature.slice(64)

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
  t.plan(2)

  const aKey = crypto.keyPair()
  const bKey = crypto.keyPair()

  const sigs = []

  const auth = {
    sign: (signable) => {
      const remote = sigs.find(findBySignable)
      const local = crypto.sign(signable, aKey.secretKey)

      return Buffer.concat([local, Buffer.from(remote.signature, 'base64')])

      function findBySignable ({ block }) {
        const batch = a.core.tree.batch()
        batch.append(a._encode(a.valueEncoding, data))
        return Buffer.compare(batch.signable(), signable) === 0
      }
    },
    verify: (signable, signature) => {
      const sig1 = signature.slice(0, 64)
      const sig2 = signature.slice(64)

      return crypto.verify(signable, sig1, aKey.publicKey) &&
        crypto.verify(signable, sig2, bKey.publicKey)
    }
  }

  const a = new Hypercore(ram, null, {
    valueEncoding: 'utf-8',
    auth
  })

  const b = new Hypercore(ram, a.key, {
    valueEncoding: 'utf-8',
    auth: {
      ...auth,
      sign: null
    }
  })

  await a.ready()
  await b.ready()

  const data = 'hello'

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

  replicate(a, b, t)

  await eventFlush()

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
