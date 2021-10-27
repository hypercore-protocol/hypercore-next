# Hypercore 10

NOTE: This is the _ALPHA_ version of the upcoming [Hypercore](https://github.com/hypercore-protocol/hypercore) 10 protocol upgrade.

Features all the power of Hypercore combined with

* Multiwriter support
* Fork recovery
* Promises
* Simplications and performance/scaling improvements
* Internal oplog design

## Install

Install from NPM using the next tag

```sh
npm install hypercore@next
```

## API

#### `const core = new Hypercore(storage, [key], [options])`

Make a new Hypercore instance.

`storage` should be set to a directory where you want to store the data and core metadata.

``` js
const core = new Hypercore('./directory') // store data in ./directory
```

Alternatively you can pass a function instead that is called with every filename Hypercore needs to function and return your own [abstract-random-access](https://github.com/random-access-storage/abstract-random-access) instance that is used to store the data.

``` js
const ram = require('random-access-memory')
const core = new Hypercore((filename) => {
  // filename will be one of: data, bitfield, tree, signatures, key, secret_key
  // the data file will contain all your data concatenated.

  // just store all files in ram by returning a random-access-memory instance
  return ram()
})
```

Per default Hypercore uses [random-access-file](https://github.com/random-access-storage/random-access-file). This is also useful if you want to store specific files in other directories.

Hypercore will produce the following files:

* `oplog` - The internal truncating journal/oplog that tracks mutations, the public key and other metadata.
* `tree` - The Merkle Tree file.
* `bitfield` - The bitfield of which data blocks this core has.
* `data` - The raw data of each block.

Note that `tree`, `data`, and `bitfield` are normally heavily sparse files.

`key` can be set to a Hypercore public key. If you do not set this the public key will be loaded from storage. If no key exists a new key pair will be generated.

`options` include:

``` js
{
  createIfMissing: true, // create a new Hypercore key pair if none was present in storage
  overwrite: false, // overwrite any old Hypercore that might already exist
  valueEncoding: 'json' | 'utf-8' | 'binary', // defaults to binary
  keyPair: kp, // optionally pass the public key and secret key as a key pair
  encryptionKey: k // optionally pass an encryption key to enable block encryption
}
```

You can also set valueEncoding to any [abstract-encoding](https://github.com/mafintosh/abstract-encoding) or [compact-encoding](https://github.com/compact-encoding) instance.

#### `const seq = await core.append(block)`

Append a block of data (or an array of blocks) to the core.
Returns the seq the first block was stored at.

#### `const block = await core.get(index, [options])`

Get a block of data.
If the data is not available locally this method will prioritize and wait for the data to be downloaded.

Options include

``` js
{
  wait: true, // wait for index to be downloaded
  onwait: () => {}, // hook that is called if the get is waiting for download
  timeout: 0, // wait at max some milliseconds (0 means no timeout)
  valueEncoding: 'json' | 'utf-8' | 'binary' // defaults to the core's valueEncoding
}
```

#### `await core.truncate(newLength, [forkId])`

Truncate the core to a smaller length.

Per default this will update the fork id of the core to `+ 1`, but you can set the fork id you prefer with the option.
Note that the fork id should be monotonely incrementing.

#### `const range = core.download([range])`

Download a range of data.

You can await when the range has been fully downloaded by doing:

```js
await range.downloaded()
```

A range can have the following properties:

``` js
{
  start: startIndex,
  end: nonInclusiveEndIndex,
  blocks: [index1, index2, ...],
  linear: false // download range linearly and not randomly
}
```

To download the full core continously (often referred to as non sparse mode) do

``` js
// Note that this will never be consider downloaded as the range
// will keep waiting for new blocks to be appended.
core.download({ start: 0, end: -1 })
```

To downloaded a discrete range of blocks pass a list of indices.

```js
core.download({ blocks: [4, 9, 7] });
```

To cancel downloading a range simply destroy the range instance.

``` js
// will stop downloading now
range.destroy()
```

#### `const [index, relativeOffset] = await core.seek(byteOffset)`

Seek to a byte offset.

Returns `(index, relativeOffset)`, where `index` is the data block the byteOffset is contained in and `relativeOffset` is
the relative byte offset in the data block.

#### `const updated = await core.update()`

Wait for the core to try and find a signed update to it's length.
Does not download any data from peers except for a proof of the new core length.

``` js
const updated = await core.update()
console.log('core was updated?', updated, 'length is', core.length)
```

#### `await core.close()`

Fully close this core.

#### `core.on('close')`

Emitted when then core has been fully closed.

#### `await core.ready()`

Wait for the core to fully open.

After this has called `core.length` and other properties have been set.

In general you do NOT need to wait for `ready`, unless checking a synchronous property,
as all internals await this themself.

#### `core.on('ready')`

Emitted after the core has initially opened all it's internal state.

#### `core.writable`

Can we append to this core?

Populated after `ready` has been emitted. Will be `false` before the event.

#### `core.readable`

Can we read from this core? After closing the core this will be false.

Populated after `ready` has been emitted. Will be `false` before the event.

#### `core.key`

Buffer containing the public key identifying this core.

Populated after `ready` has been emitted. Will be `null` before the event.

#### `core.discoveryKey`

Buffer containing a key derived from the core's public key.
In contrast to `core.key` this key does not allow you to verify the data but can be used to announce or look for peers that are sharing the same core, without leaking the core key.

Populated after `ready` has been emitted. Will be `null` before the event.

#### `core.encryptionKey`

Buffer containing the optional block encryption key of this core.

#### `core.length`

How many blocks of data are available on this core?

Populated after `ready` has been emitted. Will be `0` before the event.

#### `core.byteLength`

How much data is available on this core in bytes?

Populated after `ready` has been emitted. Will be `0` before the event.

#### `core.fork`

What is the current fork id of this core?

Populated after `ready` has been emitted. Will be `0` before the event.

#### `core.padding`

How much padding is applied to each block of this core? Will be `0` unless block encryption is enabled.

#### `const stream = core.replicate(isInitiatorOrReplicationStream)`

Create a replication stream. You should pipe this to another Hypercore instance.

The `isInitiator` argument is a boolean indicating whether you are the iniatior of the connection (ie the client)
or if you are the passive part (ie the server).

If you are using a P2P swarm like [Hyperswarm](https://github.com/hyperswarm/hyperswarm) you can know this by checking if the swarm connection is a client socket or server socket. In Hyperswarm you can check that using the [client property on the peer details object](https://github.com/hyperswarm/hyperswarm#swarmonconnection-socket-details--)

If you want to multiplex the replication over an existing Hypercore replication stream you can pass
another stream instance instead of the `isInitiator` boolean.

``` js
// assuming we have two cores, localCore + remoteCore, sharing the same key
// on a server
const net = require('net')
const server = net.createServer(function (socket) {
  socket.pipe(remoteCore.replicate(false)).pipe(socket)
})

// on a client
const socket = net.connect(...)
socket.pipe(localCore.replicate(true)).pipe(socket)
```

#### `core.on('append')`

Emitted when the core has been appended to (i.e. has a new length / byteLength), either locally or remotely.

#### `core.on('truncate')`

Emitted when the core has been truncated, either locally or remotely.
