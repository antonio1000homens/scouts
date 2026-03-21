# Scouts Request Pipeline

This document maps:

1. requests received by `scouts`
2. messages published by `scouts` to `scoutsRequests`
3. how `scouts2sqs` consumes those messages and republishes to `scoutsProcessing`

The current source of truth is the Lambda code, not the older flow notes.

## Queue wiring

- `scouts` can send to `scoutsRequests`: `lambdas/cloudformation/templates/scouts.yaml`
- `scouts2sqs` is triggered by `scoutsRequests` and can send to `scoutsProcessing`: `lambdas/cloudformation/templates/scouts2sqs.yaml`
- `sqs2scouts` is triggered by `scoutsProcessing`: `lambdas/cloudformation/templates/sqs2scouts.yaml`
- `scoutsDecision` is not a trigger for `scouts`. Keep `scoutsDecision -> scouts` unmapped to avoid feedback loops.

## Diagram

```mermaid
flowchart LR
    A["Caller -> scouts lambda"] --> B{"Request type in scouts"}

    B -->|"scheduled/admin run finds new or stale HEX"| Q1["scoutsRequests\n{ realm: scoutsRequest, action: new, subject: full event object }"]
    B -->|"broken image repair"| Q2["scoutsRequests\n{ realm: scoutsRequest, action: repair, subject: full event object }"]
    B -->|"admin requeue"| Q3["scoutsRequests\n{ realm: scoutsRequest, action: new, subject: full event object }"]
    B -->|"admin persist metadata"| Q4["scoutsRequests\n{ realm: persist, action: persist, subject: full event object }"]
    B -->|"admin hide"| Q5["scoutsRequests\n{ realm: persist, action: hidden, subject: full event object }"]
    B -->|"admin unhide"| Q6["scoutsRequests\n{ realm: persist, action: persist, subject: full event object }"]
    B -->|"admin generate tagline"| Q7["scoutsRequests\n{ realm: scoutsRequest, action: request, subject: tagline, hexId: <hex> }"]
    B -->|"admin generate image theme"| Q8["scoutsRequests\n{ realm: scoutsRequest, action: request, subject: imageTheme, hexId: <hex> }"]
    B -->|"admin persist tagline"| Q12["scoutsRequests\n{ realm: scoutsRequest, action: persist, subject: tagline, hexId: <hex>, tagline: <value> }"]
    B -->|"admin persist image theme"| Q13["scoutsRequests\n{ realm: scoutsRequest, action: persist, subject: imageTheme, hexId: <hex>, imageTheme: <value> }"]
    B -->|"admin generate image URL"| Q9["scoutsRequests\n{ realm: scoutsRequest, action: request, subject: imageUrl, hexId: <hex> }"]
    B -->|"admin persist image URL"| Q14["scoutsRequests\n{ realm: scoutsRequest, action: persist, subject: imageUrl, hexId: <hex>, imageUrl: <value> }"]
    B -->|"reset removed events"| Q10["scoutsRequests\n{ realm: scouts, subject: reset, action: removed-events summary }"]

    C["sqs2scouts callback path\nno direct SQS trigger into scouts"] -->|"HEX still incomplete"| Q11["no requeue from callback path"]

    subgraph D["scouts2sqs consuming scoutsRequests"]
        Q1 --> E{"subject completeness"}
        Q2 --> E
        Q3 --> E
        Q11 --> E

        E -->|"tagline missing"| P1["scoutsProcessing\n{ realm: tagline, action: request, subject: hex }"]
        E -->|"image.theme missing"| P2["scoutsProcessing\n{ realm: imageTheme, action: request, subject: hex }"]
        E -->|"image.url missing"| P3["scoutsProcessing\n{ realm: image, action: request, subject: hex }"]
        E -->|"complete already"| X1["no publish"]

        Q4 --> P4["scoutsProcessing\n{ realm: persist, action: persist, subject: full event object }"]
        Q5 --> P5["scoutsProcessing\n{ realm: persist, action: hidden, subject: full event object }"]
        Q6 --> P4
        Q7 --> P1
        Q8 --> P2
        Q12 --> P4
        Q13 --> P4
        Q9 --> P6["scoutsProcessing\n{ realm: image, action: request, subject: hex }"]
        Q14 --> P4
        Q10 --> X2["dropped by scouts2sqs\nunsupported realm=scouts"]
    end
```

## Scouts input to scoutsRequests mapping

| `scouts` input case | Condition in `scouts.mjs` | Message published to `scoutsRequests` |
| --- | --- | --- |
| Scheduled or admin run finds a new event needing enrichment | Event processing collects a new HEX notification | `{ realm: "scoutsRequest", action: "new", subject: <full event object> }` |
| Scheduled or admin run finds a stale threshold event | Retry path for stuck HEX files | `{ realm: "scoutsRequest", action: "new", subject: <full event object> }` |
| Broken image repair | Broken image detected in agenda or HEX files | `{ realm: "scoutsRequest", action: "repair", subject: <full event object> }` |
| Admin requeue | `realm=scouts`, `action=requeue` | `{ realm: "scoutsRequest", action: "new", subject: <full event object> }` |
| Admin persist metadata | `realm=scouts`, `action=persist` | `{ realm: "persist", action: "persist", subject: <full event object> }` |
| Admin hide | `realm=scouts`, `action=hide|hidden` | `{ realm: "persist", action: "hidden", subject: <full event object> }` |
| Admin unhide | `realm=scouts`, `action=unhide|show` | `{ realm: "persist", action: "persist", subject: <full event object> }` |
| Admin persist tagline | `realm=scouts`, `action=persistTagline|persist`, subject token resolves to `tagline` | `{ realm: "scoutsRequest", action: "persist", subject: "tagline", hexId: <hex>, tagline: <value> }` |
| Admin persist image theme | `realm=scouts`, `action=persistImageTheme|persist`, subject token resolves to `imageTheme` | `{ realm: "scoutsRequest", action: "persist", subject: "imageTheme", hexId: <hex>, imageTheme: <value> }` |
| Admin persist image URL | `realm=scouts`, `action=persistImageUrl|persist`, subject token resolves to `imageUrl` | `{ realm: "scoutsRequest", action: "persist", subject: "imageUrl", hexId: <hex>, imageUrl: <value> }` |
| Admin generate tagline | `realm=scouts`, `action=generate|request`, subject token resolves to `tagline` | `{ realm: "scoutsRequest", action: "request", subject: "tagline", hexId: <hex> }` |
| Admin generate image theme | `realm=scouts`, `action=generate|request`, subject token resolves to `imageTheme` | `{ realm: "scoutsRequest", action: "request", subject: "imageTheme", hexId: <hex> }` |
| Admin generate image URL | `realm=scouts`, `action=generate|request`, subject token resolves to `imageUrl` | `{ realm: "scoutsRequest", action: "request", subject: "imageUrl", hexId: <hex> }` |
| Reset cleanup notification | Reset flow removes event files | `{ realm: "scouts", subject: "reset", action: <removed-events summary> }` |
| `sqs2scouts` callback for incomplete persisted HEX | `realm=sqs2scouts`, `action=persisted`, HEX still incomplete | No requeue from callback path |

## scouts2sqs mapping from scoutsRequests to scoutsProcessing

| Consumed from `scoutsRequests` | `scouts2sqs` behavior | Published to `scoutsProcessing` |
| --- | --- | --- |
| `{ realm: "scoutsRequest", action: "new|retry|repair", subject: <full event object> }` and no tagline | Derives missing stage from subject completeness | `{ realm: "tagline", action: "request", subject: <hex> }` |
| `{ realm: "scoutsRequest", action: "new|retry|repair", subject: <full event object> }` and tagline exists but `image.theme` missing | Derives missing stage from subject completeness | `{ realm: "imageTheme", action: "request", subject: <hex> }` |
| `{ realm: "scoutsRequest", action: "new|retry|repair", subject: <full event object> }` and tagline plus stored theme exist but `image.url` missing | Derives missing stage from subject completeness | `{ realm: "image", action: "request", subject: <hex> }` |
| `{ realm: "scoutsRequest", action: "new|retry|repair", subject: <full event object> }` and subject is already complete | Stops | no publish |
| `{ realm: "scoutsRequest", action: "request", subject: "tagline", hexId: <hex> }` | Field-level translation | `{ realm: "tagline", action: "request", subject: <hex> }` |
| `{ realm: "scoutsRequest", action: "request", subject: "imageTheme", hexId: <hex> }` | Field-level translation | `{ realm: "imageTheme", action: "request", subject: <hex> }` |
| `{ realm: "scoutsRequest", action: "request", subject: "imagePrompt", hexId: <hex> }` | Compatibility alias for derived image-generation prompt | `{ realm: "imageTheme", action: "request", subject: <hex> }` |
| `{ realm: "scoutsRequest", action: "request", subject: "imageUrl", hexId: <hex> }` | Field-level translation | `{ realm: "image", action: "request", subject: <hex> }` |
| `{ realm: "scoutsRequest", action: "persist", subject: "tagline", hexId: <hex>, tagline: <value> }` | Field-level translation | `{ realm: "persist", action: "persist", subject: { hexId: <hex>, tagline: <value> } }` |
| `{ realm: "scoutsRequest", action: "persist", subject: "imageTheme", hexId: <hex>, imageTheme: <value> }` | Field-level translation | `{ realm: "persist", action: "persist", subject: { hexId: <hex>, imageTheme: <value> } }` |
| `{ realm: "scoutsRequest", action: "persist", subject: "imagePrompt", hexId: <hex>, imagePrompt: <value> }` | Compatibility alias normalized onto the stored theme field | `{ realm: "persist", action: "persist", subject: { hexId: <hex>, imageTheme: <value> } }` |
| `{ realm: "scoutsRequest", action: "persist", subject: "imageUrl", hexId: <hex>, imageUrl: <value> }` | Field-level translation | `{ realm: "persist", action: "persist", subject: { hexId: <hex>, imageUrl: <value> } }` |
| `{ realm: "persist", action: "persist", subject: <full event object> }` | Allowed realm pass-through | same payload to `scoutsProcessing` |
| `{ realm: "persist", action: "hidden", subject: <full event object> }` | Allowed realm pass-through | same payload to `scoutsProcessing` |
| `{ realm: "tagline", action: "request", subject: <hex> }` | Allowed realm pass-through | same payload to `scoutsProcessing` |
| `{ realm: "imageTheme", action: "request", subject: <hex> }` | Allowed realm pass-through | same payload to `scoutsProcessing` |
| `{ realm: "imagePrompt", action: "request", subject: <hex> }` | Allowed compatibility alias pass-through | same payload to `scoutsProcessing` |
| `{ realm: "image", action: "request", subject: <hex> }` | Allowed realm pass-through | same payload to `scoutsProcessing` |

## Note on `imageTheme` vs `imagePrompt`

- `imageTheme` is the stored field on the event metadata.
- `imagePrompt` is still used in compatibility code and prompt-building paths as a derived prompt alias.
- `imagePrompt` is not intended to be stored as a persisted event field.
| `{ realm: "scouts", subject: "reset", action: <removed-events summary> }` | Unsupported realm | dropped |

## Relevant source locations

- `lambdas/cloudformation/templates/scouts.yaml`
- `lambdas/cloudformation/templates/scouts2sqs.yaml`
- `lambdas/cloudformation/templates/sqs2scouts.yaml`
- `lambdas/scouts/function/scouts.mjs`
- `lambdas/scouts/sqs/scouts2sqs/function/scouts2sqs.mjs`

## Guardrail

Never add a Lambda event source mapping from `scoutsDecision` to `scouts`.

Allowed queue triggers:
- `scoutsRequests -> scouts2sqs`
- `scoutsProcessing -> sqs2scouts`

Disallowed trigger:
- `scoutsDecision -> scouts`

`scoutsDecision` may still be used as a notification queue for auditing or external consumers, but not as an automatic input back into `scouts`.
