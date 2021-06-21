'use strict';
const callbackify = require('util').callbackify;
const assert = require('assert');
const Redis = require('ioredis');
const EventEmitter = require('events').EventEmitter;

/**
 * Lock constructor.
 *
 * @param {Object} options
 *   @property {String|Object} redis - Redis connection string, options to pass
 *     to `redis.createClient`, or an existing instance of `RedisClient`.
 *   @property {Object} redisConnection Pre-existing Redis connection.
 *   @property {String=} namespace - An optional namespace under which to prefix all Redis keys and
 *     channels used by this lock.
 *   @property {Int} minReplications - write must to be replicated at least this many times
 *   @property {Int} replicationTimeout - Wait at most this many miliseconds for replication.
 *     Set to 0 to wait with no timeout.
 */
function Lock(options) {
    this._namespace = options.namespace || 'lock';
    this._minReplications = options.minReplications || 0;
    this._replicationTimeout = options.replicationTimeout || 500;

    // Create Redis connection for issuing normal commands as well as one for
    // the subscription, since a Redis connection with subscribers is not allowed
    // to issue commands.
    assert(options.redis, 'Must provide a Redis connection string, options object, or client instance.');

    if (options.redis && typeof options.redis.duplicate === 'function') {
        this._redisConnection = options.redis;
        this._redisSubscriber = this._redisConnection.duplicate();
    } else {
        // We assume `options.redis` is a connection string or options object.
        this._redisConnection = new Redis(options.redis);
        this._redisSubscriber = new Redis(options.redis);
    }

    // Create event handler to register waiting locks
    this._subscribers = new EventEmitter();
    this._subscribers.setMaxListeners(Infinity);

    // Whenever a lock is released it is published to the namespaced '-release' channel
    // using the lock key as the message.
    this._redisSubscriber.subscribe(`${this._namespace}-release`);
    this._redisSubscriber.on('message', (channel, message) => {
        if (channel !== `${this._namespace}-release` || !this._subscribers.listenerCount(message)) {
            // just ignore, nothing to do here
            return;
        }

        // Notify all waiting instances about the released lock
        this._subscribers.emit(message);
    });

    // Define scripted commands

    let acquireScript = `
        local ttl=tonumber(ARGV[1]);
        if redis.call("EXISTS", KEYS[1]) == 1 then
            return {0, -1, redis.call("PTTL", KEYS[1])};
        end;
        --[[
            Use a global incrementing counter
            It is a signed 64bit integer, so it should not overflow any time soon.
            The number gets converted to JS which uses 64bit floats but even if the
            boundary would be much smaller Number.MAX_SAFE_INTEGER it would take thousands
            of years to reach that limit assuming we make 100k incrementations in a second
        --]]
        local index = redis.call("INCR", KEYS[2]);
        redis.call("HMSET", KEYS[1], "index", index);
        redis.call("PEXPIRE", KEYS[1], ttl);
        return {1, index, ttl};
    `;

    this._redisConnection.defineCommand('ioR4AcquireLock', {
        numberOfKeys: 2,
        lua: acquireScript
    });

    let extendScript = `
        local ttl = tonumber(ARGV[2]);
        local index = tonumber(ARGV[1]);
        if redis.call("HGET", KEYS[1], "index") == ARGV[1] then
            redis.call("PEXPIRE", KEYS[1], ttl);
            return {1, index, ttl};
        else
            return {0};
        end;
    `;

    this._redisConnection.defineCommand('ioR4ExtendLock', {
        numberOfKeys: 1,
        lua: extendScript
    });

    let releaseScript = `
        local index = tonumber(ARGV[1]);
        if redis.call("EXISTS", KEYS[1]) == 0 then
            return {1, "expired", "expired", 0};
        end;
        local data = {
            ["index"]=tonumber(redis.call("HGET", KEYS[1], "index"))
        };
        if data.index == index then
            redis.call("DEL", KEYS[1]);
            -- Notify potential queue that this lock is now freed
            redis.call("PUBLISH", "${this._namespace}-release", KEYS[1]);
            return {1, "released", data.index};
        end;
        return {0, "conflict", data.index};
    `;

    this._redisConnection.defineCommand('ioR4ReleaseLock', {
        numberOfKeys: 1,
        lua: releaseScript
    });
}

Object.assign(Lock.prototype, {
    /**
     * Acquire a lock for a specific ID value. Returns promise that resolves to the following value:
     *
     *   {
     *     success: either true (lock was acquired) of false (lock was not aquired)
     *     ttl: expiration time for the lock
     *   }
     *
     * Lock index is a shared incrementing number (signed 64bit) that should ensure rogue
     * lock holders would not be able to mess with newer locks for the same resource.
     *
     * @param {String} id Identifies the lock. This is an arbitrary string that should be consistent among
     *    different processes trying to acquire this lock.
     * @param {Number} ttl Automatically release lock after TTL (ms). Must be positive integer
     */
    acquireLock(id, ttl) {
        if (arguments.length > 2) {
            return callbackify(this.acquireLock).apply(this, arguments);
        }
        return this._redisConnection
            .pipeline()
            .ioR4AcquireLock(`${this._namespace}:${id}`, `${this._namespace}index`, ttl)
            .wait(this._minReplications, this._replicationTimeout)
            .exec()
            .then(([[evalErr, evalResponse], [repErr, replications]]) => {
                if (evalErr) {
                    throw evalErr || repErr;
                }
                const lock = {
                    id,
                    success: replications >= this._minReplications && !!evalResponse[0],
                    index: evalResponse[1],
                    ttl: evalResponse[2]
                };
                if (replications < this._minReplications) {
                    lock.replicationFailure = true;
                    this._redisConnection.ioR4ReleaseLock(lock);
                }
                return lock;
            });
    },

    /**
     * Releases a lock. Operation only succeeds if a correct modification index is provided.
     * If modification index has been changed then it should indicate that the previously held
     * lock was expired in the meantime and someone has already acquired a new lock for the same id.
     * If lock is not released manually then it expires automatically after the ttl
     *
     * Returns promise that resolves to the following value:
     *
     *   {
     *     success: either true (lock was released or did not exist) of false (lock was not released)
     *     result: status text. Either 'expired', 'released' or 'conflict'
     *   }
     *
     * @param {Object} lock A lock returned by acquireLock or waitAcquireLock
     */
    releaseLock(lock) {
        if (arguments.length > 1) {
            return callbackify(this.releaseLock).apply(this, arguments);
        }
        return this._redisConnection.ioR4ReleaseLock(`${this._namespace}:${lock.id}`, lock.index).then(evalResponse => ({
            id: lock.id,
            success: !!evalResponse[0],
            result: evalResponse[1],
            index: evalResponse[2]
        }));
    },

    /**
     * Extends that TTL for a lock that is already owned.
     * Fails if modification index in lock provided is not currently holding the lock.
     * @param lock
     * @param ttl
     */
    extendLock(lock, ttl) {
        if (arguments.length > 2) {
            return callbackify(this.extendLock).apply(this, arguments);
        }
        return this._redisConnection.ioR4ExtendLock(`${this._namespace}:${lock.id}`, lock.index, ttl).then(evalResponse => ({
            id: lock.id,
            success: !!evalResponse[0],
            index: evalResponse[1],
            ttl: evalResponse[2]
        }));
    },

    /**
     * Acquire a lock for a specific ID value. If the lock is not available then waits
     * up to {waitTtl} milliseconds before giving up.
     * Returns a promise that resolves to the following value:
     *
     *   {
     *     success: either true (lock was acquired) of false (lock was not aquired by given ttl)
     *     ttl: expiration time for the lock
     *   }
     *
     * @param {String} id Identifies the lock. This is an arbitrary string that should be consistent among
     *    different processes trying to acquire this lock.
     * @param {Number} ttl Automatically release acquired lock after TTL (ms). Must be positive integer
     * @param {Number} waitTtl Give up until ttl (in ms) or wait indefinitely if value is 0
     */
    waitAcquireLock(id, lockTtl, waitTtl) {
        if (arguments.length > 3) {
            return callbackify(this.waitAcquireLock).apply(this, arguments);
        }
        return new Promise((resolve, reject) => {
            let expired = false; // flag to indicate that the TTL wait time was expired
            let acquiring = false; // flag to indicate that a Redis query is in process

            let ttlTimer;
            let expireLockTimer;

            // A looping function that tries to acquire a lock. The loop goes on until
            // the lock is acquired or the wait ttl kicks in
            let tryAcquire = () => {
                this._subscribers.removeListener(`${this._namespace}:${id}`, tryAcquire); // clears pubsub listener
                clearTimeout(ttlTimer); // clears the timer that waits until existing lock is expired
                acquiring = true;
                this.acquireLock(id, lockTtl)
                    .then(lock => {
                        acquiring = false;
                        if (lock.success || expired) {
                            // we got a lock or the wait TTL was expired, return what we have
                            clearTimeout(expireLockTimer);
                            return resolve(lock);
                        }

                        // Wait for either a Redis publish event or for the lock expiration timer to expire
                        this._subscribers.addListener(`${this._namespace}:${id}`, tryAcquire);
                        // Remaining TTL for the lock might be very low, even 0 (lock expires by next ms)
                        // in any case we do not make a next polling try sooner than after 100ms delay
                        // We might make the call sooner if the key is released manually and we get a notification
                        // from Redis PubSub about it
                        ttlTimer = setTimeout(tryAcquire, Math.max(lock.ttl, 100));
                    })
                    .catch(err => {
                        // stop waiting if we hit into an error
                        clearTimeout(expireLockTimer);
                        return reject(err);
                    });
            };

            if (waitTtl > 0) {
                expireLockTimer = setTimeout(() => {
                    expired = true;
                    this._subscribers.removeListener(`${this._namespace}:${id}`, tryAcquire);
                    clearTimeout(ttlTimer);
                    // Try one last time and return whatever the acquireLock returns
                    if (!acquiring) {
                        return tryAcquire();
                    }
                }, waitTtl);
            }

            // try to acquire a lock
            tryAcquire();
        });
    }
});

module.exports = Lock;
