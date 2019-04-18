### About gen-lock

Prioritize independent access to shared resources using ES6 Generators

### Features

- Transactions based on ES6 Generators for max flexibility & ease
- Be a complete async traffic cop with 1 function
- Auto-resume/restart when transaction locks are lost
- Extends Redlock algorithm with Priority-based locking
- Re-entrance supported
- Hold many locks as one (deadlocks made easy!)

## Installation

```
npm install gen-lock
```

### Example 1: Share a Smart Bulb

Let's say you have a function to keep your lights in Party Mode, flashing different colors, but you want a higher priority security function that hijacks the bulb from Party Mode when it needs to flash alarms.  With the bulb being the only "shared resource" among the 2 processes, they could coordinate like so:

```
// Assume we have some bulb API with an async API
var bulb = require('...');
// Create default locker factory scoped to the single JS runtime
var newLocker = require('gen-lock').lockerFactory();

// Create 2 lock holders that can lock access to the bulb
var partyModeLock = newLocker('bath_bulb', bulb);
// Security gets higher priority of 2
var securityLock  = newLocker('bath_bulb', bulb, { priority: 2 });

// Lets define our 2 transactions (things we'll do once we lock the bulb)

function* rainbowsTransaction (bulb) {
    // Party time forever! Only ends if bulb.setColor fails
    while (true) {
        // this transaction might get cancelled between any 2 yields,
        // but we can recover with resume() later,
        // wouldn't want to forget what color we were on!
        yield bulb.setColor('red');
        yield bulb.setColor('blue');
        yield bulb.setColor('yellow');
    }
}

function* alarmTransaction (bulb) {
    yield(bulb.setColor('red'));
    
    // Let's keep alerting as long as we need to
    while (alarmIsTripped()) {
        yield bulb.setBrightness(50);
        yield bulb.setBrightness(100);
    }

    // Transactions can return something too
    return yield bulb.getStatus();
}

// Now lock the bulb and start party mode!
// Use resume() to re-aquire the lock when available &
// pick up exactly where the party left off! (from last yield)
partyModeLock.promise(rainbowsTransaction)
    .recover((recovery, err) => recovery.resume())
    .catch((err) => console.error('Bulb broke, rainbow time is over :-( ')

// Since the security lock holder has higher priority,
// the lock will immediately cancel party mode's lock
securityLock.promise(alarmTransaction)
    .then((status) => console.log('Alarm off, bulb status: ' + status))
    .recover((ops) => ops.restart()) // In case a priority > 2 locker comes along!
    .catch((err) => console.error('Somebody broke the bulb!!!'))

// After alarmTransaction completes, we're always back in party mode!
```

Note the beauty of code scalability; as long as the priorities and resource guids are previously agreed upon, all of the processes can operate independently of one another.  This allows for large scale systems, especially in JS.

### Example 2: Prioritized & Decentralized Queuing

The good ol' observer pattern is at the heart of every great distributed system, and chucking priority on top opens up a world of possible distributed workloads.

Let's say you have many processes listening for new video files uploaded to your site, and want to evenly distribute each video to every process so the number of videos are spread equally.  We can use priority locking for this:

```
// Assume we have some event publisher that dishes out new video IDs:
var subscription = require('...');
var newLocker = require('gen-lock').lockerFactory();

// Transaction to handle a videoId
function* processVideo(videoId) {
    var video = yield loadVideo(videoId);
    var processed = yield processVideo(video);
    yield storeVideo(processed);
}

// Undo processVideo if cancelled
function* rollback(videoId) {
    yield deleteVideo(videoId)
}

var key = (videoId) => 'video-' + videoId;

var processedCount = 0
subscription.listenForNewVideo((videoId) => {

    var locker = newLocker(key(videoId), videoId,
        {
            // Negate the processed count, so that
            // the more processed, the less likely to win final processing
            priority: (-processedCount),

            // Only try locking once, if another process won, give up immediately
            maxAquireAttempts: 1,
        });
    
    // Start processing with rollback to delete if interrupted
    locker.promise(processVideo)
        .then(() => processedCount++)
        .recover((recovery) => recovery.replace(rollback))
        .catch(() => console.log('The transaction failed, check your code'))
});

```

### API

### Transaction = function* (resource) { return T }

A transaction is a generator function that accepts a locked resource and optionally returns some T value, usually containing asyncronous yields.
Running a transaction under a lock guarantees nothing else can run while holding the same resource (by resourceGuid).  If the lock is lost
between yields for any reason, the transaction will be suspended until recovery options are triggered, or otherwise reject with a LockError.

### AquireOptions

Customize how to aquire locks

```
priority: number,  // Higher priority aquires will cancel currently active lock holder (Default: 0)
lockTtl: number,  // Time to hold the lock starting from lock obtain time, in ms (Default: Infinity, watch out!)
aquireTimeout: number, // Time to wait for aquiring lock, in ms (Default: Infinity)
maxAquireAttempts: number, // Max number of aquire attempts before giving up (Default: Infinity)
```

#### lockerFactory(defaultAquireOptions = {}, protocol = undefined) => LockerFactory

Default export of this library. Returns newLocker/newDualLocker functions that default to any [AquireOptions](#AquireOptions) set in this factory function call. The optional
protocol defaults to an in-memory LockingProtocol for locks scoped to the current Javascript runtime.

#### lockerFactory.newLocker(resourceGuid, resource, defaultAquireOptions = {}) => Locker

Creates a new lock holder for a given resource. Lockers can commit Transactions.
You should generally create 1 or more per component / resource pair.  Lockers get a random guid
assigned to them by default, but setting them to be equal can be used to acheive re-entrance, allowing
multiple lockers to hold a lock simultaneously.

resourceGuid: string, The string that uniquely and globally identifies this resource

resource: any, The resource that's handed to a Transaction after lock is aquired

defaultAquireOptions: [AquireOptions](#AquireOptions), The default options to use when not explicitly set per Transaction, inherits and overwrites factory options

Returns: A new Locker commit function that can execute Transactions

#### lockerFactory.newDualLocker(lockerA, lockerB, aquireOptions = {})

Combines 2 lockers so that any transaction run requires both locks to be held simultaneously.
lockerA should be more contentious than lockerB on average, since lockerA is aquired first.
aquireOptions will overwrite all other options, and lockerA / lockerB's own options will overwrite
factory options. The dual lock is independent of and contends with the input lockers A and B.
Calls to newDualLocker can be nested to create ungodly composite locks.

Beware of deadlocks!  For example avoid this sequence:
```
newDualLocker(a, b)(t);
newDualLocker(b, a)(t);
```

#### locker.promise(transaction, aquireOptions) => CommitPromise<T>

Takes care of aquiring a lock and running the transaction as long as the lock is held, and auto-releases the lock upon completion or error.  Extends a regular
Promise by adding .recover(), a method to reliably control behavior when locking errors occur.

transaction: The Transaction to run under lock

aquireOptions: Specify locking behavior for this particular transaction but inherit the locker and factory's default options

Returns: A Promise for the return result of the Transaction.  The Promise will trigger an error if the underlying Transaction throws an
uncaught Error.  The Promise also has a recover(handler) method similar to catch() that is called if a LockError occurs before transaction completion. In this
case the handler will be called with a [RecoveryOps](#RecoveryOps) object and LockError object as parameters.  Calling any recovery op other than reject attempts to re-aquire the lock and recover after aquisition, with the same aquireOptions (by default).  Note: non-reject recovery ops may be invoked forever so long as LockErrors continue to occur before the Transaction completes.

#### CommitPromise.recover(function handler(recover, err) { return recover... } )

handler: The function that receives a [RecoveryOps](#RecoveryOps) object and a LockError object, and returns a call to one of RecoveryOps's functions to control future flow.


### RecoveryOps

When handling a Recovery Op in promise().recover(), your handler _must_ call and return one of the following to guarantee your promise() will complete:

```
resume: (newAquireOptions) => ResumeOp, Wait to re-aquire the lock and resume where at the yield the cancelled Transaction 
left off at! Uses either newAquireOptions or leaving empty to use the previous aquireOptions

restart: (newAquireOptions) => RestartOp, Wait to re-aquire the lock and re-run the cancelled Transaction from the start.  Uses either newAquireOptions or leave empty to use the previous aquireOptions.

replace: (newTransaction, newAquireOptions) => ReplaceOp, Wait to re-aquire the lock and run a substitute transaction of the same input/output types.  Uses either newAquireOptions or leave empty to use the previous aquireOptions.

reject: (err: Error) => RejectOp, Signal that the Transaction cannot recover and propagate err to the promise() catch.
```

#### alwaysResume(lockPromise: CommitPromise) => CommitPromise

Shortcut method to always resume the transaction until it completes.

#### alwaysRestart(lockPromise: CommitPromise) => CommitPromise

Shortcut method to always restart the transaction until it completes.  Note this is a bit riskier in nature than alwaysResume since the transaction starts from scratch and may never get the chance to complete.

## Concurrency tips

- Be careful using newDualLocker, this can easily lead to deadlocks if abused
- Always set lockTtl in the options, otherwise you may end up hogging a lock forever!
- aquireTimeout is infinity by default, which may not be what you want
- Think long and hard about priority levels since they're the only required knowledge between all your components
- Leave yourself breathing room between priority levels (use 0, 100, 200..., not 0, 1, 2...) so you can insert later

## TODO for version 1

- Implement this API on a _distributed_ redlock once the underlying [locking library](https://github.com/gittyeric/priority-redlock) supports it in Redis.
- 100% test coverage, only stupid cases remain that are hardly worth it
- Add a non-promise interface, maybe even like, a _generator_ interface!?

### Note on future-proofing toward distributed computing

Note that any code you write against this library will eventually work across distributed workloads once [priority-redlock](https://github.com/gittyeric/priority-redlock) adds Redis support!  gen-lock should still be quite useful for coordinating many processes within a single JS runtime in the meantime, though.