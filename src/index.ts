import {
    lockerFactory,
} from './genLock'
import { AquireOptions, LockingProtocol, newInMemoryLockingProtocol } from 'priority-redlock'
import { newDualLocker } from './transactionOps'

// Bind contexts and export
export default function bindProtocol(factoryDefaultOptions?: AquireOptions, protocol: LockingProtocol = newInMemoryLockingProtocol()) {
    const boundFactory = lockerFactory(factoryDefaultOptions, protocol)
    const boundDual = newDualLocker(protocol)
    return {
        newLocker: boundFactory.newLocker,
        newDualLocker: boundDual,
    }
}

export {
    alwaysResume,
    alwaysRestart,
    newDualLocker,
} from './transactionOps'

// Types
export {
    Transaction,
    CommitAsPromise as Commit, CommitPromise,
    Locker, LockerFactory, NewLocker,
    RecoveryHandler, RecoveryOp, RecoveryOps, ReplaceRecovery, RestartRecovery, ResumeRecovery, RejectRecovery,
} from './genLockTypes'