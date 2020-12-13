## ioredfour

> Originally forked from **[redfour](https://www.npmjs.com/package/redfour)**. These are the main differences:
>- redfour uses [node_redis](https://www.npmjs.com/package/redis) + [node-redis-scripty](https://www.npmjs.com/package/node-redis-scripty) while ioredfour uses [ioredis](https://www.npmjs.com/package/ioredis)
>- ioredfour optionally uses Redis's WAIT command to achieve better consistency in a failover setting (operations will fail if they can't be replicated, instead of confirmed locks getting lost)
>- ioredfour has `Lock.extendLock()`, which extends the TTL of an owned lock

## Install

```sh
npm install ioredfour --save
```

## Usage example

```js
const Lock = require('ioredfour');

(async ()=> {
  const testLock = new Lock({
    // Can also be an `Object` of options to pass to `new Redis()`
    // https://www.npmjs.com/package/ioredis#connect-to-redis, or an existing
    // instance of `ioredis` (if you want to reuse one connection, though this
    // module must create a second).
    redis: 'redis://localhost:6379',
    namespace: 'mylock',
    // Don't consider the lock owned until writes have been replicated at least this many times
    minReplications: 1,
    // Wait at most this many milliseconds for replication
    replicationTimeout: 500,
  });
  const id = Math.random();

  // First, acquire the lock.
  const firstlock = await testLock.acquireLock(id, 60 * 1000 /* Lock expires after 60sec if not released */).catch(e => {
    console.log('error acquiring first lock', e);
  });
  if (!firstlock.success) {
    console.log('lock exists', firstlock);
  } else {
    console.log('lock acquired initially');
  }

  // Another server might be waiting for the lock like this.
  testLock.waitAcquireLock(id, 60 * 1000 /* Lock expires after 60sec */ , 10 * 1000 /* Wait for lock for up to 10sec */).then(secondlock => {
    if (secondlock.success) {
      console.log('second lock acquired after wait!', secondlock);
    } else {
      console.log('second lock not acquired after wait!', secondlock);
    }
  }).catch(e => {
    console.log('error wait acquiring', e);
  });

  // When the original lock is released, `waitAcquireLock` is fired on the other server.
  setTimeout(async () => {
    try {
      await testLock.releaseLock(firstlock);
      console.log('released lock');
    } catch(e) {
      console.log('error releasing', e);
    }
  }, 10 * 1000);
})();

```

## Contributing

We welcome pull requests! Please lint your code.

## Release History
* 1.1.0 add Lock.extendLock, promisified interface, wait for replication
* 1.0.2-ioredis Forked from redfour and switch node_redis with ioredis
* 1.0.2 Don't use `instanceof` to determine if the `redis` constructor option is of
        type `redis.RedisClient`.
* 1.0.1 Fix issue where you could only pass in a Redis connection URI.
* 1.0.0 Initial release.

## Etymology

Shortened (and easier to pronouce) version of "Redis Semaphore"
