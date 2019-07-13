import { CommitAsPromise, CommitPromise, Locker, LockerFactory, RecoveryHandler, RecoveryOp, RecoveryOps, Transaction } from './genLockTypes';
import { isReplaceOp, isRestartOp, isResumeOp, isRejectOp } from './util';
import { util, Lock, aquire, AquireOptions, DefinedAquireOptions, LockingProtocol, newInMemoryLockingProtocol, LockError, LockErrorType } from 'priority-redlock';
import { randomBytes } from 'priority-redlock/lib/util';

const {
    isLockError,
    isLockHeld, isPromise, 
    newLockError, 
    mergeWithDefaultOptions,
} = util

const newRecoveryOps: <RESOURCE, T>(lockError: LockError<LockErrorType>) => RecoveryOps<RESOURCE, T> =
    (lockError) => ({
        replace: <RESOURCE, T>(newTransaction: Transaction<RESOURCE, T>, newAquireOptions: AquireOptions = {}) =>
            ({ type: 'replace', newTransaction, newAquireOptions }),
        restart: (newAquireOptions: AquireOptions = {}) =>
            ({ type: 'restart', newAquireOptions }),
        resume: (newAquireOptions: AquireOptions = {}) =>
            ({ type: 'resume', newAquireOptions }),
        reject: (err?: Error) =>
            ({ type: 'reject', err: (err ? err : lockError) }),
    })

const newRecoveryOptions = (curOptions: DefinedAquireOptions, newOptions?: AquireOptions) =>
    newOptions ?
        { ...curOptions, ...newOptions } :
        curOptions

const handleRecovery: (protocol: LockingProtocol) =>
    <RESOURCE, T>(op: RecoveryOp<RESOURCE, T>, transaction: Transaction<RESOURCE, T>, locker: Locker<RESOURCE>,
        resource: RESOURCE, curOptions: DefinedAquireOptions, pendingLockGen: () => Promise<Lock>, checkpoint: Iterator<any>, recoveryCallback?: RecoveryHandler<RESOURCE, T>)
        => Promise<T> =
    (protocol: LockingProtocol) =>
        <RESOURCE, T>(op: RecoveryOp<RESOURCE, T>, transaction: Transaction<RESOURCE, T>, locker: Locker<RESOURCE>, resource: RESOURCE, curOptions: DefinedAquireOptions,
            pendingLockGen: () => Promise<Lock>, checkpoint: Iterator<any>, recoveryCallback?: RecoveryHandler<RESOURCE, T>) => {
            if (isResumeOp(op)) {
                const options = newRecoveryOptions(curOptions, op.newAquireOptions)
                return runTransaction(protocol)(transaction, locker, resource, options, pendingLockGen, checkpoint, recoveryCallback)
            }
            else if (isRestartOp(op)) {
                const options = newRecoveryOptions(curOptions, op.newAquireOptions)
                return runTransaction(protocol)(transaction, locker, resource, options, pendingLockGen, undefined, recoveryCallback)
            }
            else if (isReplaceOp<RESOURCE, T>(op)) {
                const options = newRecoveryOptions(curOptions, op.newAquireOptions)
                return runTransaction(protocol)(op.newTransaction, locker, resource, options, pendingLockGen, undefined, recoveryCallback)
            }
            else if (isRejectOp(op)) {
                return Promise.reject(op.err)
            }
            return Promise.reject(new Error('A recover() handler must return the result of calling recover.<resume/restart/reject> (or a Promise for them)'))
        }

const runLoop: (lock: Lock, runningTransaction: Iterator<any>, curIter?: IteratorResult<any | Promise<any>>) => Promise<IteratorResult<any>> =
    async (lock: Lock, runningTransaction: Iterator<any>, curIter?: IteratorResult<any | Promise<any>>) => {

        const isFirstIter = !curIter
        let nextIter: IteratorResult<any> = curIter || { done: false, value: undefined }
        try {
            while (isLockHeld(lock.state()) && !nextIter.done) {
                if (isFirstIter) {
                    nextIter = runningTransaction.next()
                }
                else {
                    nextIter = runningTransaction.next(nextIter.value)
                }
                const curVal = nextIter.value
                if (isPromise(curVal)) {
                    return runLoop(lock, runningTransaction, { ...nextIter, value: await curVal })
                }
            }
            const lockState = lock.state()
            if (!isLockHeld(lockState)) {
                return Promise.reject(newLockError(lockState))
            }
            return Promise.resolve(nextIter)
        }
        catch (transactionError) {
            return Promise.reject(transactionError)
        }
    }

export const runTransaction: (protocol: LockingProtocol) =>
    <RESOURCE, T>(transaction: Transaction<RESOURCE, T>, locker: Locker<RESOURCE>, resource: RESOURCE, options: DefinedAquireOptions,
        pendingLockGen: () => Promise<Lock>, transactionCheckpoint?: Iterator<any>, lastRecoveryCallback?: RecoveryHandler<RESOURCE, T>)
        => CommitPromise<RESOURCE, T> =
    (protocol: LockingProtocol) => <RESOURCE, T>(transaction: Transaction<RESOURCE, T>, locker: Locker<RESOURCE>, resource: RESOURCE, options: DefinedAquireOptions,
        pendingLockGen: () => Promise<Lock>, transactionCheckpoint?: Iterator<any>, lastRecoveryCallback?: RecoveryHandler<RESOURCE, T>) => {
        let recoveryCallback: RecoveryHandler<RESOURCE, T> | undefined = lastRecoveryCallback || undefined
        const runningTransaction = transactionCheckpoint ? transactionCheckpoint : transaction(resource)
        const pendingCommit: CommitPromise<RESOURCE, T> = pendingLockGen()
            .then((lock: Lock) => {
                return runLoop(lock, runningTransaction)
                    .then((curIter) => {
                        const lockState = lock.state()
                        lock.release()
                            .catch((e) => undefined) // Swallow release errors
                        if (!isLockHeld(lockState)) {
                            return Promise.reject(newLockError(lockState))
                        }
                        return curIter.value
                    })
                    .catch((e) => Promise.reject(e))
            }).catch(<E extends LockErrorType>(e: LockError<E>) => {
                // Rethrow errors caused by the transaction itself
                if (!isLockError(e)) {
                    return Promise.reject(e)
                }
                // If recovery handlers were set, fallback to those
                if (recoveryCallback) {
                    const ops = newRecoveryOps<RESOURCE, T>(e)
                    const recoveryContext = recoveryCallback(ops, e)
                    if (isPromise(recoveryContext)) {
                        return recoveryContext.then((op) => {
                            return handleRecovery(protocol)(op, transaction, locker, resource, options, pendingLockGen, runningTransaction, recoveryCallback)
                                .catch((e) => Promise.reject(e))
                        })
                    }
                    else {
                        return handleRecovery(protocol)(recoveryContext, transaction, locker, resource, options, pendingLockGen, runningTransaction, recoveryCallback)
                            .catch((e) => Promise.reject(e))
                    }
                }
                // Otherwise, default to throwing LockError back up to caller
                return Promise.reject({
                    ...e,
                    message: `${e.code}, Try adding a recover case like alwaysResume or alwaysRestart to avoid this error if applicable`,
                })
            }) as CommitPromise<RESOURCE, T>

        // A little ugliness to support a nifty JS interface
        pendingCommit.recover = (handler: RecoveryHandler<RESOURCE, T>) => {
            recoveryCallback = handler
        }

        return pendingCommit
    }

const newInMemoryLocker: (protocol: LockingProtocol, factoryOptions?: AquireOptions) =>
    <RESOURCE>(resourceGuid: string, resource: RESOURCE, defaultOptions?: AquireOptions, lockerGuid?: string)
        => Locker<RESOURCE> =
    (protocol, factoryOptions) => <RESOURCE>(resourceGuid: string, resource: RESOURCE, defaultOptions?: AquireOptions, lockerGuid: string = randomBytes(16)) => {
        const lockerOptions = mergeWithDefaultOptions({
            ...(factoryOptions ? factoryOptions : {}),
            ...(defaultOptions ? defaultOptions : {}),
        })

        const lockerAquire = (options: DefinedAquireOptions) =>
            aquire(protocol)(resourceGuid, lockerGuid, options)

        const commitFunc: CommitAsPromise<RESOURCE> = <T>(transaction: Transaction<RESOURCE, T>, options: AquireOptions = {}) => {
            const finalOptions = { ...lockerOptions, ...options }
            const pendingLockGen = () => lockerAquire(finalOptions)
            return runTransaction(protocol)(transaction, locker, resource, finalOptions, pendingLockGen)
        }
        const locker: Locker<RESOURCE> = {
            promise: commitFunc,
            _defaultOptions: () => ({ ...lockerOptions }),
            _resource: () => resource,
            _aquire: lockerAquire,
        }
        return locker as Locker<RESOURCE>
    }

// Top level consumer interface. Protocol defaults to in-memory, single-VM only implementation
export const lockerFactory: (defaultOptions?: AquireOptions, lockingProtocol?: LockingProtocol) => LockerFactory =
    (defaultOptions = {}, lockingProtocol = newInMemoryLockingProtocol()) => ({
        newLocker: newInMemoryLocker(lockingProtocol, defaultOptions),
    })