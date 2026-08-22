import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mongoSummary, totalRowsAffected } from './statements';

test('totalRowsAffected sums only the statements that reported a count', () => {
  assert.equal(totalRowsAffected([{ rowsAffected: 3 }, { rowsAffected: 2 }]), 5);
  assert.equal(totalRowsAffected([{ rowsAffected: 4 }, { command: 'CREATE' }]), 4);
});

test('totalRowsAffected distinguishes "no count" from "zero rows"', () => {
  // undefined means the batch had nothing to report; 0 means it ran and changed nothing.
  assert.equal(totalRowsAffected([{ command: 'CREATE' }, { command: 'DROP' }]), undefined);
  assert.equal(totalRowsAffected([]), undefined);
  assert.equal(totalRowsAffected([{ rowsAffected: 0 }]), 0);
});

test('mongoSummary lifts the affected count out of a write acknowledgement', () => {
  assert.deepEqual(mongoSummary('insertOne', [{ acknowledged: true, insertedId: 'abc' }]), {
    command: 'insertOne',
    rowsAffected: 1,
  });
  assert.deepEqual(mongoSummary('insertMany', [{ insertedCount: 3 }]), {
    command: 'insertMany',
    rowsAffected: 3,
  });
  assert.deepEqual(mongoSummary('deleteMany', [{ deletedCount: 7 }]), {
    command: 'deleteMany',
    rowsAffected: 7,
  });
});

test('mongoSummary counts an upsert as an affected document', () => {
  // An upserting updateOne modifies nothing but did change the collection.
  assert.deepEqual(
    mongoSummary('updateOne', [{ matchedCount: 0, modifiedCount: 0, upsertedCount: 1 }]),
    { command: 'updateOne', rowsAffected: 1 }
  );
  assert.deepEqual(
    mongoSummary('updateMany', [{ matchedCount: 9, modifiedCount: 4, upsertedCount: 0 }]),
    { command: 'updateMany', rowsAffected: 4 }
  );
});

test('mongoSummary reports reads as rows returned, never as rows affected', () => {
  assert.deepEqual(mongoSummary('find', [{ _id: 1 }, { _id: 2 }]), {
    command: 'find',
    rowCount: 2,
  });
  assert.deepEqual(mongoSummary('aggregate', []), { command: 'aggregate', rowCount: 0 });
});
