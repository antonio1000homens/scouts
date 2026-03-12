# Duplicate Notification Prevention - Flow Diagram

## Before the Fix

```
┌─────────────────────────────────────────────────────────────────┐
│ Lambda Invocation #1                                            │
│                                                                 │
│  1. Process "Surbiton Parade"                                  │
│  2. Check: HEX file exists? → NO                               │
│  3. Create HEX file with runs=0                                │
│  4. Queue notification ✓                                       │
│  5. Send to Slack → Notification #1 📧                         │
└─────────────────────────────────────────────────────────────────┘

       ⏱️  5 minutes later...

┌─────────────────────────────────────────────────────────────────┐
│ Lambda Invocation #2 (scheduled or manual)                      │
│                                                                 │
│  1. Process "Surbiton Parade"                                  │
│  2. Check: HEX file exists? → YES (from invocation #1)         │
│  3. Check: isFirstRun? → NO (file exists)                      │
│  4. Check: runs >= 5? → NO (runs=1)                            │
│  5. Increment runs to 1, save HEX file                         │
│  6. No notification queued... BUT WAIT!                        │
│                                                                 │
│  ⚠️  RACE CONDITION: If invocation #2 started before          │
│     invocation #1 finished writing the HEX file:              │
│                                                                 │
│  2. Check: HEX file exists? → NO (not written yet!)            │
│  3. Create HEX file with runs=0                                │
│  4. Queue notification ✓                                       │
│  5. Send to Slack → Notification #2 📧 (DUPLICATE!)            │
└─────────────────────────────────────────────────────────────────┘

Result: 2 notifications for same event ❌
```

## After the Fix

```
┌─────────────────────────────────────────────────────────────────┐
│ Lambda Invocation #1                                            │
│                                                                 │
│  1. Process "Surbiton Parade"                                  │
│  2. Check: HEX file exists? → NO                               │
│  3. Check: lastNotificationSent? → NULL                        │
│  4. Check: isInCooldownPeriod? → NO                            │
│  5. Create HEX file with runs=0, lastNotificationSent=null     │
│  6. Queue notification ✓                                       │
│  7. Send to Slack → Notification #1 📧                         │
│  8. Update HEX file:                                           │
│     lastNotificationSent = "2025-10-13T10:00:00Z"              │
└─────────────────────────────────────────────────────────────────┘

       ⏱️  5 minutes later...

┌─────────────────────────────────────────────────────────────────┐
│ Lambda Invocation #2 (scheduled or manual)                      │
│                                                                 │
│  1. Process "Surbiton Parade"                                  │
│  2. Check: HEX file exists? → YES                              │
│  3. Read: lastNotificationSent = "2025-10-13T10:00:00Z"        │
│  4. Check: isFirstRun? → NO (file exists)                      │
│  5. Time since last notification = 5 minutes                   │
│  6. Check: isInCooldownPeriod (< 6 hours)? → YES               │
│  7. Skip notification ✓                                        │
│     Log: "Skipping notification - sent 5 minutes ago"          │
└─────────────────────────────────────────────────────────────────┘

Result: Only 1 notification ✅
```

## Race Condition Handling

Even if two invocations run simultaneously:

```
┌──────────────────────────┐    ┌──────────────────────────┐
│ Invocation #1            │    │ Invocation #2            │
│                          │    │                          │
│ T0: Read HEX (not exist) │    │ T0: Read HEX (not exist) │
│ T1: Create HEX file      │    │ T1: Create HEX file      │
│ T2: Queue notification   │    │ T2: Queue notification   │
│ T3: Send notification    │    │ T3: Send notification    │
│ T4: Update timestamp ✓   │    │ T4: Update timestamp ✓   │
│     2025-10-13T10:00:00Z │    │     2025-10-13T10:00:05Z │
└──────────────────────────┘    └──────────────────────────┘
                   │                         │
                   └─────────┬───────────────┘
                             ↓
                    2 notifications sent
                    (but this is extremely rare
                     due to batching within invocation)
```

**However**, the next invocation will see the timestamp and skip:

```
┌─────────────────────────────────────────────────────────────────┐
│ Lambda Invocation #3 (1 minute later)                           │
│                                                                 │
│  1. Read: lastNotificationSent = "2025-10-13T10:00:05Z"        │
│  2. Time since last = 1 minute                                 │
│  3. isInCooldownPeriod? → YES                                  │
│  4. Skip notification ✓                                        │
└─────────────────────────────────────────────────────────────────┘
```

## Key Improvements

1. **Timestamp-based cooldown**: Even if race conditions occur, subsequent invocations are blocked
2. **Configurable period**: 6-hour cooldown is reasonable for event processing
3. **Preserved within invocation**: Existing batching logic still works
4. **Resilient to failures**: If timestamp update fails, next invocation will still work

## Notification Timeline Example

```
Time  │ Event                                    │ Action
──────┼──────────────────────────────────────────┼─────────────────────
10:00 │ Lambda run #1                            │ Send notification ✓
10:05 │ Lambda run #2 (manual trigger)           │ Skip (5 min ago)
10:30 │ Lambda run #3 (scheduled)                │ Skip (30 min ago)
12:00 │ Lambda run #4 (scheduled)                │ Skip (2 hours ago)
14:00 │ Lambda run #5 (scheduled)                │ Skip (4 hours ago)
16:01 │ Lambda run #6 (scheduled)                │ Send notification ✓
      │                                          │ (>6 hours elapsed)
```

This ensures legitimate re-notifications can occur (e.g., if event details change or approval was rejected) while preventing spam from frequent invocations.
