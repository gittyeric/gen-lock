import { DefinedAquireOptions, AquireOptions, LockError, LockErrorType, Lock } from 'priority-redlock';


// Must be a generator function that may be cancelled after any yield statement
// RESOURCE: The resource type that has just been locked
// T: The return type of the Transaction generator function
// Generic T is wasted here since TS can't represent Generator return types :-(
export type Transaction<RESOURCE, T> = (resource: RESOURCE) => Iterator<any>

export interface ResumeRecovery {
    type: 'resume',
    newAquireOptions?: AquireOptions
}

export interface RestartRecovery {
    type: 'restart',
    newAquireOptions?: AquireOptions
}

export interface ReplaceRecovery<RESOURCE, T> {
    type: 'replace',
    newTransaction: Transaction<RESOURCE, T>,
    newAquireOptions?: AquireOptions
}

export interface RejectRecovery {
    type: 'reject',
    err: Error,
}

export type RecoveryOp<RESOURCE, T> =
    ResumeRecovery | RestartRecovery | ReplaceRecovery<RESOURCE, T> | RejectRecovery

// One of these methods must always be called
export interface RecoveryOps<RESOURCE, T> {
    resume: (newAquireOptions?: AquireOptions) => ResumeRecovery,
    restart: (newAquireOptions?: AquireOptions) => RestartRecovery,
    replace: (newTransaction: Transaction<RESOURCE, T>, newAquireOptions?: AquireOptions) => ReplaceRecovery<RESOURCE, T>,
    reject: (err?: Error) => RejectRecovery,
}
// RecoveryHandler MUST return the call to a method on recovery to eventually complete the CommitPromise!
// Note that your RecoveryHandler may be called many times as long as LockErrors occur
export type RecoveryHandler<RESOURCE, T> = 
    <E extends LockErrorType>(recovery: RecoveryOps<RESOURCE, T>, err: LockError<E>) =>
        RecoveryOp<RESOURCE, T> | Promise<RecoveryOp<RESOURCE, T>>
export interface CommitPromise<RESOURCE, T> extends Promise<T> {
    // Extends Promise, and

    // Attempt to recover from a LockError before triggering Promise rejection
    // Note: handler may be called many times if many LockErrors occur
    recover: (handler: RecoveryHandler<RESOURCE, T>) => void,
}

// Commit a transaction, CommitPromise will reject on transaction error or non-recoverable LockError
export type CommitAsPromise<RESOURCE> =
    <T>(transaction: Transaction<RESOURCE, T>, options?: AquireOptions) => CommitPromise<RESOURCE, T>

export interface Locker<RESOURCE> {
    // High-level API, use this
    promise: CommitAsPromise<RESOURCE>,

    // Low-level API, only use for developing extensions
    _resource(): RESOURCE,
    _defaultOptions(): DefinedAquireOptions,
    _aquire(options: DefinedAquireOptions): Promise<Lock>,
}

export type NewLocker = <RESOURCE>(
    // Required
    resourceGuid: string, resource: RESOURCE,
    // Optional
    defaultOptions?: AquireOptions, lockerGuid?: string)
    => Locker<RESOURCE>

export interface LockerFactory {
    newLocker: NewLocker
}
