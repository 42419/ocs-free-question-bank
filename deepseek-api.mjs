const API_URL = 'https://api.deepseek.com/chat/completions';

export class DeepSeekApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function parseJsonContent(content) {
  if (typeof content !== 'string') throw new DeepSeekApiError(502, 'DeepSeek API 返回了非文本答案');
  const text = content.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
  if (!text) throw new DeepSeekApiError(502, 'DeepSeek API 返回了空答案');
  try { return JSON.parse(text); }
  catch { throw new DeepSeekApiError(502, 'DeepSeek API 没有返回有效 JSON 答案'); }
}

export function createDeepSeekApiSolver({ apiKey, model = 'deepseek-flash', fetchImpl = fetch, timeoutMs = 150000 } = {}) {
  if (typeof apiKey !== 'string' || !apiKey.trim() || apiKey.trim() !== apiKey || /[\r\n]/.test(apiKey)) {
    throw new Error('使用 DeepSeek API 后端时必须设置 DEEPSEEK_API_KEY');
  }
  if (typeof model !== 'string' || !/^[a-zA-Z0-9._-]{1,80}$/.test(model)) throw new Error('DEEPSEEK_MODEL 格式无效');

  return async (input, requestSignal) => {
    const timeoutSignal = AbortSignal.timeout(timeoutMs);
    const signal = requestSignal ? AbortSignal.any([requestSignal, timeoutSignal]) : timeoutSignal;
    let response;
    try {
      response = await fetchImpl(API_URL, {
        method: 'POST',
        signal,
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model,
          stream: false,
          max_tokens: 512,
          response_format: { type: 'json_object' },
          messages: [
            { role: 'system', content: '你是严谨的题目解答助手。只输出 JSON 对象，不要代码围栏或额外文本。格式为 {"answers":["答案"],"explanation":"简短理由"}。选择题填写完整选项文字；判断题填写正确或错误；填空按顺序逐空填写；无法确定时 answers 返回空数组。' },
            { role: 'user', content: JSON.stringify(input) }
          ]
        })
      });
    } catch (error) {
      if (requestSignal?.aborted) throw new DeepSeekApiError(499, 'OCS 已取消本次查询');
      if (error?.name === 'TimeoutError' || error?.name === 'AbortError') throw new DeepSeekApiError(504, 'DeepSeek API 请求超时');
      throw new DeepSeekApiError(502, '无法连接 DeepSeek API，请检查服务器网络');
    }

    if (!response.ok) {
      const status = response.status;
      if (status === 401 || status === 403) throw new DeepSeekApiError(502, 'DeepSeek API Key 无效或没有权限');
      if (status === 402 || status === 429) throw new DeepSeekApiError(429, 'DeepSeek API 余额不足或请求频率受限');
      if (status >= 500) throw new DeepSeekApiError(502, 'DeepSeek API 暂时不可用');
      throw new DeepSeekApiError(502, `DeepSeek API 拒绝了请求（HTTP ${status}）`);
    }

    let payload;
    try { payload = await response.json(); }
    catch { throw new DeepSeekApiError(502, 'DeepSeek API 返回了无效响应'); }
    const choice = payload?.choices?.[0];
    if (!choice || choice.finish_reason === 'length') throw new DeepSeekApiError(502, 'DeepSeek API 回答不完整');
    return parseJsonContent(choice.message?.content);
  };
}
