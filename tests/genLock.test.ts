import { LOCK_RELEASED, LOCK_STOLEN_BY_HIGHER_PRIORITY, util } from 'priority-redlock';
import { lockerFactory } from '../src/genLock';
import { nestedPromiseTransaction, newIntSetterTransaction, newIntSpy } from './mocks';

const { promiseLastingFor, newLockError, isLockError } = util

describe('genLock', () => {
    it('Can return low-level API details', () => {
        const factory = lockerFactory()
        const intSpy = newIntSpy()
        const locker = factory.newLocker('a', intSpy, { priority: 1 })

        expect(Object.keys(locker._defaultOptions()).length).toBeGreaterThan(1)
        expect(locker._resource()).toBe(intSpy)
    });
    it('Can run a transaction and return a result', () => {
        const factory = lockerFactory()
        const intSpy = newIntSpy()
        const transaction = newIntSetterTransaction([1, 2], 1)

        const locker = factory.newLocker('a', intSpy, { priority: 1 })
        const commitPromise = locker.promise(transaction)

        return commitPromise.then((res) => {
            expect(intSpy.get()).toEqual(res)
            expect(res).toBe(2)
        })
    });
    it('Forwards generator\'s yielded values back into the generator', () => {
        const factory = lockerFactory()
        const transaction = function* () {
            const p1 = yield promiseLastingFor(1).then(() => 1)
            const p2 = yield promiseLastingFor(1).then(() => 2)

            expect(p2).toBe(2)
            expect(p1).toBe(1)
            expect(yield p1).toBe(1)
        }

        const locker = factory.newLocker('1', '1')
        return locker.promise(transaction)
    });
    it('Throws syncronous errors coming from transactions', () => {
        const factory = lockerFactory()
        const intSpy = newIntSpy()
        const t1 = newIntSetterTransaction([-1, 0, new Error('Sync Error')], 4)
        const l1 = factory.newLocker('a', intSpy, { priority: 1 }, 'l')

        return l1.promise(t1)
            .then(() => { throw new Error('should not happen') })
            .catch((e) => {
                expect(e.message).toBe('Sync Error')
            })
    });
    it('Throws asyncronous errors coming from transactions', () => {
        const factory = lockerFactory()
        const intSpy = newIntSpy()
        const t1 = newIntSetterTransaction([-1, 0, Promise.resolve(new Error('Async Error'))], 4)
        const l1 = factory.newLocker('a', intSpy, { priority: 1 }, 'l')

        return l1.promise(t1)
            .then(() => {
                throw new Error('should not happen')
            })
            .catch((e) => {
                expect(e.message).toBe('Async Error')
            })
    });
    it('Throws errors coming from nested promises', () => {
        const factory = lockerFactory()
        const intSpy = newIntSpy()
        const t1 = nestedPromiseTransaction(new Error('Async Error'))
        const l1 = factory.newLocker('a', intSpy)

        return l1.promise(t1)
            .then(() => {
                throw new Error('should not happen')
            })
            .catch((e) => {
                expect(e.message).toBe('Async Error')
            })
    });
    it('Returns results coming from nested promises', () => {
        const factory = lockerFactory()
        const t1 = nestedPromiseTransaction()
        const l1 = factory.newLocker('a', false)

        return l1.promise(t1)
            .then((r) => {
                expect(r).toBe(true)
            })
            .catch((e) => {
                throw e
            })
    });
    it('Cancels lower priority transactions for higher ones', async () => {
        const factory = lockerFactory()
        const intSpy = newIntSpy()
        const lowPriorityTransaction = newIntSetterTransaction([-1, 0, 1, 2], 5)
        const highPriorityTransaction = newIntSetterTransaction([3, 4], 4)

        const lowLocker = factory.newLocker('a', intSpy, { priority: 1 }, 'low')
        const highLocker = factory.newLocker('a', intSpy, { priority: 2 }, 'high')

        let lowCancelled = false
        try {
            await lowLocker.promise(lowPriorityTransaction)
            throw new Error('lowPromise should not complete')
        }
        catch (e) {
            lowCancelled = true
        }

        return promiseLastingFor(1).then(() => {
            const highPromise = highLocker.promise(highPriorityTransaction)
            return highPromise.then(() => {
                expect(intSpy.get()).toEqual(4)
                expect(lowCancelled).toBe(true)
            })
                .catch(() => { throw new Error('should not happen') })
        })
    });
    it('Doesnt cancel higher priority transactions for lower ones', () => {
        const factory = lockerFactory()
        const intSpy = newIntSpy()
        const lowPriorityTransaction = newIntSetterTransaction([3, 3, 3, 3, 4], 5)
        const highPriorityTransaction = newIntSetterTransaction([-1, 0, 1, 2], 4)

        const lowLocker = factory.newLocker('a', intSpy, { priority: 1 }, 'low')
        const highLocker = factory.newLocker('a', intSpy, { priority: 2 }, 'high')

        const highPromise = highLocker.promise(highPriorityTransaction)
        let highCancelled = false
        let highDone = false
        highPromise.catch((e) => {
            highCancelled = true
            throw e
        })
        highPromise.then(() => {
            highDone = true
            expect(highCancelled).toBe(false)
            expect(intSpy.get()).toEqual(2)
        })

        return promiseLastingFor(1).then(() => {
            const lowPromise = lowLocker.promise(lowPriorityTransaction)
            return lowPromise.then(() => {
                expect(highDone).toBe(true)
                expect(intSpy.get()).toBe(4)
            })
        })
    });
    it('Supports concurrent transactions when re-entrant', () => {
        const factory = lockerFactory()
        const intSpy = newIntSpy()
        const t1 = newIntSetterTransaction([-1, 0, 1, 2], 4)
        const t2 = newIntSetterTransaction([3, 3, 3, 3, 3, 3], 4)

        const l1 = factory.newLocker('a', intSpy, { priority: 1 }, 'l')
        const l2 = factory.newLocker('a', intSpy, { priority: 2 }, 'l')

        let t1Done = false
        l1.promise(t1).then(() => t1Done = true)
        return l2.promise(t2).then(() => {
            expect(t1Done).toBe(true)
            expect(intSpy.get()).toEqual(3)
        })
    });
    it('throws an error if recovery is called without returning an option', async () => {
        const factory = lockerFactory()
        const intSpy = newIntSpy()
        const lowPriorityTransaction = newIntSetterTransaction([-1, 0, 1, 2], 5)
        const highPriorityTransaction = newIntSetterTransaction([3, 4], 4)

        const lowLocker = factory.newLocker('a', intSpy, { priority: 1 }, 'low')
        const highLocker = factory.newLocker('a', intSpy, { priority: 2 }, 'high')

        const lowCommit = lowLocker.promise(lowPriorityTransaction)
        lowCommit.recover(() => undefined)
        lowCommit
            .then(() => {
                throw newLockError(LOCK_RELEASED)
            })
            .catch((e) => {
                expect(!isLockError(e)).toBeTruthy()
            })


        return promiseLastingFor(6).then(() => {
            const highPromise = highLocker.promise(highPriorityTransaction)
            return highPromise.then(() => {
                expect(intSpy.get()).toEqual(4)
            })
        })
    });
    it('Auto-resumes', async () => {
        const factory = lockerFactory()
        const intSpy = newIntSpy()
        const lowPriorityTransaction = newIntSetterTransaction([-1, 0, 1, 2], 5)
        const highPriorityTransaction = newIntSetterTransaction([3, 4], 4)

        const lowLocker = factory.newLocker('a', intSpy, { priority: 1 }, 'low')
        const highLocker = factory.newLocker('a', intSpy, { priority: 2 }, 'high')

        const lowCommit = lowLocker.promise(lowPriorityTransaction)
        lowCommit.recover((recovery) => recovery.resume())
        try {
            const result = await lowCommit
            expect(intSpy.get()).toEqual(2)
            expect(result).toEqual(2)
        }
        catch (e) {
            throw e
        }

        return promiseLastingFor(6).then(() => {
            const highPromise = highLocker.promise(highPriorityTransaction)
            return highPromise.then(() => {
                expect(intSpy.get()).toEqual(4)
            })
        })
    });
    it('Auto-restarts', async () => {
        const factory = lockerFactory()
        const intSpy = newIntSpy()
        const lowPriorityTransaction = newIntSetterTransaction([-1, 0, 1, 2], 5)
        const highPriorityTransaction = newIntSetterTransaction([3, 4], 4)

        const lowLocker = factory.newLocker('a', intSpy, { priority: 1 }, 'low')
        const highLocker = factory.newLocker('a', intSpy, { priority: 2 }, 'high')

        const lowCommit = lowLocker.promise(lowPriorityTransaction)
        lowCommit.recover((recovery) => recovery.restart())
        try {
            const result = await lowCommit
            expect(intSpy.get()).toEqual(2)
            expect(result).toEqual(2)
        }
        catch (e) {
            throw e
        }

        return promiseLastingFor(6).then(() => {
            const highPromise = highLocker.promise(highPriorityTransaction)
            return highPromise.then(() => {
                expect(intSpy.get()).toEqual(4)
            })
        })
    });
    it('Recovers with replacement', () => {
        const factory = lockerFactory()
        const intSpy = newIntSpy()
        const lowPriorityTransaction = newIntSetterTransaction([-1, 0, 1, 2], 5)
        const highPriorityTransaction = newIntSetterTransaction([3, 4], 4)
        const rollbackTransaction = newIntSetterTransaction([-2, -2], 1)

        const lowLocker = factory.newLocker('a', intSpy, { priority: 1 }, 'low')
        const highLocker = factory.newLocker('a', intSpy, { priority: 2 }, 'high')

        const lowCommit = lowLocker.promise(lowPriorityTransaction)
        lowCommit.recover((recovery) => recovery.replace(rollbackTransaction))
        lowCommit.then((result) => {
            expect(intSpy.get()).toEqual(-2)
            expect(result).toEqual(-2)
        })

        return promiseLastingFor(6).then(() => {
            const highPromise = highLocker.promise(highPriorityTransaction)
            return highPromise.then(() => {
                expect(intSpy.get()).toEqual(4)
            })
        })
    })
    it('Recovers with rejection of default error', async () => {
        const factory = lockerFactory()
        const intSpy = newIntSpy()
        const lowPriorityTransaction = newIntSetterTransaction([-1, 0, 1, 2], 5)
        const highPriorityTransaction = newIntSetterTransaction([3, 4], 4)

        const lowLocker = factory.newLocker('a', intSpy, { priority: 1 }, 'low')
        const highLocker = factory.newLocker('a', intSpy, { priority: 2 }, 'high')
        
        const highCommit = promiseLastingFor(6).then(() => {
            const highPromise = highLocker.promise(highPriorityTransaction)
            return highPromise.then(() => {
                expect(intSpy.get()).toEqual(4)
            })
        })

        try {
            const lowCommit = lowLocker.promise(lowPriorityTransaction)
            lowCommit.recover((recovery) => recovery.reject())
            await lowCommit
            throw new Error('should not happen')
        }
        catch (e) {
            expect(e.message).toEqual(LOCK_STOLEN_BY_HIGHER_PRIORITY)
        }

        return highCommit
    })
    it('Recovers with rejection with custom error', async () => {
        const factory = lockerFactory()
        const intSpy = newIntSpy()
        const lowPriorityTransaction = newIntSetterTransaction([-1, 0, 1, 2], 5)
        const highPriorityTransaction = newIntSetterTransaction([3, 4], 4)

        const lowLocker = factory.newLocker('a', intSpy, { priority: 1 }, 'low')
        const highLocker = factory.newLocker('a', intSpy, { priority: 2 }, 'high')
        
        const highCommit = promiseLastingFor(6).then(() => {
            const highPromise = highLocker.promise(highPriorityTransaction)
            return highPromise.then(() => {
                expect(intSpy.get()).toEqual(4)
            })
        })

        try {
            const lowCommit = lowLocker.promise(lowPriorityTransaction)
            lowCommit.recover((recovery) => recovery.reject(new Error('rejected')))
            await lowCommit
            throw new Error('should not happen')
        }
        catch (e) {
            expect(e.message).toEqual('rejected')
        }

        return highCommit
    })
    it('Recovers with a promise for recovery action', () => {
        const factory = lockerFactory()
        const intSpy = newIntSpy()
        const lowPriorityTransaction = newIntSetterTransaction([-1, 0, 1, 2], 5)
        const highPriorityTransaction = newIntSetterTransaction([3, 4], 4)
        const rollbackTransaction = newIntSetterTransaction([-2, -2], 1)

        const lowLocker = factory.newLocker('a', intSpy, { priority: 1 }, 'low')
        const highLocker = factory.newLocker('a', intSpy, { priority: 2 }, 'high')

        const lowCommit = lowLocker.promise(lowPriorityTransaction)
        lowCommit.recover((recovery) => Promise.resolve(recovery.replace(rollbackTransaction)))
        lowCommit.then((result) => {
            expect(intSpy.get()).toEqual(-2)
            expect(result).toEqual(-2)
        })

        return promiseLastingFor(6).then(() => {
            const highPromise = highLocker.promise(highPriorityTransaction)
            return highPromise.then(() => {
                expect(intSpy.get()).toEqual(4)
            })
        })
    })
})