import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createServer } from './server.mjs';
const question = { question: '哪些是质数？', options: '2\n3\n4', type: 'multiple' };
const answer = id => ({ bridge_id: id, answers: ['2', '3'], explanation: '质数只有两个正因数。' });
const tick = () => new Promise(resolve => setTimeout(resolve, 10));
test('OCS 4.15 and 5.1 unauthenticated HEAD probes return 200 without queuing a question', async t => {
  const { base } = await fixture(t);
  for (const path of ['/', '/?t=1790049000000', '/search?t=1791532800000']) {
    const response = await fetch(base + path, { method: 'HEAD' });
    assert.equal(response.status, 200);
    assert.equal(await response.text(), '');
  }
  const health = await (await fetch(base + '/health')).json();
  assert.equal(health.connected, false);
  assert.equal(health.queued, 0);
  const search = await fetch(base + '/search', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(question) });
  assert.equal(search.status, 401);
});
async function fixture(t, settings = {}) {
  const server = createServer({ token: 'test-token', ...settings });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (path, body, token = 'test-token', signal) => fetch(base + path, { method: 'POST', signal,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify(body) });
  const call = async (path, body = {}) => (await post(path, { clientId: 'browser-1', ...body })).json();
  return { base, post, call };
}
async function claim(call) {
  for (let i = 0; i < 50; i++) {
    const result = await call('/bridge/poll');
    if (result.job) return result.job;
    await tick();
  }
  assert.fail('Job was not queued');
}
test('no DeepSeek key needed; authentication and validation', async t => {
  const { base, post } = await fixture(t);
  assert.equal((await (await fetch(base + '/health')).json()).mode, 'web-bridge');
  assert.equal((await post('/search', question, 'wrong')).status, 401);
  assert.equal((await post('/search', { question: '' })).status, 400);
  assert.equal((await post('/search', { ...question, options: [1] })).status, 400);
  assert.equal((await post('/search', question)).status, 503);
  assert.equal((await post('/bridge/connect', {})).status, 400);
  assert.equal((await post('/search', { ...question, question: 'x'.repeat(40000) })).status, 413);
});
test('browser returns answer through actual HTTP and OCS handler', async t => {
  const { post, call } = await fixture(t);
  await call('/bridge/connect');
  const waiting = post('/search', question);
  const job = await claim(call);
  assert.deepEqual(job.input.options, ['2', '3', '4']);
  assert.ok(job.prompt.includes(job.id));
  assert.equal((await call('/bridge/poll')).job, null);
  await call('/bridge/result', { id: job.id, answer: answer(job.id) });
  const result = await (await waiting).json();
  assert.deepEqual(result.data, [{ question: question.question, answer: '2#3', explanation: '质数只有两个正因数。' }]);
  const [wrapper] = JSON.parse(await readFile(new URL('./ocs-config.json', import.meta.url), 'utf8'));
  assert.deepEqual(Function(wrapper.handler)()(result), [[question.question, '2#3']]);
});
test('serial queue, capacity, exclusive browser and stale replies', async t => {
  const { post, call } = await fixture(t, { maxQueue: 2 });
  await call('/bridge/connect');
  assert.equal((await post('/bridge/connect', { clientId: 'browser-2' })).status, 409);
  const first = post('/search', question);
  const a = await claim(call);
  const second = post('/search', { ...question, question: '第二题' });
  await tick();
  assert.equal((await call('/bridge/poll')).job, null);
  assert.equal((await post('/search', question)).status, 429);
  assert.equal((await call('/bridge/result', { id: 'wrong', answer: answer('wrong') })).code, 409);
  assert.equal((await post('/bridge/result', { clientId: 'browser-2', id: a.id, answer: answer(a.id) })).status, 409);
  await call('/bridge/result', { id: a.id, answer: answer(a.id) });
  assert.equal((await first).status, 200);
  const b = await claim(call);
  assert.equal(b.input.question, '第二题');
  assert.equal((await call('/bridge/result', { id: a.id, answer: answer(a.id) })).code, 409);
  await call('/bridge/result', { id: b.id, answer: { ...answer(b.id), answers: [] } });
  assert.deepEqual((await (await second).json()).data, []);
});
test('invalid answers fail search and pause bridge', async t => {
  const { post, call } = await fixture(t);
  await call('/bridge/connect');
  const waiting = post('/search', { ...question, type: 'single' });
  const job = await claim(call);
  assert.equal((await call('/bridge/result', { id: job.id, answer: answer(job.id) })).code, 502);
  assert.equal((await waiting).status, 502);
  assert.equal((await post('/search', question)).status, 503);
});
test('timeout pauses bridge and rejects late replies', async t => {
  const { post, call } = await fixture(t, { jobTimeoutMs: 80 });
  await call('/bridge/connect');
  const waiting = post('/search', question);
  const job = await claim(call);
  assert.equal((await waiting).status, 504);
  assert.equal((await call('/bridge/result', { id: job.id, answer: answer(job.id) })).code, 409);
  assert.equal((await post('/search', question)).status, 503);
});
test('manual pause cancels active and queued requests', async t => {
  const { post, call } = await fixture(t);
  await call('/bridge/connect');
  const waiting = post('/search', question);
  await claim(call);
  const pending = post('/search', question);
  await tick();
  await call('/bridge/pause', { message: '请处理验证码' });
  assert.equal((await waiting).status, 503);
  assert.equal((await pending).status, 503);
  assert.equal((await call('/bridge/poll')).code, 409);
  assert.equal((await call('/bridge/connect')).code, 0);
});
test('lost heartbeat cancels work', async t => {
  const { post, call } = await fixture(t, { heartbeatTimeoutMs: 35, monitorIntervalMs: 10 });
  await call('/bridge/connect');
  const waiting = post('/search', question);
  await claim(call);
  assert.equal((await waiting).status, 503);
  assert.equal((await call('/bridge/heartbeat')).code, 409);
});
test('OCS disconnection cancels active work', async t => {
  const { base, post, call } = await fixture(t);
  await call('/bridge/connect');
  const controller = new AbortController();
  const waiting = post('/search', question, 'test-token', controller.signal);
  const rejected = assert.rejects(waiting, { name: 'AbortError' });
  await claim(call);
  controller.abort();
  await rejected;
  for (let i = 0; i < 50; i++) {
    if (!(await (await fetch(base + '/health')).json()).connected) return;
    await tick();
  }
  assert.fail('Browser must pause after active request cancellation');
});
