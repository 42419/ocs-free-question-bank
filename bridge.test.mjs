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
  // 模型常会在 JSON 前后加说明文字，必须能从整段文本里切出对象
  assert.deepEqual(bridge.parseReply('好的，答案如下：\n```json\n' + JSON.stringify(result) + '\n```\n希望有帮助', 'job-1'), result);
  assert.deepEqual(bridge.parseReply('前面的废话 {"a":1} 中间 ' + JSON.stringify(result), 'job-1'), result);
});
function harness({ draft = '', replyId = 'job-1', streaming = false, busyMs = 0, cancel = false } = {}) {
  let now = 0, clicks = 0, sentAt = null, text = draft;
  const result = { bridge_id: replyId, answers: ['2'], explanation: '解析' };
  const full = JSON.stringify(result);
  const ui = {
    draft: () => text,
    isIdle: () => sentAt === null ? now >= busyMs : now >= sentAt + 1000,
    fill: value => { text = value; },
    canSend: () => text.trim().length > 0,
    clickSend: () => { clicks++; text = ''; sentAt = now; },
    replies: () => sentAt === null ? [] : [streaming ? full.slice(0, 12 + ((now - sentAt) % 3)) : full],
    url: () => 'https://chat.deepseek.com/a/chat/s/test',
    check: () => {}
  };
  const options = { now: () => now, sleep: async ms => { now += ms; }, running: () => !cancel, typing: false };
  return { ui, options, result, clicks: () => clicks, sentAt: () => sentAt };
}
const job = { id: 'job-1', prompt: '测试题', deadline: 10000 };
test('send exactly once and return as soon as the reply stops changing', { skip: !bridge.runJob }, async () => {
  const h = harness();
  assert.deepEqual(await bridge.runJob(job, h.ui, h.options), h.result);
  assert.equal(h.clicks(), 1);
  // 只等回复稳定 600ms，不等网页的“生成中”状态结束（实测可晚 90 秒）
  assert.ok(h.options.now() >= 600, `waited ${h.options.now()}ms`);
  assert.ok(h.options.now() < 2000, `waited ${h.options.now()}ms for an already complete answer`);
});
test('types the prompt in chunks with jitter instead of pasting it in one shot', { skip: !bridge.runJob }, async () => {
  const h = harness();
  let fills = 0;
  const fill = h.ui.fill;
  h.ui.fill = value => { fills++; fill(value); };
  const longJob = { ...job, prompt: '题干'.repeat(80) };
  assert.deepEqual(await bridge.runJob(longJob, h.ui, { ...h.options, typing: true, random: () => 0.5 }), h.result);
  assert.ok(fills >= 10, `分片写入次数 ${fills}`);
  assert.equal(h.clicks(), 1);
});
test('do not overwrite a draft or send cancelled tasks', { skip: !bridge.runJob }, async () => {
  for (const settings of [{ draft: '用户草稿' }, { cancel: true }]) {
    const h = harness(settings);
    await assert.rejects(bridge.runJob(job, h.ui, h.options));
    assert.equal(h.clicks(), 0);
  }
});
test('stale answers and unfinished replies are not accepted', { skip: !bridge.runJob }, async () => {
  for (const settings of [{ replyId: 'old-job' }, { streaming: true }]) {
    const h = harness(settings);
    await assert.rejects(bridge.runJob(job, h.ui, h.options));
    assert.equal(h.clicks(), 1);
  }
});
test('wait for the page to go idle before sending instead of failing', { skip: !bridge.runJob }, async () => {
  const h = harness({ busyMs: 900 });
  assert.deepEqual(await bridge.runJob(job, h.ui, h.options), h.result);
  assert.ok(h.sentAt() >= 900);
});
test('give up when the page never becomes idle', { skip: !bridge.runJob }, async () => {
  const h = harness({ busyMs: 60000 });
  await assert.rejects(bridge.runJob(job, h.ui, h.options), /超时|仍在生成/);
  assert.equal(h.clicks(), 0);
});
