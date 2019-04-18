import { defaultOptions, newInMemoryLockingProtocol, util } from "priority-redlock";
import { lockerFactory } from "../src/genLock";
import { newDualLocker, alwaysRestart, alwaysResume } from "../src/transactionOps";
import { newIntSpy, newIntSetterTransaction } from "./mocks";

const { promiseLastingFor } = util

describe('newDualLocker', () => {
    it('should run a transaction on 2 lockers', () => {
        const protocol = newInMemoryLockingProtocol()
        const factory = lockerFactory({}, protocol)
        const lockerA = factory.newLocker('a', 1)
        const lockerB = factory.newLocker('b', 2)

        const dualLocker = newDualLocker(protocol)(lockerA, lockerB)
        expect(dualLocker._resource()).toEqual([1, 2])
        expect(dualLocker._defaultOptions()).toEqual(defaultOptions)
        dualLocker.promise(function* (ab: [number, number]) {
            expect(ab).toEqual([1, 2])
        })
    })
    it('should be nestable and run a transaction on 3 lockers', () => {
        const protocol = newInMemoryLockingProtocol()
        const factory = lockerFactory({}, protocol)
        const lockerA = factory.newLocker('a', 1)
        const lockerB = factory.newLocker('b', 2)
        const lockerC = factory.newLocker('c', 3)

        const dualLocker = newDualLocker(protocol)(lockerA, lockerB)
        const tripleLocker = newDualLocker(protocol)(dualLocker, lockerC)
        expect(tripleLocker._resource()).toEqual([[1, 2], 3])
        tripleLocker.promise(function* (abc: [[number, number], number]) {
            expect(abc).toEqual([[1, 2], 3])
        })
    })
})

describe('alwaysX', () => {
    it('resumes', async () => {
        const factory = lockerFactory()
        const intSpy = newIntSpy()
        const lowPriorityTransaction = newIntSetterTransaction([-1, 0, 1, 2], 5)
        const highPriorityTransaction = newIntSetterTransaction([3, 4], 4)

        const lowLocker = factory.newLocker('a', intSpy, { priority: 1 }, 'low')
        const highLocker = factory.newLocker('a', intSpy, { priority: 2 }, 'high')

        const lowCommit = lowLocker.promise(lowPriorityTransaction)
        alwaysResume(lowCommit)
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
    it('restarts', async () => {
        const factory = lockerFactory()
        const intSpy = newIntSpy()
        const lowPriorityTransaction = newIntSetterTransaction([-1, 0, 1, 2], 5)
        const highPriorityTransaction = newIntSetterTransaction([3, 4], 4)

        const lowLocker = factory.newLocker('a', intSpy, { priority: 1 }, 'low')
        const highLocker = factory.newLocker('a', intSpy, { priority: 2 }, 'high')

        const lowCommit = lowLocker.promise(lowPriorityTransaction)
        alwaysRestart(lowCommit)
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
})