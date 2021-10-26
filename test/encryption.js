const test = require('brittle')
const { create } = require('./helpers')

test('encrypted append and get', async function (t) {
  const a = await create({
    encryptionKey: Buffer.alloc(32, 'hello world')
  })

  await a.append(['hello'])

  const unencrypted = await a.get(0)
  const encrypted = await a.core.blocks.get(0)

  t.alike(unencrypted, Buffer.from('hello'))
  t.unlike(unencrypted, encrypted)
})

test.solo('encrypted seek', async function (t) {
  const a = await create({
    encryptionKey: Buffer.alloc(32, 'hello world')
  })

  await a.append(['hello', 'world', '!'])

  t.alike(await a.seek(0), [0, 0])
  t.alike(await a.seek(4), [0, 4])
  t.alike(await a.seek(5), [1, 0])
  t.alike(await a.seek(6), [1, 1])
  t.alike(await a.seek(6), [1, 1])
  t.alike(await a.seek(9), [1, 4])
  t.alike(await a.seek(10), [2, 0])
  t.alike(await a.seek(11), [3, 0])
})
