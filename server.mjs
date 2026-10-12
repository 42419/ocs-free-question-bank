import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';

class BridgeError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const failure = (status, message) => new BridgeError(status, message);

function buildPrompt(id, input) {
  return `直接解答下面这道题，不要联网搜索或展开推理。只输出 JSON：{"bridge_id":"${id}","answers":["答案"],"explanation":"简短理由"}。选择题填写完整选项文字（单选一个，多选可多个）；判断写正确或错误；填空按顺序逐空填写。无法确定时 answers 返回空数组。题目：${JSON.stringify(input)}`;
}

class BridgeQueue {
  constructor({ jobTimeoutMs = 150000, maxQueue = 3, heartbeatTimeoutMs = 180000 } = {}) {
    this.jobTimeoutMs = jobTimeoutMs;
    this.maxQueue = maxQueue;
    this.heartbeatTimeoutMs = heartbeatTimeoutMs;
    this.worker = null;
    this.jobs = [];
  }
  check() {
    if (this.worker && Date.now() - this.worker.seen > this.heartbeatTimeoutMs) {
      this.pause(failure(503, 'DeepSeek 网页连接已中断，请在网页重新启动桥接'));
    }
  }
  status() { this.check(); return { connected: !!this.worker, queued: this.jobs.length }; }
  connect(clientId) {
    this.check();
    if (this.worker && this.worker.id !== clientId) throw failure(409, '另一个 DeepSeek 标签页已连接，请先暂停该页面');
    if (this.jobs.length) throw failure(409, '仍有任务运行，请先暂停桥接');
    this.worker = { id: clientId, seen: Date.now() };
  }
  touch(clientId) {
    this.check();
    if (!this.worker || this.worker.id !== clientId) throw failure(409, '桥接已暂停或由其他页面持有，请手动重新启动');
    this.worker.seen = Date.now();
  }
  settle(job, error, value) {
    const index = this.jobs.indexOf(job);
    if (index < 0) return;
    this.jobs.splice(index, 1);
    clearTimeout(job.timer);
    job.signal?.removeEventListener('abort', job.abort);
    if (error) job.reject(error); else job.resolve(value);
  }
  pause(error = failure(503, '网页桥接已暂停')) {
    this.worker = null;
    for (const job of [...this.jobs]) this.settle(job, error);
  }
  enqueue(input, signal) {
    this.check();
    if (!this.worker) throw failure(503, '请先在已登录的 DeepSeek 网页启动桥接脚本');
    if (this.jobs.length >= this.maxQueue) throw failure(429, '队列已满，请将 OCS 查询线程数设为 1');
    if (signal?.aborted) throw failure(499, '查询已取消');
    return new Promise((resolve, reject) => {
      const job = { id: randomUUID(), input, resolve, reject, claimed: false, deadline: Date.now() + this.jobTimeoutMs, signal };
      job.abort = () => {
        const error = failure(499, 'OCS 查询已取消，请检查网页后重新启动桥接');
        if (job.claimed) this.pause(error); else this.settle(job, error);
      };
      job.timer = setTimeout(() => {
        const error = failure(504, '网页解题或排队超时，请检查网页并重新启动桥接');
        if (job.claimed) this.pause(error); else this.settle(job, error);
      }, this.jobTimeoutMs);
      signal?.addEventListener('abort', job.abort, { once: true });
      this.jobs.push(job);
    });
  }
  poll(clientId) {
    this.touch(clientId);
    const job = this.jobs[0];
    if (!job || job.claimed) return null;
    job.claimed = true;
    return { id: job.id, input: job.input, prompt: buildPrompt(job.id, job.input), deadline: job.deadline };
  }
  complete(clientId, id, answer) {
    this.touch(clientId);
    const job = this.jobs[0];
    if (!job || !job.claimed || job.id !== id) throw failure(409, '任务已过期或任务编号不匹配');
    if (Date.now() >= job.deadline) {
      const error = failure(504, '任务已超时，请重新启动桥接');
      this.pause(error);
      throw error;
    }
    if (!answer || answer.bridge_id !== id || !Array.isArray(answer.answers) || answer.answers.length > 100 ||
        answer.answers.some(s => typeof s !== 'string' || !s.trim() || s.length > 12000) ||
        typeof answer.explanation !== 'string' || answer.explanation.length > 12000 ||
        (['single', 'judgement'].includes(job.input.type) && answer.answers.length > 1)) {
      const error = failure(502, '网页回答格式无效，桥接已暂停，请检查回答后重试');
      this.pause(error);
      throw error;
    }
    this.settle(job, null, { code: 0, message: answer.answers.length ? 'success' : '未得到可靠答案',
      data: answer.answers.length ? [{ question: job.input.question, answer: answer.answers.map(s => s.trim()).join('#'), explanation: answer.explanation }] : [],
      explanation: answer.explanation });
  }
}

async function readJson(req) {
  if (!req.headers['content-type']?.toLowerCase().startsWith('application/json')) throw failure(415, '请使用 application/json');
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 32768) throw failure(413, '请求数据超过 32 KB');
    chunks.push(chunk);
  }
  try {
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!body || Array.isArray(body) || typeof body !== 'object') throw new Error();
    return body;
  } catch { throw failure(400, '请求不是有效 JSON 对象'); }
}
function normalize(input) {
  if (typeof input.question !== 'string' || !input.question.trim() || input.question.length > 12000) throw failure(400, 'question 必须为 1–12000 字符的非空字符串');
  let options = input.options ?? [];
  if (typeof options === 'string') options = options.split('\n').filter(s => s.trim());
  if (!Array.isArray(options) || options.length > 100 || options.some(s => typeof s !== 'string')) throw failure(400, 'options 必须是字符串数组或换行分隔的字符串');
  if (input.type !== undefined && (typeof input.type !== 'string' || input.type.length > 40)) throw failure(400, 'type 必须是题型字符串');
  return { question: input.question.trim(), options, type: input.type || 'unknown' };
}

export function createServer({ token, monitorIntervalMs = 250, apiSolver = null, jobTimeoutMs = 150000, ...settings } = {}) {
  if (!token || token.trim() !== token || /[\r\n]/.test(token)) throw new Error('请设置有效的 API_TOKEN');
  const queue = new BridgeQueue({ ...settings, jobTimeoutMs });
  const monitor = setInterval(() => queue.check(), monitorIntervalMs);
  monitor.unref();
  const routes = new Set(['/search', '/bridge/connect', '/bridge/poll', '/bridge/heartbeat', '/bridge/result', '/bridge/pause']);
  const server = http.createServer(async (req, res) => {
    const reply = (status, body) => {
      if (res.destroyed || res.writableEnded) return;
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(body));
    };
    try {
      // OCS 4.15.3 probes the origin root; OCS 5.1.0 probes the configured URL.
      // Neither probe should authenticate, inspect a question, or enqueue work.
      const requestPath = new URL(req.url, 'http://127.0.0.1').pathname;
      if (req.method === 'HEAD' && (requestPath === '/' || requestPath === '/search')) {
        return reply(200, {});
      }
      if (req.url === '/health' && req.method === 'GET') {
        return reply(200, apiSolver
          ? { status: 'ok', mode: 'deepseek-api', connected: true, queued: 0 }
          : { status: 'ok', mode: 'web-bridge', ...queue.status() });
      }
      if (!routes.has(req.url)) throw failure(404, '接口不存在');
      if (apiSolver && req.url !== '/search') throw failure(404, '当前 API 模式不启用网页桥接接口');
      if (req.method !== 'POST') throw failure(405, '请使用 POST');
      if (req.headers.authorization !== `Bearer ${token}`) throw failure(401, 'API_TOKEN 不正确');
      const body = await readJson(req);
      if (req.url === '/search') {
        const input = normalize(body);
        const abort = new AbortController();
        const onClose = () => { if (!res.writableEnded) abort.abort(); };
        res.on('close', onClose);
        try {
          if (apiSolver) {
            const answer = await apiSolver(input, abort.signal);
            if (!answer || !Array.isArray(answer.answers) || answer.answers.length > 100 ||
                answer.answers.some(value => typeof value !== 'string' || !value.trim() || value.length > 12000) ||
                typeof answer.explanation !== 'string' || answer.explanation.length > 12000 ||
                (['single', 'judgement'].includes(input.type) && answer.answers.length > 1)) {
              throw failure(502, 'DeepSeek API 返回的答案格式无效');
            }
            reply(200, { code: 0, message: answer.answers.length ? 'success' : '未得到可靠答案',
              data: answer.answers.length ? [{ question: input.question, answer: answer.answers.map(value => value.trim()).join('#'), explanation: answer.explanation }] : [],
              explanation: answer.explanation });
          } else {
            reply(200, await queue.enqueue(input, abort.signal));
          }
        }
        finally { res.off('close', onClose); }
        return;
      }
      const { clientId } = body;
      if (typeof clientId !== 'string' || !/^[\w-]{1,100}$/.test(clientId)) throw failure(400, 'clientId 无效');
      if (req.url === '/bridge/connect') queue.connect(clientId);
      if (req.url === '/bridge/heartbeat') queue.touch(clientId);
      if (req.url === '/bridge/poll') return reply(200, { code: 0, job: queue.poll(clientId) });
      if (req.url === '/bridge/result') queue.complete(clientId, body.id, body.answer);
      if (req.url === '/bridge/pause') { queue.touch(clientId); queue.pause(); }
      reply(200, { code: 0 });
    } catch (error) {
      const status = error instanceof BridgeError || Number.isInteger(error?.status) ? error.status : 500;
      reply(status, { code: status, message: error instanceof BridgeError || Number.isInteger(error?.status) ? error.message : '本地桥接服务错误', data: [] });
    }
  });
  server.requestTimeout = 30000;
  server.headersTimeout = 15000;
  server.on('close', () => { clearInterval(monitor); queue.pause(); });
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const backend = process.env.BACKEND || 'web-bridge';
    if (!['web-bridge', 'deepseek-api'].includes(backend)) throw new Error('BACKEND 只能是 web-bridge 或 deepseek-api');
    const port = Number(process.env.PORT || 3000);
    const seconds = Number(process.env.JOB_TIMEOUT_SECONDS || 150);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT 必须在 1–65535 之间');
    if (!Number.isFinite(seconds) || seconds < 10 || seconds > 170) throw new Error('JOB_TIMEOUT_SECONDS 必须在 10–170 之间');
    let apiSolver = null;
    if (backend === 'deepseek-api') {
      const { createDeepSeekApiSolver } = await import('./deepseek-api.mjs');
      apiSolver = createDeepSeekApiSolver({ apiKey: process.env.DEEPSEEK_API_KEY, model: process.env.DEEPSEEK_MODEL || 'deepseek-flash', timeoutMs: seconds * 1000 });
    }
    const server = createServer({ token: process.env.API_TOKEN, jobTimeoutMs: seconds * 1000, apiSolver });
    server.on('error', error => { console.error(`启动失败：${error.code}`); process.exitCode = 1; });
    server.listen(port, '127.0.0.1', () => console.log(backend === 'deepseek-api'
      ? `OCS DeepSeek API 后端：http://127.0.0.1:${port}\n此模式会按 DeepSeek API 实时价格计费。`
      : `OCS 网页桥接：http://127.0.0.1:${port}\n请在 DeepSeek 网页桥接面板点击“启动”。不需要 DeepSeek API 密钥。`));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
