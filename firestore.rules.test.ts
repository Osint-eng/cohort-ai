import { describe, it } from 'vitest';
import { initializeTestEnvironment, assertFails, assertSucceeds } from '@firebase/rules-unit-testing';
import { readFileSync } from 'fs';
import { doc, getDoc, getDocs, collection, setDoc, updateDoc, deleteDoc, serverTimestamp } from 'firebase/firestore';

// Automated test suite verifying the "Dirty Dozen" security invariants against firestore.rules.
export async function runSecurityAudit() {
  const testEnv = await initializeTestEnvironment({
    projectId: 'cohort-security-test',
    firestore: {
      rules: readFileSync('firestore.rules', 'utf8'),
    },
  });

  const alice = testEnv.authenticatedContext('alice_uid', { email: 'alice@example.com', email_verified: true });
  const bob = testEnv.authenticatedContext('bob_uid', { email: 'bob@example.com', email_verified: true });
  const unverified = testEnv.authenticatedContext('unverified_uid', { email: 'fake@example.com', email_verified: false });
  const anon = testEnv.unauthenticatedContext();

  const aliceDb = alice.firestore();
  const bobDb = bob.firestore();
  const unverifiedDb = unverified.firestore();
  const anonDb = anon.firestore();

  const roomCode = 'ROOM1234';

  // Seed valid room via Alice
  await assertSucceeds(setDoc(doc(aliceDb, 'rooms', roomCode), {
    code: roomCode,
    title: 'Capstone',
    summary: 'Project summary',
    ownerId: 'alice_uid',
    nextTaskNumber: 1,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  }));

  await assertSucceeds(setDoc(doc(aliceDb, 'rooms', roomCode, 'members', 'alice_uid'), {
    uid: 'alice_uid',
    displayName: 'Alice',
    photoURL: '',
    role: 'owner',
    status: 'active',
    online: true,
    joinedAt: serverTimestamp(),
    lastSeenAt: serverTimestamp(),
  }));

  // 1. Unauthenticated read fails
  await assertFails(getDoc(doc(anonDb, 'rooms', roomCode)));
  // 2. Room list enumeration fails
  await assertFails(getDocs(collection(aliceDb, 'rooms')));
  // 3. Invalid room code fails
  await assertFails(setDoc(doc(aliceDb, 'rooms', 'bad-code'), {
    code: 'bad-code', title: 'X', summary: '', ownerId: 'alice_uid', nextTaskNumber: 1, createdAt: serverTimestamp(), updatedAt: serverTimestamp(),
  }));
  // 4. Identity spoofing on member join fails
  await assertFails(setDoc(doc(aliceDb, 'rooms', roomCode, 'members', 'bob_uid'), {
    uid: 'bob_uid', displayName: 'Bob', photoURL: '', role: 'member', online: true, joinedAt: serverTimestamp(), lastSeenAt: serverTimestamp(),
  }));
  // 5. Shadow ghost field fails
  await assertFails(setDoc(doc(aliceDb, 'rooms', 'ROOM5678'), {
    code: 'ROOM5678', title: 'X', summary: '', ownerId: 'alice_uid', nextTaskNumber: 1, isAdmin: true, createdAt: serverTimestamp(), updatedAt: serverTimestamp(),
  }));
  // 6. Non-member read/write of chat fails
  await assertFails(getDocs(collection(bobDb, 'rooms', roomCode, 'messages')));
  // 7. Sender spoofing in chat fails
  await assertFails(setDoc(doc(aliceDb, 'rooms', roomCode, 'messages', 'm1'), {
    id: 'm1', senderId: 'bob_uid', triggeredBy: 'alice_uid', senderName: 'Bob', role: 'user', text: 'hi', createdAt: serverTimestamp(),
  }));
  // 8. Fake timestamp injection fails
  await assertFails(setDoc(doc(aliceDb, 'rooms', roomCode, 'messages', 'm2'), {
    id: 'm2', senderId: 'alice_uid', triggeredBy: 'alice_uid', senderName: 'Alice', role: 'user', text: 'hi', createdAt: new Date(0),
  }));
  // 9. Room ownership hijack fails
  await assertFails(updateDoc(doc(aliceDb, 'rooms', roomCode), { ownerId: 'bob_uid', updatedAt: serverTimestamp() }));
  // 10. Invalid task status fails
  await assertFails(setDoc(doc(aliceDb, 'rooms', roomCode, 'tasks', 't1'), {
    id: 't1', title: 'Test', suggested_owner: '@Alice', owner_uid: 'alice_uid', due_date: 'Nov 20', status: 'hacked', updatedBy: 'alice_uid', createdAt: serverTimestamp(), updatedAt: serverTimestamp(),
  }));
  // 11. Unverified email spoof fails
  await assertFails(setDoc(doc(unverifiedDb, 'rooms', 'ROOM9999'), {
    code: 'ROOM9999', title: 'X', summary: '', ownerId: 'unverified_uid', nextTaskNumber: 1, createdAt: serverTimestamp(), updatedAt: serverTimestamp(),
  }));
  // 12. Immutable log mutation/deletion fails
  await assertSucceeds(setDoc(doc(aliceDb, 'rooms', roomCode, 'logs', 'l1'), {
    id: 'l1', actorId: 'alice_uid', triggeredBy: 'alice_uid', actor: 'Alice', action: 'created', task_id: 't1', note: 'init', createdAt: serverTimestamp(),
  }));
  await assertFails(deleteDoc(doc(aliceDb, 'rooms', roomCode, 'logs', 'l1')));

  await testEnv.cleanup();
}

describe('firestore.rules security audit', () => {
  it('enforces all Dirty Dozen security invariants against Firestore emulator', async () => {
    await runSecurityAudit();
  }, 30_000);
});
