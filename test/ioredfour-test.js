/* eslint no-unused-expressions:0 */

'use strict';

const Lock = require('../lib/ioredfour.js');
const expect = require('chai').expect;
const Redis = require('ioredis');

const REDIS_CONFIG = 'redis://localhost:6379/11';

// We need an unique key just in case a previous test run ended with an exception
// and testing keys were not immediately deleted (these expire automatically after a while)
let testKey = 'TEST:' + Date.now();

describe('lock', function () {
    this.timeout(10000); //eslint-disable-line no-invalid-this

    let testLock;

    beforeEach(done => {
        const redis = new Redis(REDIS_CONFIG);
        testLock = new Lock({
            redis,
            namespace: 'testLock'
        });

        done();
    });

    it('should acquire and release a lock only with a valid index', done => {
        testLock.acquireLock(testKey, 60 * 100, (err, lock) => {
            expect(err).not.to.be.ok;
            expect(lock.success).to.equal(true);
            expect(lock.id).to.equal(testKey);
            expect(lock.index).to.be.above(0);

            testLock.acquireLock(testKey, 60 * 100, (err, invalidLock) => {
                expect(err).not.to.be.ok;
                expect(invalidLock.success).to.equal(false);

                testLock.releaseLock(
                    {
                        id: testKey,
                        index: -10
                    },
                    (err, invalidRelease) => {
                        expect(err).not.to.be.ok;
                        expect(invalidRelease.success).to.equal(false);

                        testLock.releaseLock(lock, (err, release) => {
                            expect(err).not.to.be.ok;
                            expect(release.success).to.equal(true);
                            done();
                        });
                    }
                );
            });
        });
    });

    it('should wait and acquire a lock', done => {
        testLock.acquireLock(testKey, 1 * 60 * 1000, (err, initialLock) => {
            expect(err).to.not.be.ok;
            expect(initialLock.success).to.equal(true);

            let start = Date.now();
            testLock.waitAcquireLock(testKey, 60 * 100, 3000, (err, newLock) => {
                expect(err).to.not.be.ok;
                expect(newLock.success).to.equal(true);
                expect(Date.now() - start).to.be.above(1450);

                testLock.releaseLock(newLock, err => {
                    expect(err).to.not.be.ok;
                    done();
                });
            });

            setTimeout(() => {
                testLock.releaseLock(initialLock, err => {
                    expect(err).to.not.be.ok;
                });
            }, 1500);
        });
    });

    it('Should wait and not acquire a lock', done => {
        testLock.acquireLock(testKey, 1 * 60 * 1000, (err, initialLock) => {
            expect(err).to.not.be.ok;
            expect(initialLock.success).to.equal(true);

            let start = Date.now();
            testLock.waitAcquireLock(testKey, 1 * 60 * 1000, 1500, (err, newLock) => {
                expect(err).to.not.be.ok;
                expect(newLock.success).to.equal(false);
                expect(Date.now() - start).to.be.above(1450);
                testLock.releaseLock(initialLock, err => {
                    expect(err).to.not.be.ok;
                    done();
                });
            });
        });
    });

    it('Should be able to be constructed from a pre-existing connection', done => {
        const redis = new Redis(REDIS_CONFIG);
        let testExistingLock = new Lock({
            redis,
            namespace: 'testExistingLock'
        });

        testExistingLock.acquireLock(testKey, 1 * 60 * 1000, (err, initialLock) => {
            expect(err).to.not.be.ok;
            expect(initialLock.success).to.equal(true);

            let start = Date.now();
            testExistingLock.waitAcquireLock(testKey, 60 * 100, 3000, (err, newLock) => {
                expect(err).to.not.be.ok;
                expect(newLock.success).to.equal(true);
                expect(Date.now() - start).to.be.above(1450);

                testExistingLock.releaseLock(newLock, err => {
                    expect(err).to.not.be.ok;
                    done();
                });
            });

            setTimeout(() => {
                testExistingLock.releaseLock(initialLock, err => {
                    expect(err).to.not.be.ok;
                });
            }, 1500);
        });
    });

    it('should throw if redis is not provided', () => {
        expect(
            () =>
                new Lock({
                    namespace: 'testExistingLock'
                })
        ).to.throw(/must provide a redis/i);
    });
});
