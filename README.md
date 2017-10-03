## ioredfour

> Originally forked from **[redfour](https://www.npmjs.com/package/redfour)**. Main difference being that redfour uses [node_redis](https://www.npmjs.com/package/redis) + [node-redis-scripty](https://www.npmjs.com/package/node-redis-scripty) while ioredfour uses [ioredis](https://www.npmjs.com/package/ioredis).

## Install

or
```sh
npm install ioredfour --save
```

## Usage example

```js
var Lock = require('ioredfour');

var testLock = new Lock({
  // Can also be an `Object` of options to pass to `new Redis()`
  // https://www.npmjs.com/package/ioredis#connect-to-redis, or an existing
  // instance of `ioredis` (if you want to reuse one connection, though this
  // module must create a second).
  redis: 'redis://localhost:6379',
  namespace: 'mylock'
});
var id = Math.random();
var firstlock;

// First, acquire the lock.
testLock.acquireLock(id, 60 * 1000 /* Lock expires after 60sec if not released */ , function(err, lock) {
  if (err) {
    console.log('error acquiring', err);
  } else if (!lock.success) {
    console.log('lock exists', lock);
  } else {
    console.log('lock acquired initially');
    firstlock = lock;
  }
});

// Another server might be waiting for the lock like this.
testLock.waitAcquireLock(id, 60 * 1000 /* Lock expires after 60sec */ , 10 * 1000 /* Wait for lock for up to 10sec */ , function(err, lock) {
  if (err) {
    console.log('error wait acquiring', err);
  } else {
    console.log('lock acquired after wait!', lock);
  }
});

// When the original lock is released, `waitAcquireLock` is fired on the other server.
setTimeout(() => {
  testLock.releaseLock(firstlock, (err) => {
    if (err) {
      console.log('error releasing', err);
    } else {
      console.log('released lock');
    }
  });
}, 3 * 1000);
```

## Contributing

We welcome pull requests! Please lint your code.

## Release History
* 1.0.2-ioredis Forked from redfour and switch node_redis with ioredis
* 1.0.2 Don't use `instanceof` to determine if the `redis` constructor option is of
        type `redis.RedisClient`.
* 1.0.1 Fix issue where you could only pass in a Redis connection URI.
* 1.0.0 Initial release.

## Etymology

Shortened (and easier to pronouce) version of "Redis Semaphore"
