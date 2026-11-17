// ==UserScript==
// @name         OCS DeepSeek 网页桥接
// @namespace    local.ocs.deepseek.bridge
// @author       XuanHanHan（原作者）、42419（fork 维护）
// @homepageURL  https://github.com/XuanHanHan/ocs-free-question-bank
// @source       https://github.com/XuanHanHan/ocs-free-question-bank
// @version      1.14.1
// @description  在已登录的 DeepSeek 网页处理本机 OCS 题目，无需 DeepSeek API 密钥
// @match        https://chat.deepseek.com/*
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_notification
// @connect      127.0.0.1
// @connect      localhost
// @updateURL    https://raw.githubusercontent.com/42419/ocs-free-question-bank/main/deepseek-bridge.user.js
// @downloadURL  https://raw.githubusercontent.com/42419/ocs-free-question-bank/main/deepseek-bridge.user.js
// @supportURL   https://github.com/42419/ocs-free-question-bank
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
  /** 从任意文本里切出顶层的 {...} 片段，容忍 JSON 前后的说明文字和代码围栏 */
  function jsonObjects(text) {
    const found = [];
    let depth = 0, start = -1, quoted = false, escaped = false;
    for (let i = 0; i < text.length; i++) {
      const char = text[i];
      if (quoted) {
        if (escaped) escaped = false;
        else if (char === '\\') escaped = true;
        else if (char === '"') quoted = false;
      } else if (char === '"') quoted = true;
      else if (char === '{') { if (depth === 0) start = i; depth++; }
      else if (char === '}' && depth > 0) {
        depth--;
        if (depth === 0 && start >= 0) { found.push(text.slice(start, i + 1)); start = -1; }
      }
    }
    return found;
  }
  /** 把「答案：A、C」这类自然回答拆成选项数组；顿号、逗号、斜杠、和/及都能分 */
  function splitAnswers(text) {
    const cleaned = String(text).replace(/^[\s是为：:、,，*_`]+/, '').replace(/[。．.；;\s*_`]+$/, '').trim();
    if (!cleaned) return [];
    const parts = cleaned.split(/\s*[、,，/；;]\s*|\s+和\s+|\s+及\s+/).map(part => part.trim()).filter(Boolean);
    const list = parts.length > 1 ? parts
      : (/^(?:[A-Ha-h]\s+)+[A-Ha-h]$/.test(cleaned) ? cleaned.split(/\s+/) : [cleaned]);
    return list.filter(part => part.length <= 60).slice(0, 100);
  }
  /** 只有形似答案的短句（选项字母、判断词）才允许在没有「答案：」前缀时被采纳 */
  function looksLikeAnswer(text) {
    const compact = String(text).replace(/\s+/g, '');
    return /^[A-Ha-h](?:[、,，/]*[A-Ha-h])*$/.test(compact) || /^(对|错|正确|错误|是|否|√|×)$/.test(compact);
  }
  /** 去掉「A（选 A 因为快）」这类后缀说明；只在剩余部分是选项字母/判断词时才去掉，避免误伤公式 */
  function stripNote(text) {
    const matched = String(text).match(/^(.{1,12}?)\s*[（(][^）)]*[）)]$/);
    if (!matched) return text;
    const head = matched[1].replace(/\s+/g, '');
    return /^[A-Ha-h]{1,8}$/.test(head) || /^(对|错|正确|错误)$/.test(head) ? matched[1].trim() : text;
  }
  /** 按题型限制条数与长度；模型给的是成段文字（主观题常见）时判为没有可靠答案 */
  function sanitizeAnswers(answers, type) {
    const [maxCount, maxLength] = { single: [1, 24], judgement: [1, 12], multiple: [8, 24], completion: [6, 80] }[type] || [8, 40];
    const list = answers.map(stripNote).filter(item => item && item.length <= maxLength && !/[。！？!?]/.test(item));
    return list.length > maxCount ? [] : list;
  }
  // 2026-11 起 DeepSeek 对 App/网页版 C 端限额：会话级限制可以自愈，每日额度必须熔断
  const LIMITS = {
    rotate: true,                   // 会话级限制时自动新开对话
    maxRotationsPerJob: 1,          // 单题最多轮换次数
    minRemainingMsForRotate: 35000, // 剩余时间不够打字+生成就不折腾，直接回空答案
    scanIntervalMs: 700,            // 限制文案的采样间隔（body.innerText 不便宜）
    notifyDailyQuota: true,
    notifyThrottleMs: 600000        // 同一进程 10 分钟内只通知一次
  };
  // 只收窄到明确的系统文案：侧边栏的“开启新对话”按钮一直都在，泛匹配会把正常页面判成超限
  const NOTICE_PATTERNS = {
    daily: [/使用额度已达上限/, /额度已达上限/, /额度已用完/, /配额已用尽/, /usage limit reached/i, /daily (?:usage )?(?:limit|quota)/i],
    conversation: [/消息数量(?:已达|达到)上限/, /请开启新对话/, /长对话暂不可用/, /该对话暂不可用/, /超过\s*\d+\s*(?:小时|天)的长对话/, /导出(?:该)?对话/, /会话(?:数量)?(?:已达|达到)上限/],
    input: [/内容超长/, /请删减后再试/, /输入过长/, /信息过长/]
  };
  function noticeExcerpt(text, patterns) {
    for (const pattern of patterns) {
      const hit = String(text).match(pattern);
      if (hit) {
        const start = Math.max(0, hit.index - 16);
        return String(text).slice(start, hit.index + hit[0].length + 48).replace(/\s+/g, ' ').trim();
      }
    }
    return '';
  }
  /** 判定页面文案属于哪一类限制；daily 优先于会话级与输入级，避免把熔断当成可重试 */
  function classifyNotice(text) {
    const daily = noticeExcerpt(text, NOTICE_PATTERNS.daily);
    if (daily) return { kind: 'daily', text: daily };
    const conversation = noticeExcerpt(text, NOTICE_PATTERNS.conversation);
    if (conversation) return { kind: 'conversation', text: conversation };
    const input = noticeExcerpt(text, NOTICE_PATTERNS.input);
    if (input) return { kind: 'input', text: input };
    return null;
  }
  const QUOTA_MESSAGE = 'DeepSeek 今日使用额度已达上限（每日限额），请次日再试';
  // SSE 的额度提示可能渲染在回答区里，被“剔除回答”后扫不到：再用整句在全页文本里兜底
  const EXACT_DAILY = /使用额度已达上限[，,]\s*请额度恢复后再试/;
  function exactDailyNotice(text) {
    const hit = String(text || '').match(EXACT_DAILY);
    return hit ? { kind: 'daily', text: hit[0] } : null;
  }
  function quotaError(detail) {
    const error = new Error(QUOTA_MESSAGE + (detail ? '：' + detail : ''));
    error.code = 'QUOTA_DAILY';
    return error;
  }
  /** 解析网页回答：优先按自然语言的「答案：X」取，模型仍回 JSON 时也能兼容 */
  function parseAnswer(text, type = 'unknown') {
    const raw = String(text || '').trim();
    if (!raw) return null;
    for (const candidate of [raw, ...jsonObjects(raw)]) {
      let value;
      try { value = JSON.parse(candidate.trim()); } catch { continue; }
      if (value && Array.isArray(value.answers) && value.answers.every(s => typeof s === 'string' && s.trim()) &&
          typeof value.explanation === 'string') {
        return { answers: value.answers, explanation: value.explanation };
      }
    }
    const lines = raw.split('\n').map(line => line.replace(/[*_`]/g, '').trim()).filter(Boolean);
    const marker = lines.findIndex(line => /答\s*案\s*(?:是|[:：]|$)/.test(line));
    // 完全没有「答案」、又是在说做不了/没有标准答案：直接按“无答案”回给 OCS，别让它干等
    if (marker < 0 && /无法作答|无法确定|无法判断|没有(唯一|标准)答案|需要你(自己|独立)|主观题/.test(raw)) {
      return { answers: [], explanation: raw.slice(0, 12000) };
    }
    const single = marker < 0 && lines.length === 1 && lines[0].length <= 60 && looksLikeAnswer(lines[0]) ? lines[0] : '';
    let answerText = single, before = '';
    if (marker >= 0) {
      // 「答案」可能出现在整段回答的中间（一行里先写理由再写答案），把同一行前半段也算进解析
      const matched = lines[marker].match(/答\s*案\s*(?:是|[:：])?\s*/);
      answerText = lines[marker].slice(matched.index + matched[0].length);
      before = [...lines.slice(0, marker), lines[marker].slice(0, matched.index).trim()].filter(Boolean).join(' ').trim();
      // 只取第一句，后面的「解析…」不要混进答案
      answerText = answerText.split(/[。！？]/)[0];
    }
    const answers = sanitizeAnswers(splitAnswers(answerText), type);
    if (!answers.length) {
      // 有「答案：」但内容是成段说明 → 明确回“没答案”，比塞一堆错答案好
      return marker >= 0 ? { answers: [], explanation: before.slice(0, 12000) || raw.slice(0, 12000) } : null;
    }
    const explanation = before.slice(0, 12000) || '来自 DeepSeek 网页回答';
    return { answers, explanation };
  }
  // 两端用同一套版本号：与 package.json 和脚本头部的 @version 保持一致（改的时候三处一起改）
  const VERSION = '1.14.1';
  /** 版本比较：两端互查时用，缺省段按 0 处理 */
  function compareVersion(a, b) {
    const parts = value => String(value || '').split(/[^\d]+/).filter(Boolean).map(Number);
    const left = parts(a), right = parts(b);
    for (let i = 0; i < Math.max(left.length, right.length); i++) {
      const x = left[i] || 0, y = right[i] || 0;
      if (x !== y) return x - y;
    }
    return 0;
  }
  // node 端至少要是这个版本，缺了 /blob、body.token 等能力会静默降级
  const MIN_SERVER_VERSION = VERSION;
  // 人工节奏参数：DeepSeek 对短时间内连续提问会触发风控，这里把整套动作放慢；需要更慢/更快直接改这些数
  const PACE = {
    beforeType: [600, 1400],    // 敲字前的停顿（毫秒）
    beforeSend: [400, 1000],    // 发送前的停顿
    chunk: [4, 9],              // 每片敲入的字数
    chunkGap: [60, 120],        // 两片之间的间隔，约等于每秒 8-14 字
    cooldown: [6000, 12000],    // 两题之间的冷却
    longCooldown: [20000, 28000], // 每 longEvery 题来一次长冷却，模拟看题/翻页
    longEvery: 10
  };
  const jitter = ([min, max], random = Math.random) => min + random() * (max - min);
  function nextCooldown(answered, random = Math.random, pace = PACE) {
    if (!answered) return 0;
    return jitter(answered % pace.longEvery === 0 ? pace.longCooldown : pace.cooldown, random);
  }
  async function runJob(job, ui, { now = Date.now, sleep = ms => new Promise(r => setTimeout(r, ms)), running = () => true,
    typing = true, random = Math.random, pace = PACE, blobBase = '', limits = LIMITS,
    notify = () => {}, alive = () => true } = {}) {
    const check = () => {
      if (!running()) throw new Error('桥接已暂停');
      if (now() >= job.deadline) throw new Error('本题超时，请检查网页后重新启动');
      ui.check();
    };
    const remaining = () => job.deadline - now();
    const readNotice = () => {
      if (typeof ui.noticeText !== 'function') return null;
      const stripped = classifyNotice(ui.noticeText());
      if (stripped) return stripped;
      return typeof ui.bodyText === 'function' ? exactDailyNotice(ui.bodyText()) : null;
    };
    const emptyAnswer = (explanation, rotateFailed = false) => ({ bridge_id: job.id, answers: [], explanation,
      ...(rotateFailed ? { rotateFailed: true } : {}) });
    // 把服务端下载好的图片做成 File 塞进网页的上传控件，等同于用户点回形针选图；找不到控件就退化成纯文字
    const attachImages = async images => {
      const input = ui.fileInput();
      if (!input || !blobBase) return 0;
      const transfer = new DataTransfer();
      // 单文件控件塞多张会被浏览器截断甚至报错，按控件能力截断
      for (const image of images.slice(0, input.multiple ? images.length : 1)) {
        try {
          const response = await fetch(`${blobBase}/blob/${image.id}`, { signal: AbortSignal.timeout(8000) });
          if (!response.ok) continue;
          transfer.items.add(new File([await response.blob()], image.name, { type: image.type }));
        } catch { /* 单张失败不影响整题 */ }
      }
      if (!transfer.files.length) return 0;
      input.files = transfer.files;
      input.dispatchEvent(new Event('change', { bubbles: true }));
      return transfer.files.length;
    };
    // 会话级限制：点侧边栏“开启新对话”。只走 SPA —— 整页跳转会让油猴脚本重新初始化，桥接静默掉线
    const rotate = async () => {
      const before = ui.url();
      if (typeof ui.newChat !== 'function' || !ui.newChat()) {
        throw new Error('未找到“开启新对话”按钮，请手动新开对话后重新启动桥接');
      }
      const rotateDeadline = Math.min(job.deadline, now() + 6000);
      // 有些会话新建后地址不变，等两秒确认草稿与回复都已清空再继续
      const acceptAt = now() + 2000;
      while (true) {
        check();
        if (!alive()) throw new Error('页面已刷新，桥接已停止，请重新启动');
        const fresh = typeof ui.isFreshChat === 'function' && ui.isFreshChat();
        if (fresh && ui.url() !== before) return;
        if (fresh && now() >= acceptAt) return;
        if (now() >= rotateDeadline) throw new Error('新开对话后页面未就绪，请手动新建对话后重新启动桥接');
        await sleep(120);
      }
    };
    const waitIdle = async () => {
      // 上一题可能还在收尾：先等页面空闲再发，避免把新题塞进正在生成的对话
      const idleDeadline = Math.min(job.deadline, now() + 60000);
      while (!ui.isIdle()) {
        check();
        if (now() >= idleDeadline) throw new Error('网页仍在生成，等待 60 秒后放弃，请检查网页再重新启动');
        await sleep(150);
      }
    };
    let lastScan = 0;
    // 发送一题并等待网页确认接收；被“限制提示 + 保留草稿”拒绝时抛 SEND_BLOCKED，交给调用方决定是否换会话
    const submit = async () => {
      if (ui.draft().trim()) throw new Error('输入框有草稿，请清空后重新启动桥接');
      await waitIdle();
      // 记下当前已有的回复条数与最后一条内容，之后用来判断哪条是这一题的新回答
      const baseline = ui.count();
      const baselineText = ui.replies().slice(-1)[0] || '';
      // 图片先挂上去，上传和打字并行
      if (job.images?.length) await attachImages(job.images);
      if (typing) {
        // 一次 setValue 写满会和真人操作差别太大：停顿一下，再按随机长度分片敲进去
        await sleep(jitter(pace.beforeType, random));
        const step = Math.max(pace.chunk[0], Math.ceil(job.prompt.length / 80));
        let typed = '';
        while (typed.length < job.prompt.length) {
          const size = Math.max(2, Math.round(step * (0.6 + random() * 0.8)));
          typed = job.prompt.slice(0, typed.length + size);
          ui.fill(typed);
          check();
          await sleep(jitter(pace.chunkGap, random));
        }
        if (ui.draft() !== job.prompt) ui.fill(job.prompt);
        await sleep(jitter(pace.beforeSend, random));
      } else {
        ui.fill(job.prompt);
      }
      // 图片上传是异步的，给缩略图/上传收尾留点时间再点发送
      if (job.images?.length) await sleep(1200 + random() * 800);
      // 带图时上传期间发送按钮会一直灰着，给更长的等待
      const sendDeadline = Math.min(job.deadline, now() + (job.images?.length ? 20000 : 3000));
      while (!ui.canSend()) {
        check();
        if (now() >= sendDeadline) throw new Error('未能启用发送按钮，请检查网页');
        await sleep(50);
      }
      check();
      ui.clickSend(); // Never retry a send: an uncertain send pauses the bridge.
      const sentAt = now();
      const ackDeadline = Math.min(job.deadline, now() + 8000);
      while (ui.draft().trim()) {
        check();
        // 限额提示常常在点击后立刻出现、同时草稿留在输入框；只有确认“没发出去”才允许换会话重发
        if (now() - lastScan >= limits.scanIntervalMs) {
          lastScan = now();
          const notice = readNotice();
          if (notice?.kind === 'daily') {
            if (limits.notifyDailyQuota) notify(QUOTA_MESSAGE, notice.text);
            throw quotaError(notice.text);
          }
          if (notice?.kind === 'conversation' && now() - sentAt > 1500) {
            const error = new Error('发送被网页限制：' + notice.text);
            error.code = 'SEND_BLOCKED';
            throw error;
          }
        }
        if (now() >= ackDeadline) throw new Error('网页未确认发送，请手动检查，避免重复发送');
        await sleep(100);
      }
      // 在首页发送第一条消息后地址会从 / 切成 /a/chat/s/<id>；等它稳定再记快照，否则监视阶段会误判串题
      let conversationUrl = ui.url();
      if (!/\/a\/chat\/s\//.test(conversationUrl)) {
        const settleDeadline = Math.min(job.deadline, now() + 5000);
        while (now() < settleDeadline && !/\/a\/chat\/s\//.test(ui.url())) await sleep(100);
        conversationUrl = ui.url();
      }
      return { sentAt, baseline, baselineText, conversationUrl };
    };

    // 先看限额文案再校验控件：额度耗尽时输入框会被提示条替换，ui.check 会先报“找不到控件”
    const preflight = readNotice();
    check();
    // 发送前先看一次：打开长期不活跃的旧会话时，网页会直接给出限制提示
    if (preflight?.kind === 'daily') {
      if (limits.notifyDailyQuota) notify(QUOTA_MESSAGE, preflight.text);
      throw quotaError(preflight.text);
    }
    if (preflight?.kind === 'input') return emptyAnswer('网页提示题目超长，已跳过：' + preflight.text);
    if (preflight?.kind === 'conversation' && limits.rotate) {
      try { await rotate(); } catch (error) { return emptyAnswer('当前对话不可用且无法新开对话：' + error.message, true); }
    }

    let rotations = 0;
    let attempt;
    while (!attempt) {
      try {
        attempt = await submit();
      } catch (error) {
        if (error?.code !== 'SEND_BLOCKED') throw error;
        if (!limits.rotate || rotations >= limits.maxRotationsPerJob || remaining() < limits.minRemainingMsForRotate) {
          return emptyAnswer('当前对话已达消息上限，未能新开对话重试：' + error.message);
        }
        rotations += 1;
        try { await rotate(); } catch (error) { return emptyAnswer('发送被限制且无法新开对话：' + error.message, true); }
      }
    }

    let stableText = '', stableSince = 0, stalled = false;
    while (true) {
      check();
      if (ui.url() !== attempt.conversationUrl) throw new Error('对话页面已切换，桥接暂停以避免串题');
      // 是不是「这一题的新回复」：条数变多了，或者最后一条内容变了。
      // 只用条数会在长对话里失灵（消息列表虚拟化/重渲染时段数不涨），表现为答案已出却一直读秒。
      const replies = ui.replies();
      const latest = replies.slice(-1)[0] || '';
      const fresh = ui.count() > attempt.baseline || (latest && latest !== attempt.baselineText);
      // 只看回复正文是否稳定：网页的“生成中”状态可能比答案晚结束很多（实测 93 秒 vs 3 秒），
      // 不能拿它当回传条件，否则 OCS 会一直转圈。
      const match = fresh
        ? replies.map(text => ({ text, value: parseAnswer(text, job.input?.type) })).filter(item => item.value).pop()
        : null;
      // 20 秒还没认出来就留一条诊断，方便对着控制台查是哪一半判定失效
      if (!match && replies.length && !stalled && now() - attempt.sentAt > 20000) {
        stalled = true;
        console.log(`[OCS bridge] 疑似卡住：条数=${ui.count()} 基线=${attempt.baseline} 文本变过=${latest !== attempt.baselineText}`);
      }
      if (match) {
        if (match.text !== stableText) { stableText = match.text; stableSince = now(); }
        else if (now() - stableSince >= 600) return { bridge_id: job.id, ...match.value };
      } else { stableText = ''; }

      // 限额只按固定间隔采样：body.innerText 在长对话里不便宜，150ms 一次没必要
      if (now() - lastScan >= limits.scanIntervalMs) {
        lastScan = now();
        const notice = readNotice();
        if (notice?.kind === 'daily') {
          if (limits.notifyDailyQuota) notify(QUOTA_MESSAGE, notice.text);
          throw quotaError(notice.text);
        }
        if (notice?.kind === 'input') return emptyAnswer('网页提示题目超长，已跳过：' + notice.text);
        if (notice?.kind === 'conversation') {
          const draftKept = ui.draft().trim().length > 0;
          // 草稿已清空或回复已增长，说明题目很可能已经发出；重发会重复提问，宁可放弃本题
          if (!draftKept || fresh) {
            return emptyAnswer('对话可能已达上限，但无法确认是否已发出，为避免重复发送未重试：' + notice.text);
          }
          if (limits.rotate && rotations < limits.maxRotationsPerJob && remaining() >= limits.minRemainingMsForRotate) {
            rotations += 1;
            try { await rotate(); } catch (error) { return emptyAnswer('无法新开对话，已跳过本题：' + error.message, true); }
            try {
              attempt = await submit();
            } catch (error) {
              if (error?.code === 'SEND_BLOCKED') return emptyAnswer('新会话仍被限制，已跳过本题：' + error.message);
              throw error;
            }
            continue;
          }
          return emptyAnswer('当前对话已达消息上限，未能新开对话重试：' + notice.text);
        }
      }
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
      // 限制提示混在页面文本里：把回答块剔掉，避免模型回答里出现「请开启新对话」被当成系统提示
      noticeText: () => {
        if (!doc.body) return '';
        let text = doc.body.innerText || '';
        for (const element of visible(selectors.answer)) {
          const block = element.innerText;
          if (block) text = text.split(block).join(' ');
        }
        return text;
      },
      // 整页文本：只用于每日额度的整句兜底（提示可能落在被剔除的回答区里）
      bodyText: () => (doc.body ? doc.body.innerText || '' : ''),
      // 只点侧边栏的“开启新对话”，绝不整页跳转：重载会让油猴脚本重新初始化，桥接随之掉线
      newChat: () => {
        const pattern = /^(开启新对话|新对话|新建对话)$/;
        const pick = nodes => {
          const matches = [...nodes].filter(node => node.getClientRects().length && pattern.test((node.innerText || '').trim()));
          if (!matches.length) return null;
          // 同一段文字会同时命中父容器和子节点：点最深的那个，事件向上冒泡才能落到真正的处理器上
          return matches.find(node => !matches.some(other => other !== node && node.contains(other)));
        };
        const target = pick(doc.querySelectorAll('button, a, [role=button]')) ||
          pick(doc.querySelectorAll('div, span')) ||
          [...doc.querySelectorAll('a[href="/"], a[href="/a/chat"]')].find(node => node.getClientRects().length);
        if (!target) return false;
        target.click();
        return true;
      },
      isFreshChat: () => !one(selectors.input).value.trim() && visible(selectors.answer).length === 0,
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
      count: () => visible(selectors.answer).length,
      fileInput: () => doc.querySelector('input[type=file]'),
      replies: () => visible(selectors.answer).slice(-3).flatMap(e => {
        const blocks = [...e.querySelectorAll('pre')];
        return blocks.length ? blocks.map(block => block.querySelector('code')?.textContent || block.innerText) : [e.innerText];
      }),
      url: () => doc.location.href
    };
  }
  // Node's tests import pure protocol/runner helpers; the installed userscript runs below.
  if (typeof module === 'object' && module.exports) {
    module.exports = { parseAnswer, splitAnswers, compareVersion, runJob, createDomAdapter, selectors, classifyNotice, LIMITS };
    return;
  }

  const clientId = crypto.randomUUID();
  // 轮换后靠它判断页面有没有被整页重载：重载会让油猴脚本重新初始化，这份标记随之消失
  window.__ocsBridgeSession = clientId;
  let lastNotifyAt = 0;
  /** 每日额度熔断时的系统通知：优先油猴 API，其次浏览器通知，最后退回控制台 */
  function notify(title, text) {
    if (!LIMITS.notifyDailyQuota) return;
    if (Date.now() - lastNotifyAt < LIMITS.notifyThrottleMs) return;
    lastNotifyAt = Date.now();
    const body = String(text || '').slice(0, 160);
    try {
      if (typeof GM_notification === 'function') { GM_notification({ title, text: body, timeout: 20000 }); return; }
    } catch { /* 继续降级 */ }
    try {
      if (typeof Notification === 'function') {
        if (Notification.permission === 'granted') { new Notification(title, { body }); return; }
        if (Notification.permission === 'default') void Notification.requestPermission();
      }
    } catch { /* 继续降级 */ }
    console.error(`[OCS bridge] ${title}：${body}`);
  }
  const ui = createDomAdapter(document);
  let active = false, loop = null, heartbeat = null, heartbeatBusy = false, registered = false, stopping = null, epoch = 0, answered = 0, rotateFailures = 0;
  let address = GM_getValue('address', 'http://127.0.0.1:3000');
  let token = GM_getValue('token', '');
  const host = document.createElement('div');
  host.style.cssText = 'position:fixed;right:16px;bottom:18px;z-index:2147483647';
  const root = host.attachShadow({ mode: 'closed' });
  root.innerHTML = `<style>
    :host{--bg:#fff;--fg:#182230;--muted:#6b7b8c;--line:#e3e9f0;--field:#f7f9fc;--accent:#4d6bfe;--on-accent:#fff;--ok:#16a34a;--warn:#f59e0b;--err:#e5484d;--head:linear-gradient(180deg,#fbfcfe,#f2f5fa);font:12px/1.45 system-ui,-apple-system,"Segoe UI",sans-serif;color:var(--fg);user-select:none;-webkit-user-select:none}
    @media (prefers-color-scheme: dark){:host{--bg:#151a22;--fg:#e6edf5;--muted:#93a4b7;--line:#2a323d;--field:#1b222c;--accent:#5b7cff;--ok:#34d399;--warn:#fbbf24;--err:#f87171;--head:linear-gradient(180deg,#1a212b,#161c25)}}
    section{width:206px;background:var(--bg);color:var(--fg);border:1px solid var(--line);border-radius:10px;box-shadow:0 8px 24px rgba(15,23,42,.14),0 1px 2px rgba(15,23,42,.08);overflow:hidden}
    header{display:flex;align-items:center;gap:4px;padding:4px 5px 4px 9px;background:var(--head);border-bottom:1px solid var(--line);cursor:move;touch-action:none}
    header strong{font-size:12px;font-weight:600}
    .ver{color:var(--muted);font-size:10px}
    #dot{width:6px;height:6px;border-radius:50%;background:#b3bfcc;margin-left:1px;flex:0 0 auto;transition:background .2s,box-shadow .2s}
    #dot[data-tone=ok]{background:var(--ok);box-shadow:0 0 0 3px rgba(22,163,74,.12)}
    #dot[data-tone=busy]{background:var(--warn);box-shadow:0 0 0 3px rgba(245,158,11,.16);animation:pulse 1.1s ease-in-out infinite}
    #dot[data-tone=error]{background:var(--err);box-shadow:0 0 0 3px rgba(229,72,77,.14)}
    @keyframes pulse{50%{opacity:.35}}
    header button{border:0;background:transparent;color:var(--muted);width:18px;height:18px;padding:0;border-radius:5px;font-size:12px;line-height:1;cursor:pointer;transition:background .15s,color .15s}
    header button:hover{background:rgba(125,140,160,.18);color:var(--fg)}
    #cfg{margin-left:auto}
    #body{padding:7px 9px 8px}
    .row{display:flex;gap:6px}
    .row button{flex:1;padding:4px 0;font-size:12px;border-radius:7px;border:1px solid transparent;cursor:pointer;transition:background .15s,filter .15s,transform .06s}
    .row button:active:not(:disabled){transform:translateY(1px)}
    #start{background:var(--accent);color:var(--on-accent);font-weight:600;box-shadow:0 1px 2px rgba(77,107,254,.35)}
    #start:hover:not(:disabled){filter:brightness(1.07)}
    #start:disabled{opacity:.45;box-shadow:none;cursor:default}
    #pause{background:var(--field);color:var(--fg);border-color:var(--line)}
    #pause:hover:not(:disabled){background:var(--line)}
    #pause:disabled{opacity:.5;cursor:default}
    p{margin:7px 0 0;font-size:11px;line-height:1.4;color:var(--muted);white-space:pre-wrap;overflow-wrap:anywhere;max-height:2.8em;overflow:auto}
    p[data-tone=ok]{color:var(--fg);opacity:.72}
    p[data-tone=busy]{color:var(--warn)}
    p[data-tone=error]{color:var(--err)}
    p::-webkit-scrollbar{width:4px}
    p::-webkit-scrollbar-thumb{background:var(--line);border-radius:2px}
    #settings{margin-top:1px}
    #settings[hidden]{display:none}
    label{display:block;margin-top:6px;font-size:10px;color:var(--muted)}
    input{box-sizing:border-box;width:100%;padding:3px 6px;margin-top:2px;border:1px solid var(--line);border-radius:6px;background:var(--field);color:var(--fg);font-size:11px;user-select:text;-webkit-user-select:text;transition:border-color .15s,box-shadow .15s}
    input:focus{outline:none;border-color:var(--accent);box-shadow:0 0 0 2px rgba(77,107,254,.18)}
    section.collapsed{width:auto;border-radius:999px}
    section.collapsed #body,section.collapsed #cfg{display:none}
    section.collapsed .ver{display:none}
    section.collapsed header{border-bottom:0;padding:3px 4px 3px 10px}
    </style><section id="panel"><header id="bar" title="拖动可移动"><strong>OCS 桥接</strong><span class="ver">v${VERSION}</span><span id="dot" data-tone="idle"></span><button id="cfg" title="服务地址与口令">⚙</button><button id="fold" title="收起">−</button></header>
    <div id="body">
    <div class="row"><button id="start" title="开始领取 OCS 题目">启动</button><button id="pause" disabled title="停止领取任务并取消队列">暂停</button></div>
    <p id="status">请登录并打开一个专用空白对话，然后启动。</p>
    <div id="settings"><label>服务地址<input id="address" spellcheck="false"></label><label>API_TOKEN<input id="token" type="password" autocomplete="off"></label></div>
    </div></section>`;
  document.body.appendChild(host);
  const addressInput = root.querySelector('#address'), tokenInput = root.querySelector('#token');
  const start = root.querySelector('#start'), pause = root.querySelector('#pause'), status = root.querySelector('#status');
  const panel = root.querySelector('#panel'), bar = root.querySelector('#bar'), fold = root.querySelector('#fold'), dot = root.querySelector('#dot');
  const settings = root.querySelector('#settings'), cfg = root.querySelector('#cfg');
  addressInput.value = address;
  tokenInput.value = token;
  // 已经存过口令时把设置收起来，只留按钮和状态；点 ⚙ 再展开
  settings.hidden = !!token;
  cfg.addEventListener('click', () => { settings.hidden = !settings.hidden; });
  const display = (message, tone = 'idle') => { status.textContent = message; status.dataset.tone = tone; dot.dataset.tone = tone; };
  // 位置与折叠状态都记在油猴自己的存储里，下次打开保持一致
  const clamp = (x, y) => {
    const width = host.offsetWidth || 270, height = host.offsetHeight || 180;
    return { x: Math.round(Math.min(Math.max(0, x), Math.max(0, innerWidth - width))),
      y: Math.round(Math.min(Math.max(0, y), Math.max(0, innerHeight - height))) };
  };
  const place = (x, y) => {
    const point = clamp(x, y);
    host.style.left = point.x + 'px';
    host.style.top = point.y + 'px';
    host.style.right = host.style.bottom = 'auto';
    return point;
  };
  let position = null;
  const saved = GM_getValue('panelPos', null);
  if (saved && Number.isFinite(saved.x) && Number.isFinite(saved.y)) position = place(saved.x, saved.y);
  let collapsed = GM_getValue('panelCollapsed', false) === true;
  const applyCollapse = value => {
    collapsed = value;
    panel.classList.toggle('collapsed', value);
    fold.textContent = value ? '+' : '−';
    fold.title = value ? '展开' : '收起';
    if (position) position = place(position.x, position.y);
  };
  applyCollapse(collapsed);
  fold.addEventListener('click', () => { applyCollapse(!collapsed); GM_setValue('panelCollapsed', collapsed); });
  addEventListener('resize', () => { if (position) { position = place(position.x, position.y); GM_setValue('panelPos', position); } });
  // 拖动只从标题栏发起，避免和输入框选词冲突
  bar.addEventListener('pointerdown', event => {
    if (event.target.closest('button')) return;
    const rect = host.getBoundingClientRect();
    const offsetX = event.clientX - rect.left, offsetY = event.clientY - rect.top;
    let moved = false;
    const move = e => { moved = true; position = place(e.clientX - offsetX, e.clientY - offsetY); };
    const up = () => {
      removeEventListener('pointermove', move);
      removeEventListener('pointerup', up);
      if (moved && position) GM_setValue('panelPos', position);
    };
    addEventListener('pointermove', move);
    addEventListener('pointerup', up);
    event.preventDefault();
  });
  // 优先用页面自己的 fetch 直连本机：油猴的 GM_xmlhttpRequest 要经扩展后台 service worker 转发，
  // 实测会被 Chrome 按分钟级唤醒，导致题目排 60 秒才被领取。只有被页面 CSP 拦截时才退回油猴。
  let transport = 'fetch';
  function gmRequest(path, payload) {
    if (transport !== 'gm') {
      transport = 'gm';
      console.log('[OCS bridge] fetch 直连被页面 CSP 或网络策略拦截，退回 GM_xmlhttpRequest（可能被扩展后台限流）');
    }
    return new Promise((resolve, reject) => GM_xmlhttpRequest({
      method: 'POST', url: address + path, timeout: 8000,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      data: payload,
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
  async function request(path, data = {}) {
    const payload = JSON.stringify({ clientId, version: VERSION, token, ...data });
    let response;
    try {
      // 不带自定义头、body 用 text/plain：这是"简单请求"，浏览器不会先发 OPTIONS 预检
      response = await fetch(address + path, {
        method: 'POST', cache: 'no-store', signal: AbortSignal.timeout(8000),
        headers: { 'Content-Type': 'text/plain;charset=UTF-8' },
        body: payload
      });
    } catch {
      // 没拿到任何 HTTP 响应才退回油猴；业务错误（401/503 等）不走这里
      return gmRequest(path, payload);
    }
    const body = await response.json().catch(() => null);
    if (response.status !== 200 || !body || body.code !== 0) throw new Error(body?.message || `本地服务错误 ${response.status}`);
    return body;
  }
  async function stop(message, tone = 'error') {
    active = false;
    clearInterval(heartbeat);
    heartbeat = null;
    pause.disabled = true;
    display(message, tone);
    if (stopping) return stopping;
    if (registered) {
      registered = false;
      stopping = request('/bridge/pause', { reason: message }).catch(() => {});
      try { await stopping; } finally { stopping = null; }
    }
  }
  // 题间冷却：面板上每秒刷新剩余时间，暂停/断开时立即中断
  const cooldown = ms => new Promise(resolve => {
    if (!(ms > 0)) { resolve(); return; }
    const startedAt = Date.now();
    display(`冷却 ${Math.ceil(ms / 1000)}s（已完成 ${answered} 题）`, 'ok');
    const timer = setInterval(() => {
      const left = ms - (Date.now() - startedAt);
      if (!active || left <= 0) { clearInterval(timer); resolve(); return; }
      display(`冷却 ${Math.ceil(left / 1000)}s（已完成 ${answered} 题）`, 'ok');
    }, 500);
  });
  async function processQueue() {
    try {
      while (active) {
        ui.check();
        const { job } = await request('/bridge/poll');
        if (!active) break;
        if (job) {
          const startedAt = Date.now();
          // 每秒把“脚本看到的网页状态”打到控制台和面板，卡住时能一眼看出卡在哪一步
          const probe = setInterval(() => {
            if (!active) return;
            try {
              const replies = ui.replies();
              const seconds = Math.round((Date.now() - startedAt) / 1000);
              const parsed = replies.filter(text => parseAnswer(text, job.input?.type)).length;
              const longest = replies.reduce((max, text) => Math.max(max, text.length), 0);
              const idle = ui.isIdle() ? '是' : '否';
              console.log(`[OCS bridge] ${seconds}s 回复块=${replies.length} 可解析=${parsed} 空闲=${idle} 最长文本=${longest}`);
              display(`解题 ${seconds}s · 回复 ${replies.length} · 可解析 ${parsed ? '是' : '否'} · 空闲 ${idle} · ${longest} 字`, 'busy');
            } catch (error) { console.log('[OCS bridge] 采样失败：' + error.message); }
          }, 1000);
          let answer;
          try {
            display('正在解题：' + job.input.question.slice(0,80), 'busy');
            answer = await runJob(job, ui, { running: () => active, blobBase: address, notify,
              alive: () => window.__ocsBridgeSession === clientId });
          } finally { clearInterval(probe); }
          if (!active) break;
          // rotateFailed 只是本地标记，回传前剥掉；连续多次失败说明页面已没法自愈，停桥接等人处理
          const { rotateFailed, ...result } = answer;
          await request('/bridge/result', { id: job.id, answer: result });
          answered += 1;
          if (rotateFailed) {
            rotateFailures += 1;
            if (rotateFailures >= LIMITS.pauseAfterRotateFailures) {
              await stop('连续多次无法新开对话，请手动清理网页会话后重新启动。');
              break;
            }
          } else rotateFailures = 0;
          await cooldown(nextCooldown(answered));
          if (!active) break;
          display(rotateFailed ? '本题未作答：无法新开对话。' : '本题已返回，等待下一题。', rotateFailed ? 'error' : 'ok');
        }
        await new Promise(resolve => setTimeout(resolve, 200));
      }
    } catch (error) {
      if (!active) return;
      // 每日额度用尽属于熔断：先由 runJob 发过系统通知，这里只负责停桥接并留下原因
      if (error?.code === 'QUOTA_DAILY') await stop(error.message + '\n额度恢复后请重新点击启动。');
      else await stop(error.message + '\n请检查网页后重新点击启动。');
    }
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
        const info = await request('/bridge/connect', { version: VERSION });
        const serverVersion = typeof info.serverVersion === 'string' ? info.serverVersion : '';
        const serverOutdated = serverVersion ? compareVersion(serverVersion, MIN_SERVER_VERSION) < 0 : false;
        console.log(`[OCS bridge] 已连接，传输方式：${transport}；插件 v${VERSION}，node v${serverVersion || '未知'}`);
        if (serverOutdated) console.warn(`[OCS bridge] node 端 v${serverVersion} 低于所需的 v${MIN_SERVER_VERSION}，图片上传等能力会降级`);
        if (info.bridgeOutdated) console.warn('[OCS bridge] 服务端提示插件版本偏旧，建议更新油猴脚本');
        registered = active = true;
        pause.disabled = false;
        settings.hidden = true;
        display(serverOutdated
          ? `⚠️ node 端 v${serverVersion} 过旧（需要 v${MIN_SERVER_VERSION}），请更新仓库后重启服务`
          : `已连接（插件 v${VERSION} / node v${serverVersion || '未知'}）`, serverOutdated ? 'error' : 'ok');
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
  pause.addEventListener('click', () => { void stop('已暂停。若网页仍在生成，请等待完成或手动停止，再重新启动。', 'idle'); });
  // 标签页被隐藏时 Chrome 会限流甚至冻结页面，定时器停摆，题目会一直排在队列里等页面恢复
  document.addEventListener('visibilitychange', () => {
    const hidden = document.hidden;
    console.log(`[OCS bridge] 页面${hidden ? '隐藏 → 浏览器将冻结/限流，题目会延迟' : '可见 → 恢复轮询'}`);
    if (!active) return;
    display(hidden
      ? '⚠️ 页面已切到后台，Chrome 会冻结/限流本页面：OCS 的题目要等你切回来才开始处理。建议把 DeepSeek 单独放一个窗口。'
      : '页面已回到前台，继续等待 OCS 题目。', hidden ? 'idle' : 'ok');
  });
})();
