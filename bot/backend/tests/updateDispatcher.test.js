import test from 'node:test';
import assert from 'node:assert/strict';
import { processUpdateBatch } from '../src/updateDispatcher.js';

const update = (id, chat) => ({
  update_id: id,
  message: { chat: { id: chat }, from: { id: chat } }
});

test('a slow receipt for one user does not block another buyer', async () => {
  const seen = [];
  let releaseSlow;
  const slow = new Promise((resolve) => { releaseSlow = resolve; });
  let releaseFast;
  const fast = new Promise((resolve) => { releaseFast = resolve; });
  const run = processUpdateBatch([update(1, 10), update(2, 20)], async (u) => {
    if (u.update_id === 1) await slow;
    seen.push(u.update_id);
    if (u.update_id === 2) releaseFast();
  }, () => {});
  await Promise.race([fast, new Promise((_, reject) => setTimeout(() => reject(new Error('fast buyer blocked')), 250))]);
  assert.deepEqual(seen, [2]);
  releaseSlow();
  await run;
  assert.deepEqual(seen, [2, 1]);
});

test('same-chat messages and callbacks stay in arrival order', async () => {
  const seen = [];
  await processUpdateBatch([
    update(1, 10),
    { update_id: 2, callback_query: { from: { id: 10 }, message: { chat: { id: 10 } } } },
    update(3, 10),
    update(4, 20)
  ], async (u) => {
    if (u.update_id === 1) await new Promise((resolve) => setTimeout(resolve, 15));
    seen.push(u.update_id);
  }, () => {});
  assert.deepEqual(seen.filter((id) => id !== 4), [1, 2, 3]);
});

test('one handler failure cannot discard subsequent updates', async () => {
  const seen = [];
  const errors = [];
  await processUpdateBatch([update(1, 10), update(2, 10), update(3, 20)], async (u) => {
    if (u.update_id === 1) throw Error('mock API error');
    seen.push(u.update_id);
  }, (u, error) => { errors.push([u.update_id, error.message]); });
  assert.deepEqual(errors, [[1, 'mock API error']]);
  assert.ok(seen.includes(2) && seen.includes(3));
});

test('concurrency is bounded even with many independent chats', async () => {
  let active = 0;
  let peak = 0;
  await processUpdateBatch(Array.from({ length: 24 }, (_, i) => update(i + 1, i + 100)), async () => {
    active++;
    peak = Math.max(peak, active);
    await new Promise((resolve) => setTimeout(resolve, 2));
    active--;
  }, () => {}, 4);
  assert.equal(peak, 4);
});
