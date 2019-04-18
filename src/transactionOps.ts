import { runTransaction } from './genLock';
import { CommitAsPromise, CommitPromise, Locker, Transaction } from './genLockTypes';
import { AquireOptions, LockingProtocol } from 'priority-redlock';
import { aquireAll, util } from 'priority-redlock';

const { mergeWithDefaultOptions } = util

// Shortcut for always recovering & resuming on LockErrors (use previous aquireOptions)
export const alwaysResume = <RESOURCE, T>(commitPromise: CommitPromise<RESOURCE, T>) => {
    return commitPromise.recover((recovery) => recovery.resume())
}

// Shortcut for always recovering & restarting on LockErrors (use previous aquireOptions)
export const alwaysRestart = <RESOURCE, T>(commitPromise: CommitPromise<RESOURCE, T>) => {
    return commitPromise.recover((recovery) => recovery.restart())
}

// Combines 2 lockers so that any transaction run requires both locks to be held simultaneously.
// lockerA should be more contentious than lockerB on average, since lockerA is aquired first.
// Note: the dual lock is independent of and contends with the input lockers A and B.
// Beware of deadlocks!  For example avoid this sequence:
// newDualLocker(a, b)(t); newDualLocker(b, a)(t);
export const newDualLocker: (protocol: LockingProtocol) =>
    <RESOURCE1, RESOURCE2>(lockerA: Locker<RESOURCE1>, lockerB: Locker<RESOURCE2>, defaultOptions?: AquireOptions)
        => Locker<[RESOURCE1, RESOURCE2]> =
    (protocol) => <RESOURCE1, RESOURCE2>(lockerA: Locker<RESOURCE1>, lockerB: Locker<RESOURCE2>, defaultOptions: AquireOptions = {}) => {
        const resource: [RESOURCE1, RESOURCE2] = [lockerA._resource(), lockerB._resource()]
        const optionsA = mergeWithDefaultOptions({ ...lockerA._defaultOptions(), ...defaultOptions })
        const optionsB = mergeWithDefaultOptions({ ...lockerB._defaultOptions(), ...defaultOptions })
        const lockerAquire = (options: AquireOptions) => {
            return aquireAll([
                () => lockerA._aquire({ ...optionsA, ...options }),
                () => lockerB._aquire({ ...optionsB, ...options }),
            ], options.aquireTimeout || (optionsA.aquireTimeout + optionsB.aquireTimeout))
        }

        const commitFunc: CommitAsPromise<[RESOURCE1, RESOURCE2]> = <T>(
            transaction: Transaction<[RESOURCE1, RESOURCE2], T>, options: AquireOptions = {},
        ) => {
            const finalOptions = mergeWithDefaultOptions({ ...defaultOptions, ...options })
            return runTransaction(protocol)(transaction, locker, resource, finalOptions, () => lockerAquire(options))
        }
        const locker: Locker<[RESOURCE1, RESOURCE2]> = {
            promise: commitFunc,
            _defaultOptions: () => mergeWithDefaultOptions(defaultOptions),
            _resource: () => resource,
            _aquire: lockerAquire,
        }
        return locker
    }
