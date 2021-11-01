const test = require('brittle')
const sodium = require('sodium-universal')
const crypto = require('hypercore-crypto')
const RAM = require('random-access-memory')
const Hypercore = require('..')

const snapshot = ['blocks', 'tree']

const keyPair = crypto.keyPair(Buffer.alloc(sodium.crypto_sign_SEEDBYTES, 'seed'))

const encryptionKey = Buffer.alloc(sodium.crypto_stream_KEYBYTES, 'encryption key')

test('storage layout', async function (t) {
  const hyp = new Hypercore(RAM, { keyPair })

  for (let i = 0; i < 10000; i++) {
    await hyp.append(Buffer.from([i]))
  }

  const { core } = hyp

  for (const key of snapshot) {
    t.snapshot(data(core[key].storage).toString('base64'), key)
  }
})

test('encrypted storage layout', async function (t) {
  const hyp = new Hypercore(RAM, { keyPair, encryptionKey })

  for (let i = 0; i < 10000; i++) {
    await hyp.append(Buffer.from([i]))
  }

  const { core } = hyp

  for (const key of snapshot) {
    t.snapshot(data(core[key].storage).toString('base64'), key)
  }
})

function data (storage) {
  return Buffer.concat(storage.buffers).slice(0, storage.length)
}
