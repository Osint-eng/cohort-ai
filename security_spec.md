# Cohort Security Specification

## 1. Data Invariants
1. **Authentication & Verified Google Email Policy**: All reads and writes require a signed-in Google account with a verified email (`request.auth != null && request.auth.token.email_verified == true`). Unverified institutional/custom accounts are explicitly blocked at both Firestore Rules and API token verification, and surfaced with clear guidance in the UI.
2. **Room Code Integrity**: Room documents are keyed strictly by 8 uppercase alphanumeric characters (`^[A-Z0-9]{8}$`). `list` on `/rooms` is disabled (`allow list: if false`) so rooms cannot be enumerated.
3. **Master Gate Membership**: Any read or write inside `/rooms/{roomCode}/messages`, `/rooms/{roomCode}/tasks`, or `/rooms/{roomCode}/logs` requires the user to be an existing member at `/rooms/{roomCode}/members/{request.auth.uid}`.
4. **Identity Binding**:
   - A member document `/rooms/{roomCode}/members/{memberId}` can only be created or updated by `request.auth.uid == memberId`, and `incoming().uid == request.auth.uid`.
   - User chat messages (`role == 'user'`) must have `senderId == request.auth.uid` and `triggeredBy == request.auth.uid`.
   - Assistant chat messages (`role == 'assistant'`) must have `senderId == 'cohort'` and `triggeredBy == request.auth.uid`.
   - Log entries must have `triggeredBy == request.auth.uid` and (`actorId == request.auth.uid` or `actorId == 'cohort'`).
5. **PII Isolation**: No email addresses, phone numbers, or sensitive user PII are stored in `/rooms`, `/members`, or `/rateLimits` documents.
6. **Temporal Integrity & Immutability**:
   - `createdAt`, `joinedAt`, `updatedAt`, `lastSeenAt` must equal `request.time` on creation/update.
   - `ownerId`, `code`, `createdAt`, `joinedAt`, `uid` are immutable after creation.
7. **Strict Schemas, Board Caps & Rate Limits**: Every document write validates exact required/allowed keys (`hasAll` + `hasOnly`), types, enums, ID patterns, string length limits, a room task sequence cap (`nextTaskNumber <= 200`), and per-user sliding-window counters at `/rateLimits/{userId}` (10 rooms / 20 AI commands per 10 minutes).

## 2. The "Dirty Dozen" Payloads (Adversarial Tests)
1. **Unauthenticated Room Read/Write**: Unauthenticated user tries to read `/rooms/ABCD1234` -> `PERMISSION_DENIED`.
2. **Room Enumeration**: Signed-in user runs a `list` query on `/rooms` -> `PERMISSION_DENIED`.
3. **Invalid Room Code Injection**: User tries to create `/rooms/bad-code` or 1.5KB room ID -> `PERMISSION_DENIED`.
4. **Identity Spoofing on Member Join**: User A creates `/rooms/ABCD1234/members/userB` -> `PERMISSION_DENIED`.
5. **Shadow Ghost Field on Room Creation**: User creates `/rooms/ABCD1234` with extra field `isAdmin: true` -> `PERMISSION_DENIED`.
6. **Non-Member Chat Read/Write**: User B (not in `/members`) tries to read or write `/rooms/ABCD1234/messages/m1` -> `PERMISSION_DENIED`.
7. **Sender Spoofing in Chat**: User A sends a `role: 'user'` message claiming `senderId: 'userB'` -> `PERMISSION_DENIED`.
8. **Fake Timestamp Injection**: User A posts a message with `createdAt` in 1999 instead of `request.time` -> `PERMISSION_DENIED`.
9. **Room Ownership Hijack**: Member B updates `/rooms/ABCD1234` changing `ownerId` to `userB` -> `PERMISSION_DENIED`.
10. **Invalid Task Status / Value Poisoning**: Member updates task `status` to `'hacked'` or 5KB string -> `PERMISSION_DENIED`.
11. **Unverified Email Spoof**: Token with `email_verified: false` tries to create a room or post a message -> `PERMISSION_DENIED`.
12. **Immutable Field Mutation on Log**: Member tries to update or delete an existing entry in `/rooms/ABCD1234/logs/{logId}` -> `PERMISSION_DENIED`.

## 3. Test Runner Reference
See `firestore.rules.test.ts` for automated verification against the Firestore Rules Emulator.
