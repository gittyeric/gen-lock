import { RecoveryOp, ReplaceRecovery, RestartRecovery, ResumeRecovery, RejectRecovery } from './genLockTypes';

export function isResumeOp(op: RecoveryOp<any, any>): op is ResumeRecovery {
    return op && op.type === 'resume'
}

export function isRestartOp(op: RecoveryOp<any, any>): op is RestartRecovery {
    return op && op.type === 'restart'
}

export function isReplaceOp<RESOURCE, T>(op: RecoveryOp<RESOURCE, T>): op is ReplaceRecovery<RESOURCE, T> {
    return op && op.type === 'replace'
}

export function isRejectOp<RESOURCE, T>(op: RecoveryOp<RESOURCE, T>): op is RejectRecovery {
    return op && op.type === 'reject'
}