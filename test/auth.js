const test = require('brittle')
const ram = require('random-access-memory')
const crypto = require('hypercore-crypto')
const { replicate } = require('./helpers')

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
