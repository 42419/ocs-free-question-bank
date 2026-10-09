// ==UserScript==
// @name         OCS DeepSeek 网页桥接
// @namespace    local.ocs.deepseek.bridge
// @version      1.0.0
// @description  在已登录的 DeepSeek 网页处理本机 OCS 题目，无需 DeepSeek API 密钥
// @match        https://chat.deepseek.com/*
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @connect      127.0.0.1
// @connect      localhost
// @run-at       document-idle
// @noframes
// ==/UserScript==

(function () {
  'use strict';
  // Selectors verified against the signed-in DeepSeek web UI on 2026-09-22.
  const selectors = {
    input: 'textarea[placeholder*="DeepSeek"]',
    send: '[role="button"].ds-button--primary.ds-button--circle',
    answer: '.ds-assistant-message-main-content'
  };
  function parseReply(text, id) {
    const raw = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
    try {
      const value = JSON.parse(raw);
      if (!value || value.bridge_id !== id || !Array.isArray(value.answers) ||
          value.answers.some(s => typeof s !== 'string' || !s.trim()) || typeof value.explanation !== 'string') return null;
      return value;
    } catch { return null; }
  }
  async function runJob(job, ui, { now = Date.now, sleep = ms => new Promise(r => setTimeout(r, ms)), running = () => true } = {}) {
    const check = () => {
      if (!running()) throw new Error('桥接已暂停');
      if (now() >= job.deadline) throw new Error('本题超时，请检查网页后重新启动');
      ui.check();
    };
    check();
    if (ui.draft().trim()) throw new Error('输入框有草稿，请清空后重新启动桥接');
    if (!ui.isIdle()) throw new Error('网页仍在生成或发送按钮结构已变化，请检查后重试');
    ui.fill(job.prompt);
    const sendDeadline = Math.min(job.deadline, now() + 3000);
    while (!ui.canSend()) {
      check();
      if (now() >= sendDeadline) throw new Error('未能启用发送按钮，请检查网页');
      await sleep(50);
    }
    check();
    ui.clickSend(); // Never retry a send: an uncertain send pauses the bridge.
    const ackDeadline = Math.min(job.deadline, now() + 8000);
    while (ui.draft().trim()) {
      check();
      if (now() >= ackDeadline) throw new Error('网页未确认发送，请手动检查，避免重复发送');
      await sleep(100);
    }
    const conversationUrl = ui.url();
    let stable = '', stableSince = 0;
    while (true) {
      check();
      if (ui.url() !== conversationUrl) throw new Error('对话页面已切换，桥接暂停以避免串题');
      const result = ui.replies().map(text => parseReply(text, job.id)).find(value => value !== null);
      if (result && ui.isIdle()) {
        const current = JSON.stringify(result);
        if (current !== stable) { stable = current; stableSince = now(); }
        else if (now() - stableSince >= 300) return result;
      } else { stable = ''; }
      await sleep(150);
    }
  }
  function createDomAdapter(doc) {
    const visible = selector => [...doc.querySelectorAll(selector)].filter(e => e.getClientRects().length);
    const one = selector => {
      const elements = visible(selector);
      if (elements.length !== 1) throw new Error('无法唯一定位网页控件，请确认已登录，关闭弹窗或检查网页是否改版');
      return elements[0];
    };
    const disabled = e => e.disabled || e.getAttribute('aria-disabled') === 'true' || e.classList.contains('ds-button--disabled');
    return {
      check: () => {
        if (doc.location.pathname.includes('sign_in')) throw new Error('请先登录 DeepSeek');
        one(selectors.input);
      },
      draft: () => one(selectors.input).value,
      isIdle: () => {
        const buttons = visible(selectors.send);
        return buttons.length === 1 && disabled(buttons[0]) && !buttons[0].querySelector('.ds-loading') && !one(selectors.input).value.trim();
      },
      fill: text => {
        const element = one(selectors.input);
        const win = doc.defaultView;
        Object.getOwnPropertyDescriptor(win.HTMLTextAreaElement.prototype, 'value').set.call(element, text);
        element.dispatchEvent(new win.Event('input', { bubbles: true }));
      },
      canSend: () => {
        const buttons = visible(selectors.send);
        return buttons.length === 1 && !disabled(buttons[0]);
      },
      clickSend: () => one(selectors.send).click(),
      replies: () => visible(selectors.answer).slice(-3).flatMap(e => {
        const blocks = [...e.querySelectorAll('pre')];
        return blocks.length ? blocks.map(block => block.querySelector('code')?.textContent || block.innerText) : [e.innerText];
      }),
      url: () => doc.location.href
    };
  }
  // Node's tests import pure protocol/runner helpers; the installed userscript runs below.
  if (typeof module === 'object' && module.exports) {
    module.exports = { parseReply, runJob, createDomAdapter, selectors };
    return;
  }

  const clientId = crypto.randomUUID();
  const ui = createDomAdapter(document);
  let active = false, loop = null, heartbeat = null, heartbeatBusy = false, registered = false, stopping = null, epoch = 0;
  let address = GM_getValue('address', 'http://127.0.0.1:3000');
  let token = GM_getValue('token', '');
  const host = document.createElement('div');
  host.style.cssText = 'position:fixed;right:16px;bottom:18px;z-index:2147483647';
  const root = host.attachShadow({ mode: 'closed' });
  root.innerHTML = `<style>
    :host{font:13px/1.5 system-ui;color:#142337}section{width:270px;background:#fff;border:1px solid #d4dce6;border-radius:12px;padding:14px;box-shadow:0 5px 24px #0002}strong{font-size:15px}label{display:block;margin-top:8px}input{box-sizing:border-box;width:100%;padding:6px;border:1px solid #b8c5d6;border-radius:5px}button{margin:10px 6px 0 0;padding:5px 12px;cursor:pointer}p{margin:10px 0 0;white-space:pre-wrap;overflow-wrap:anywhere}small{color:#617187}button:disabled{cursor:default}
    </style><section><strong>OCS · DeepSeek 网页桥接</strong>
    <label>本地服务地址<input id="address" spellcheck="false"></label>
    <label>API_TOKEN<input id="token" type="password" autocomplete="off"></label>
    <button id="start">启动</button><button id="pause" disabled>暂停</button>
    <p id="status">请登录并打开一个专用空白对话，然后启动。</p>
    <small>一次一题；运行时请勿手动发送或切换对话。</small></section>`;
  document.body.appendChild(host);
  const addressInput = root.querySelector('#address'), tokenInput = root.querySelector('#token');
  const start = root.querySelector('#start'), pause = root.querySelector('#pause'), status = root.querySelector('#status');
  addressInput.value = address;
  tokenInput.value = token;
  const display = message => { status.textContent = message; };
  function request(path, data = {}) {
    return new Promise((resolve, reject) => GM_xmlhttpRequest({
      method: 'POST', url: address + path, timeout: 8000,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      data: JSON.stringify({ clientId, ...data }),
      onload: response => {
        let body;
        try { body = JSON.parse(response.responseText); } catch { reject(new Error('本地服务返回了无效数据')); return; }
        if (response.status !== 200 || body.code !== 0) reject(new Error(body.message || `本地服务错误 ${response.status}`));
        else resolve(body);
      },
      onerror: () => reject(new Error('无法连接本地服务，请确认已运行 node 服务并允许油猴访问本机')),
      ontimeout: () => reject(new Error('本地服务连接超时'))
    }));
  }
  async function stop(message) {
    active = false;
    clearInterval(heartbeat);
    heartbeat = null;
    pause.disabled = true;
    display(message);
    if (stopping) return stopping;
    if (registered) {
      registered = false;
      stopping = request('/bridge/pause').catch(() => {});
      try { await stopping; } finally { stopping = null; }
    }
  }
  async function processQueue() {
    try {
      while (active) {
        ui.check();
        const { job } = await request('/bridge/poll');
        if (!active) break;
        if (job) {
          display('正在解题：' + job.input.question.slice(0,80));
          const answer = await runJob(job, ui, { running: () => active });
          if (!active) break;
          await request('/bridge/result', { id: job.id, answer });
          display('本题已返回，等待下一题。');
        }
        await new Promise(resolve => setTimeout(resolve, 200));
      }
    } catch (error) { if (active) await stop(error.message + '\n请检查网页后重新点击启动。'); }
  }
  start.addEventListener('click', async () => {
    if (loop) return;
    start.disabled = true;
    const currentEpoch = ++epoch;
    addressInput.disabled = tokenInput.disabled = true;
    loop = (async () => {
      try {
        const parsed = new URL(addressInput.value.trim());
        if (parsed.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(parsed.hostname) || parsed.username || parsed.password || parsed.search || parsed.hash || parsed.pathname !== '/') throw new Error('服务地址必须是 http://127.0.0.1:端口 或 http://localhost:端口');
        address = parsed.origin;
        token = tokenInput.value.trim();
        if (!token) throw new Error('请填写与 .env 相同的 API_TOKEN');
        ui.check();
        if (ui.draft().trim() || !ui.isIdle()) throw new Error('请清空草稿并等待当前回答完成，再启动');
        GM_setValue('address', address);
        GM_setValue('token', token);
        await request('/bridge/connect');
        registered = active = true;
        pause.disabled = false;
        display('已连接，等待 OCS 题目。');
        heartbeat = setInterval(async () => {
          if (heartbeatBusy || !active) return;
          heartbeatBusy = true;
          try { await request('/bridge/heartbeat'); }
          catch (error) { if (epoch === currentEpoch && active) await stop(error.message); }
          finally { heartbeatBusy = false; }
        }, 5000);
        await processQueue();
      } catch (error) { await stop(error.message); }
    })();
    await loop;
    if (stopping) await stopping;
    loop = null;
    start.disabled = false;
    addressInput.disabled = tokenInput.disabled = false;
  });
  pause.addEventListener('click', () => { void stop('已暂停。若网页仍在生成，请等待完成或手动停止，再重新启动。'); });
})();
