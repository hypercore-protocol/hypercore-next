const tape = require('tape')
const ram = require('random-access-memory')
const crypto = require('hypercore-crypto')
const Hypercore = require('..')

tape('can create writable sessions from a read-only core', async function (t) {
  t.plan(5)

  const keyPair = crypto.keyPair()
  const core = new Hypercore(ram, keyPair.publicKey, {
    valueEncoding: 'utf-8'
  })
  await core.ready()
  t.false(core.writable)

  const session = core.session({ keyPair: { secretKey: keyPair.secretKey } })
  t.true(session.writable)

  try {
    await core.append('hello')
    t.fail('should not have appended to the read-only core')
  } catch {
    t.pass('read-only core append threw correctly')
  }

  try {
    await session.append('world')
    t.pass('session append did not throw')
  } catch {
    t.fail('session append should not have thrown')
  }

  t.same(core.length, 1)
  t.end()
})

tape('writable session with custom sign function', async function (t) {
  t.plan(5)

  const keyPair = crypto.keyPair()
  const core = new Hypercore(ram, keyPair.publicKey, {
    valueEncoding: 'utf-8'
  })
  await core.ready()
  t.false(core.writable)

  const session = core.session({ sign: signable => crypto.sign(signable, keyPair.secretKey) })
  t.true(session.writable)

  try {
    await core.append('hello')
    t.fail('should not have appended to the read-only core')
  } catch {
    t.pass('read-only core append threw correctly')
  }

  try {
    await session.append('world')
    t.pass('session append did not throw')
  } catch {
    t.fail('session append should not have thrown')
  }

  t.same(core.length, 1)
  t.end()
})

tape('writable session with invalid keypair throws', async function (t) {
  t.plan(2)

  const keyPair1 = crypto.keyPair()
  const keyPair2 = crypto.keyPair()

  try {
    const core = new Hypercore(ram, keyPair2.publicKey) // Create a new core in read-only mode.
    core.session({ keyPair: keyPair1 })
    t.fail('invalid keypair did not throw')
  } catch {
    t.pass('invalid keypair threw')
  }

  try {
    const core = new Hypercore(ram, keyPair1.publicKey, { keyPair: keyPair2 }) // eslint-disable-line
    await core.ready()
    t.fail('invalid keypair did not throw')
  } catch {
    t.pass('invalid keypair threw')
  }
})

tape('preload from another session', async function (t) {
  t.plan(2)

  const first = new Hypercore(ram)
  await first.ready()

  const second = new Hypercore(null, {
    preload: () => {
      return { from: first }
    }
  })
  await second.ready()

  t.same(first.key, second.key)
  t.same(first.sessions, second.sessions)
})
