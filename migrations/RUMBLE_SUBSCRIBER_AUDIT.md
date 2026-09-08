# Rumble Subscriber Intelligence — Source Audit

Scope: complete local parsing of the four supplied JSON files. No live account query, repository edit, deployment or provider mutation was performed.
Snapshot dates below are derived from each payload's `now`; upload timestamps are not treated as capture dates.

## Snapshot measurements

| File | Source | Snapshot UTC | Reported subs | Rows | Unique normalized names | Positive-amount rows | Zero-amount rows |
|---|---|---|---:|---:|---:|---:|---:|
| RUMBLE_API_OUTPUT_SAMPLE.json | user:1sl8zm (ThirdRailify) | 2026-08-31T11:08:24+00:00 | 132 | 132 | 126 | 10 | 122 |
| RUMBLE_OUTPUT_WITH_CHATS.json | user:vmzw3 (danielclancy) | 2026-08-31T11:51:06+00:00 | 33 | 33 | 33 | 1 | 32 |
| RUMBLE_OUTPUT_WITH_EVENTS.json | user:1sl8zm (ThirdRailify) | 2026-09-01T03:09:22+00:00 | 137 | 137 | 131 | 10 | 127 |
| RUMBLE_OUTPUT_WITH_RAID.json | user:1sl8zm (ThirdRailify) | 2026-09-07T02:51:46+00:00 | 122 | 122 | 116 | 11 | 111 |

## Direct observations

- The three ThirdRailify snapshots list 132, 137 and 122 subscriber records. The separate CHATS file is danielclancy, not ThirdRailify.
- The subscriber row counts equal num_subscribers in these four files, but duplicate account names exist. The latest ThirdRailify file has 122 records and 116 distinct normalized usernames.
- September 1 to September 7: 99 retained record identities, 23 added, 38 removed. All 38 removals have amount_cents=0. All ten previously observed positive-amount records remain; one new positive-amount record appears.
- The unique-name transition is different: 101 retained names, 15 added names and 30 no-longer-listed names. Missing one grant record does not always mean the person vanished.
- Positive-amount records carry 500 cents; some subscribed_on values go back to April 2025 and remain unchanged in all three ThirdRailify snapshots.
- No subscriber active flag, renewal timestamp, paid-through/expiry date, subscription ID, transaction ID or currency code is present. expires_on exists on Rants only.
- user equals username on every supplied subscriber row; no immutable subscriber ID is demonstrated.
- Zero-amount records can remain listed beyond 30 days. The files do not establish an exact 30-day, 31-day or calendar-month expiry formula.
- The recurring_subscription badge appears on many actors whose listed subscriber records all report zero. It does not establish direct payment or successful monthly billing.
- The latest gift array contains 1,143 distinct purchase-shaped rows whose quantities sum to 2,769. That equals num_gifted_subs. The gift objects contain purchaser names, not recipient mappings.
- max_num_results is 50 in all files, yet subscriber and gift arrays can be much longer. Do not truncate every collection to 50.

## Interpretation, not a provider guarantee

The behaviour is consistent with a changing membership/grant roster, including long-lived positive-amount records and approximately month-lived zero-amount records. It is not merely an append-only notification log. The files alone do not prove that every included row is an active entitlement, that every active member is included, or exactly how canceled/renewed subscriptions are represented.

## Recommended architecture

Use source-scoped validated roster snapshots plus durable record observations, observed joins/removals, timestamped subscriber-badge sightings and separately auditable operator decisions. Label current data as API-listed until the roster semantics are validated against known active and lapsed examples.

Keep presence, monetary evidence, renewal evidence and monthly Wheel eligibility as separate fields. Never synthesize recurring payments or remove an entrant solely because a subscription date is older than 30 days.

Historical imports are analytics-only and must not replay past Poll votes or Wheel awards. A failed, stale, filtered or incomplete response is not an empty roster.

## Separate external documentation review

Rumble's public Live Stream API article documents subscriber names/counts but does not define cancellation/renewal roster semantics. Its Gifted Subs article describes channel gifts as valid one month from purchase and not auto-renewing. Those general terms do not supply per-record expiry dates or recipient links in these files.

## Reproducible details

RUMBLE_SUBSCRIBER_AUDIT.json contains input hashes, full key inventory, per-file statistics, subscription set differences, badge comparisons and the latest 116-name API-listed roster. It excludes provider credentials, profile image URLs and raw chat text.
