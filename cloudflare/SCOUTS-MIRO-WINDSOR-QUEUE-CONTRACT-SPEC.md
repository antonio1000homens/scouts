# Scouts Windsor Queue Contract Miro Spec

This is a Miro-ready spec for the corrected Scouts queue architecture and a companion swimlane showing the active `scouts -> scouts2sqs -> sqs2scouts` contract combinations.

It reflects the current intended design after the image-enrich orchestration change:

- Step Functions publishes to `scoutsRequests`, not directly to `scoutsProcessing`
- `scouts2sqs` remains the main translation boundary
- `taskToken` and orchestration metadata are preserved through `scouts2sqs`
- `sqs2scouts` still performs the Step Functions callback using `taskToken`

## Board Title

`Windsor - Scouts Queue Contract`

## Frame 1

Title:
`Corrected Queue Architecture`

### Layout

Use five vertical columns from left to right:

1. `Producer`
2. `Orchestration`
3. `Requests Queue`
4. `Translation / Processing`
5. `Callback / Outcome`

### Shapes

Column 1:

- `scouts Lambda`
- `Admin / automation`

Column 2:

- `imageEnrich Step Functions`

Column 3:

- `scoutsRequests SQS`

Column 4:

- `scouts2sqs Lambda`
- `scoutsProcessing SQS`
- `sqs2scouts Lambda`

Column 5:

- `scoutsDecision SQS`
- `Step Functions callback`

### Connectors

- `Admin / automation` -> `scouts Lambda`
  Label: `scouts commands`

- `scouts Lambda` -> `scoutsRequests SQS`
  Label: `realm=scoutsRequest | action=request|persist|new|repair`

- `scouts2sqs Lambda` -> `imageEnrich Step Functions`
  Label: `realm=scoutsRequest | action=imageEnrich`

- `imageEnrich Step Functions` -> `scoutsRequests SQS`
  Label: `waitForTaskToken sends scoutsRequest/imageTheme or scoutsRequest/imageUrl`

- `scoutsRequests SQS` -> `scouts2sqs Lambda`
  Label: `main external queue contract`

- `scouts2sqs Lambda` -> `scoutsProcessing SQS`
  Label: `translate to tagline | imageTheme | image | persist`

- `scoutsProcessing SQS` -> `sqs2scouts Lambda`
  Label: `internal processing contract`

- `sqs2scouts Lambda` -> `Step Functions callback`
  Label: `SendTaskSuccess / SendTaskFailure via taskToken`

- `sqs2scouts Lambda` -> `scoutsDecision SQS`
  Label: `realm=sqs2scouts | action=persisted|hidden`

### Notes

Add these note cards near the relevant boxes:

- Near `imageEnrich Step Functions`:
  `Does not publish directly to scoutsProcessing`

- Near `scouts2sqs Lambda`:
  `Preserves requestId, requestHex, taskToken, orchestrationType, orchestrationStep`

- Near `Step Functions callback`:
  `Callback key is taskToken, not executionId or tokenId`

## Frame 2

Title:
`Swimlane - scouts -> scouts2sqs -> sqs2scouts`

### Layout

Create four vertical swimlanes:

1. `Input`
2. `scouts`
3. `scouts2sqs`
4. `sqs2scouts`

Each row is one supported message-contract combination.

### Row Set A

Label:
`Field-level request flows`

1. `REALM scoutsRequest | SUBJECT tagline | ACTION request`
   `scouts`: emits `realm=scoutsRequest subject=tagline action=request hex=<hex>`
   `scouts2sqs`: translates to `realm=tagline subject=<hex> action=request`
   `sqs2scouts`: handles tagline generation and persists tagline

2. `REALM scoutsRequest | SUBJECT imageTheme | ACTION request`
   `scouts`: emits `realm=scoutsRequest subject=imageTheme action=request hex=<hex>`
   `scouts2sqs`: translates to `realm=imageTheme subject=<hex> action=request`
   `sqs2scouts`: handles image-theme generation and persists image theme

3. `REALM scoutsRequest | SUBJECT imageUrl | ACTION request`
   `scouts`: emits `realm=scoutsRequest subject=imageUrl action=request hex=<hex>`
   `scouts2sqs`: translates to `realm=image subject=<hex> action=request`
   `sqs2scouts`: handles image generation and persists image URL

### Row Set B

Label:
`Field-level persist flows`

4. `REALM scoutsRequest | SUBJECT tagline | ACTION persist`
   `scouts`: emits `realm=scoutsRequest subject=tagline action=persist hex=<hex> tagline=<value>`
   `scouts2sqs`: translates to `realm=persist subject={hex,tagline} action=persist`
   `sqs2scouts`: merges persisted patch into HEX and may notify `scoutsDecision`

5. `REALM scoutsRequest | SUBJECT imageTheme | ACTION persist`
   `scouts`: emits `realm=scoutsRequest subject=imageTheme action=persist hex=<hex> imageTheme=<value>`
   `scouts2sqs`: translates to `realm=persist subject={hex,imageTheme} action=persist`
   `sqs2scouts`: merges persisted patch into HEX and may notify `scoutsDecision`

6. `REALM scoutsRequest | SUBJECT imageUrl | ACTION persist`
   `scouts`: emits `realm=scoutsRequest subject=imageUrl action=persist hex=<hex> imageUrl=<value>`
   `scouts2sqs`: translates to `realm=persist subject={hex,imageUrl} action=persist`
   `sqs2scouts`: merges persisted patch into HEX and may notify `scoutsDecision`

### Row Set C

Label:
`Derived work-selection flows`

7. `REALM scoutsRequest | SUBJECT <event object> | ACTION new`
   `scouts`: emits normalized event object
   `scouts2sqs`: derives next step from completeness
   `sqs2scouts`: receives whichever internal realm was chosen
   Note: branch result is one of rows 8-10, or no downstream publish

8. `REALM scoutsRequest | SUBJECT <event object missing tagline> | ACTION new`
   `scouts`: emits normalized event object
   `scouts2sqs`: publishes `tagline/request/<hex>`
   `sqs2scouts`: generates tagline

9. `REALM scoutsRequest | SUBJECT <event object missing imageTheme> | ACTION new`
   `scouts`: emits normalized event object
   `scouts2sqs`: starts `imageEnrich` state machine
   `sqs2scouts`: later handles state-machine-driven `imageTheme` and `image` work

10. `REALM scoutsRequest | SUBJECT <event object missing imageUrl> | ACTION new`
   `scouts`: emits normalized event object
   `scouts2sqs`: starts `imageEnrich` state machine
   `sqs2scouts`: later handles state-machine-driven `image` work

11. `REALM scoutsRequest | SUBJECT <event object> | ACTION retry`
   `scouts`: may requeue stale or failed work
   `scouts2sqs`: same completeness logic as `new`
   `sqs2scouts`: receives whichever internal realm was chosen

12. `REALM scoutsRequest | SUBJECT <event object> | ACTION repair`
   `scouts`: emits repair request for an incomplete or broken event
   `scouts2sqs`: same completeness logic as `new`
   `sqs2scouts`: receives whichever internal realm was chosen

### Row Set D

Label:
`State-machine-owned request flows`

13. `REALM scoutsRequest | SUBJECT imageTheme | ACTION request | source=scouts-image-enrich`
   `scouts`: no direct publish in this row
   `scouts2sqs`: receives message from `scoutsRequests` with `taskToken` and translates to `imageTheme/request/<hex>`
   `sqs2scouts`: generates image theme and may callback Step Functions when `taskToken` is present
   Note: preserve `taskToken`, `requestId`, `requestHex`, `orchestrationType=imageEnrich`, `orchestrationStep=imageTheme`

14. `REALM scoutsRequest | SUBJECT imageUrl | ACTION request | source=scouts-image-enrich`
   `scouts`: no direct publish in this row
   `scouts2sqs`: receives message from `scoutsRequests` with `taskToken` and translates to `image/request/<hex>`
   `sqs2scouts`: generates image and may callback Step Functions when `taskToken` is present
   Note: preserve `taskToken`, `requestId`, `requestHex`, `orchestrationType=imageEnrich`, `orchestrationStep=image`

### Row Set E

Label:
`Direct internal persist flow`

15. `REALM persist | SUBJECT {hex,...patch} | ACTION persist`
   `scouts`: may emit direct persist for hide or unhide
   `scouts2sqs`: forwards `persist/persist` to `scoutsProcessing`
   `sqs2scouts`: merges patch and emits `sqs2scouts/persisted` or `sqs2scouts/hidden` to decision queue

### Exclusions

Show these as faded rows or a side note:

- `REALM scouts | SUBJECT status | ACTION runtime`
  `Does not enter scouts2sqs or sqs2scouts`

- `REALM scouts | SUBJECT reset | ACTION <summary>`
  `Dropped by scouts2sqs on the SQS path`

## Source References

- `scouts/lambdas/scouts/docs/ADMIN-TO-SCOUTSREQUESTS-MAPPING.md`
- `scouts/lambdas/scouts2sqs/function/scouts2sqs.mjs`
- `scouts/lambdas/sqs2scouts/function/sqs2scouts.mjs`
- `scouts/lambdas/cloudformation/templates/scouts-image-enrich.yaml`
