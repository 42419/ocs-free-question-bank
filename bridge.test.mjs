import test from 'node:test';
import assert from 'node:assert/strict';
const bridge = await import('./deepseek-bridge.user.js').then(m => m.default).catch(() => ({}));
test('bridge protocol and runner are implemented', () => assert.equal(typeof bridge.runJob, 'function'));
test('only parse complete JSON for the current job; tolerate markdown fences', { skip: !bridge.parseReply }, () => {
  const result = { bridge_id: 'job-1', answers: ['2'], explanation: '解析' };
  assert.deepEqual(bridge.parseReply(JSON.stringify(result), 'job-1'), result);
  assert.deepEqual(bridge.parseReply('```json\n' + JSON.stringify(result) + '\n```', 'job-1'), result);
  assert.equal(bridge.parseReply(JSON.stringify(result), 'job-2'), null);
  assert.equal(bridge.parseReply('{"bridge_id":"job-1","answers":[', 'job-1'), null);
  assert.equal(bridge.parseReply('{"bridge_id":"job-1","answers":"A"}', 'job-1'), null);
});
function harness({ draft = '', replyId = 'job-1', neverFinish = false, cancel = false } = {}) {
  let now = 0, clicks = 0, sent = false, filled = false;
  const result = { bridge_id: replyId, answers: ['2'], explanation: '解析' };
  const ui = {
    draft: () => draft,
    isIdle: () => !sent || (!neverFinish && now >= 2500),
    fill: text => { draft = text; filled = true; },
    canSend: () => filled,
    clickSend: () => { clicks++; sent = true; draft = ''; },
    replies: () => sent ? [JSON.stringify(result)] : [],
    url: () => 'https://chat.deepseek.com/a/chat/s/test',
    check: () => {}
  };
  const options = { now: () => now, sleep: async ms => { now += ms; }, running: () => !cancel };
  return { ui, options, result, clicks: () => clicks };
}
const job = { id: 'job-1', prompt: '测试题', deadline: 10000 };
test('send exactly once; wait for generation to finish', { skip: !bridge.runJob }, async () => {
  const h = harness();
  assert.deepEqual(await bridge.runJob(job, h.ui, h.options), h.result);
  assert.equal(h.clicks(), 1);
  assert.ok(h.options.now() >= 1300);
});
test('do not overwrite a draft or send cancelled tasks', { skip: !bridge.runJob }, async () => {
  for (const settings of [{ draft: '用户草稿' }, { cancel: true }]) {
    const h = harness(settings);
    await assert.rejects(bridge.runJob(job, h.ui, h.options));
    assert.equal(h.clicks(), 0);
  }
});
test('stale answers and incomplete generations are not accepted', { skip: !bridge.runJob }, async () => {
  for (const settings of [{ replyId: 'old-job' }, { neverFinish: true }]) {
    const h = harness(settings);
    await assert.rejects(bridge.runJob(job, h.ui, h.options));
    assert.equal(h.clicks(), 1);
  }
});
