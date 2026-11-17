import test from 'node:test';
import assert from 'node:assert/strict';
const bridge = await import('./deepseek-bridge.user.js').then(m => m.default).catch(() => ({}));
test('bridge protocol and runner are implemented', () => assert.equal(typeof bridge.runJob, 'function'));
test('parses natural 「答案：X」 replies and still tolerates JSON', { skip: !bridge.parseAnswer }, () => {
  const cases = [
    ['答案：A、C', ['A', 'C']],
    ['答案：A', ['A']],
    ['**答案：对**', ['对']],
    ['答案是 A 和 C', ['A', 'C']],
    ['答案：A B C', ['A', 'B', 'C']],
    ['A、C', ['A', 'C']],
    ['答案：x = 2', ['x = 2']]
  ];
  for (const [text, answers] of cases) assert.deepEqual(bridge.parseAnswer(text)?.answers, answers, text);
  // 认不出来的短句不能当成答案塞给 OCS
  assert.equal(bridge.parseAnswer('这道题我不确定'), null);
  assert.equal(bridge.parseAnswer(''), null);
  const json = '{"answers":["2"],"explanation":"解析"}';
  assert.deepEqual(bridge.parseAnswer(json), { answers: ['2'], explanation: '解析' });
  assert.deepEqual(bridge.parseAnswer('说明\n```json\n' + json + '\n```'), { answers: ['2'], explanation: '解析' });
});
test('subjective prose answers and bracket notes are handled', { skip: !bridge.parseAnswer }, () => {
  // 主观题：模型给了一整段说明，不能拆成几十个答案塞给 OCS
  const prose = '理由：该题属于实践操作类作业，没有唯一标准答案。\n答案：按图表顺序，需填写的评估内容依次为：创新、合作、敬业、学习、责任、执着、诚信、能力、素质（需根据自身情况勾选）';
  assert.deepEqual(bridge.parseAnswer(prose, 'completion').answers, []);
  // 明确回复无法作答：直接按“无答案”回给 OCS
  assert.deepEqual(bridge.parseAnswer('无法作答：这是主观题，需要结合个人情况。', 'completion').answers, []);
  // 答案后面带括号说明，只留字母
  assert.deepEqual(bridge.parseAnswer('答案：A（选 A 因为最快）', 'single'), { answers: ['A'], explanation: '来自 DeepSeek 网页回答' });
  // 答案后面跟了第二句，不该混进答案
  assert.deepEqual(bridge.parseAnswer('答案：A、C。解析略', 'multiple').answers, ['A', 'C']);
});
test('compares versions for the two-way check', { skip: !bridge.compareVersion }, () => {
  assert.equal(bridge.compareVersion('1.2.0', '1.2.0'), 0);
  assert.ok(bridge.compareVersion('1.10.0', '1.9.0') > 0);
  assert.ok(bridge.compareVersion('1.9.9', '1.10.0') < 0);
  assert.ok(bridge.compareVersion('', '1.0.0') < 0);
});
test('explanation comes from the text before the answer line', { skip: !bridge.parseAnswer }, () => {
  assert.deepEqual(bridge.parseAnswer('2 和 3 是质数。\n答案：2、3'),
    { answers: ['2', '3'], explanation: '2 和 3 是质数。' });
});
function harness({ draft = '', answerText = '2 和 3 是质数。\n答案：2、3', existing = 0, frozen = false,
  virtualized = false, streaming = false, busyMs = 0, cancel = false, notice = '', noticeAfterSend = '',
  holdDraft = false, rotateFails = false, rootStart = false, bodyNotice = '' } = {}) {
  let now = 0, clicks = 0, sentAt = null, text = draft, baseCount = existing, newChats = 0;
  let currentNotice = notice;
  const expected = { bridge_id: 'job-1', answers: ['2', '3'], explanation: '2 和 3 是质数。' };
  const oldText = '旧题目\n答案：A';
  const ui = {
    draft: () => text,
    isIdle: () => sentAt === null ? now >= busyMs : now >= sentAt + 1000,
    fill: value => { text = value; },
    canSend: () => text.trim().length > 0,
    clickSend: () => {
      clicks++;
      // holdDraft：模拟“被限制提示拒绝、草稿留在输入框”，只有第一次发送会这样
      if (holdDraft && newChats === 0) { currentNotice = noticeAfterSend || notice; return; }
      text = '';
      sentAt = now;
      // 限制只发生在第一次发送；轮换到新会话后应当能正常作答
      currentNotice = clicks === 1 ? noticeAfterSend : '';
    },
    // virtualized：模拟长对话里消息列表虚拟化 —— 回复条数不涨，但内容会换
    count: () => (frozen || virtualized) ? baseCount : baseCount + (sentAt === null ? 0 : 1),
    replies: () => {
      if (currentNotice) return existing && sentAt === null ? [oldText] : [];
      if (sentAt === null) return baseCount ? [oldText] : [];
      if (frozen) return [oldText];
      return [streaming ? answerText.slice(0, 6 + ((now - sentAt) % 4)) : answerText];
    },
    // rootStart：模拟从首页 / 开始，发送后地址才切成 /a/chat/s/<id>（DeepSeek 首页的真实行为）
    url: () => {
      if (rootStart) return sentAt === null ? 'https://chat.deepseek.com/' : 'https://chat.deepseek.com/a/chat/s/root-conv';
      return newChats ? `https://chat.deepseek.com/a/chat/s/new-${newChats}` : 'https://chat.deepseek.com/a/chat/s/test';
    },
    noticeText: () => currentNotice,
    bodyText: () => currentNotice || bodyNotice,
    // 新开对话：清空草稿、回复与提示，并换一个会话地址
    newChat: () => {
      if (rotateFails) return false;
      newChats++;
      currentNotice = '';
      text = '';
      sentAt = null;
      baseCount = 0;
      return true;
    },
    isFreshChat: () => text === '' && (frozen || virtualized ? baseCount : baseCount + (sentAt === null ? 0 : 1)) === 0,
    check: () => {}
  };
  const options = { now: () => now, sleep: async ms => { now += ms; }, running: () => !cancel, typing: false };
  return { ui, options, expected, clicks: () => clicks, sentAt: () => sentAt, newChats: () => newChats };
}
const job = { id: 'job-1', prompt: '测试题', deadline: 10000 };
test('send exactly once and return as soon as the reply stops changing', { skip: !bridge.runJob }, async () => {
  const h = harness();
  assert.deepEqual(await bridge.runJob(job, h.ui, h.options), h.expected);
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
  assert.deepEqual(await bridge.runJob(longJob, h.ui, { ...h.options, typing: true, random: () => 0.5 }), h.expected);
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
test('answers that existed before sending and unfinished replies are not accepted', { skip: !bridge.runJob }, async () => {
  // frozen: 发送后没有新增回复，即使页面上有一条可解析的旧答案也不能用
  for (const settings of [{ frozen: true, existing: 1 }, { streaming: true }]) {
    const h = harness(settings);
    await assert.rejects(bridge.runJob(job, h.ui, h.options));
    assert.equal(h.clicks(), 1);
  }
});
test('accepts the reply even when the message list stops growing', { skip: !bridge.runJob }, async () => {
  // 长对话里消息列表虚拟化时条数不涨，但最后一条内容会换 —— 必须仍然认出来
  const h = harness({ virtualized: true, existing: 1 });
  assert.deepEqual(await bridge.runJob(job, h.ui, h.options), h.expected);
  assert.equal(h.clicks(), 1);
});
test('wait for the page to go idle before sending instead of failing', { skip: !bridge.runJob }, async () => {
  const h = harness({ busyMs: 900 });
  assert.deepEqual(await bridge.runJob(job, h.ui, h.options), h.expected);
  assert.ok(h.sentAt() >= 900);
});
test('give up when the page never becomes idle', { skip: !bridge.runJob }, async () => {
  const h = harness({ busyMs: 60000 });
  await assert.rejects(bridge.runJob(job, h.ui, h.options), /超时|仍在生成/);
  assert.equal(h.clicks(), 0);
});
test('classifies limit notices without confusing the sidebar button or model advice', { skip: !bridge.classifyNotice }, () => {
  assert.equal(bridge.classifyNotice('开启新对话'), null);
  assert.equal(bridge.classifyNotice('建议开启新对话，然后重试'), null);
  assert.equal(bridge.classifyNotice(''), null);
  assert.equal(bridge.classifyNotice('消息数量达到上限，请开启新对话').kind, 'conversation');
  assert.equal(bridge.classifyNotice('由于算力不足，已超过 72 小时的长对话暂不可用').kind, 'conversation');
  assert.equal(bridge.classifyNotice('因服务器繁忙，使用额度已达上限').kind, 'daily');
  // 两类文案同时出现时按 daily 处理：额度用尽不能靠换会话绕过
  assert.equal(bridge.classifyNotice('使用额度已达上限，请开启新对话').kind, 'daily');
  assert.equal(bridge.classifyNotice('内容超长，请删减后再试').kind, 'input');
  assert.equal(bridge.classifyNotice('你输入的信息过长，请调整后重试').kind, 'input');
});
test('detects the daily quota hint even when it sits inside the answer area', { skip: !bridge.runJob }, async () => {
  // 前端把该提示作为 SSE hint 渲染，可能落在 .ds-assistant-message-main-content 里被剔除
  const h = harness({ bodyNotice: '思考过程……使用额度已达上限，请额度恢复后再试' });
  const calls = [];
  await assert.rejects(bridge.runJob(job, h.ui, { ...h.options, notify: (...args) => calls.push(args) }),
    error => error.code === 'QUOTA_DAILY');
  assert.equal(calls.length, 1);
  assert.equal(h.clicks(), 0);
});
test('reopens the conversation and resends once when the page keeps the draft', { skip: !bridge.runJob }, async () => {
  const h = harness({ holdDraft: true, noticeAfterSend: '消息数量达到上限，请开启新对话' });
  const result = await bridge.runJob({ ...job, deadline: 200000 }, h.ui, h.options);
  assert.deepEqual(result, h.expected);
  assert.equal(h.clicks(), 2);
  assert.equal(h.newChats(), 1);
});
test('reopens a stale conversation before the first send', { skip: !bridge.runJob }, async () => {
  const h = harness({ notice: '由于算力不足，已超过 72 小时的长对话暂不可用' });
  const result = await bridge.runJob({ ...job, deadline: 200000 }, h.ui, h.options);
  assert.deepEqual(result, h.expected);
  assert.equal(h.newChats(), 1);
  assert.equal(h.clicks(), 1);
});
test('daily quota notifies once and never sends or rotates', { skip: !bridge.runJob }, async () => {
  const h = harness({ notice: '因服务器繁忙，使用额度已达上限' });
  const calls = [];
  await assert.rejects(bridge.runJob(job, h.ui, { ...h.options, notify: (...args) => calls.push(args) }),
    error => error.code === 'QUOTA_DAILY');
  assert.equal(calls.length, 1);
  assert.match(calls[0][0], /额度/);
  assert.equal(h.clicks(), 0);
  assert.equal(h.newChats(), 0);
});
test('does not resend when the draft was consumed but no answer appeared', { skip: !bridge.runJob }, async () => {
  const h = harness({ noticeAfterSend: '消息数量达到上限，请开启新对话' });
  const result = await bridge.runJob(job, h.ui, h.options);
  assert.deepEqual(result.answers, []);
  assert.match(result.explanation, /无法确认是否已发出/);
  assert.equal(h.clicks(), 1);
  assert.equal(h.newChats(), 0);
});
test('skips rotation when the remaining time is too short', { skip: !bridge.runJob }, async () => {
  const h = harness({ holdDraft: true, noticeAfterSend: '消息数量达到上限，请开启新对话' });
  const result = await bridge.runJob({ ...job, deadline: 6000 }, h.ui, h.options);
  assert.deepEqual(result.answers, []);
  assert.equal(h.clicks(), 1);
  assert.equal(h.newChats(), 0);
});
test('rotate: false keeps the old behaviour of skipping instead of resending', { skip: !bridge.runJob }, async () => {
  const h = harness({ holdDraft: true, noticeAfterSend: '消息数量达到上限，请开启新对话' });
  const result = await bridge.runJob({ ...job, deadline: 200000 }, h.ui, { ...h.options, limits: { ...bridge.LIMITS, rotate: false } });
  assert.deepEqual(result.answers, []);
  assert.equal(h.clicks(), 1);
  assert.equal(h.newChats(), 0);
});
test('waits for the conversation URL to settle after sending from the home page', { skip: !bridge.runJob }, async () => {
  const h = harness({ rootStart: true });
  const result = await bridge.runJob({ ...job, deadline: 200000 }, h.ui, h.options);
  assert.deepEqual(result, h.expected);
  assert.equal(h.clicks(), 1);
});
test('reports a rotation failure instead of resending into the same conversation', { skip: !bridge.runJob }, async () => {
  const h = harness({ holdDraft: true, noticeAfterSend: '消息数量达到上限，请开启新对话', rotateFails: true });
  const result = await bridge.runJob({ ...job, deadline: 200000 }, h.ui, h.options);
  assert.deepEqual(result.answers, []);
  assert.equal(result.rotateFailed, true);
  assert.equal(h.clicks(), 1);
  assert.equal(h.newChats(), 0);
});
