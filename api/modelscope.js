// Small forwarding function for ModelScope. Browsers block the extra headers its async image API
// needs (CORS), so the page calls this same-site function and it makes the real request.
// Only ModelScope's API hosts, and image downloads from ModelScope/Aliyun storage, are allowed.
// Nothing is stored or logged; the token is only forwarded in the Authorization header.

const API_HOST = /^api-inference\.modelscope\.(ai|cn)$/;
const IMAGE_HOST = /(^|\.)(aliyuncs\.com|modelscope\.(ai|cn))$/;
const FORWARD = ['authorization', 'content-type', 'x-modelscope-async-mode', 'x-modelscope-task-type'];

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

module.exports = async (req, res) => {
  res.setHeader('X-Pollimage-Proxy', '1');
  let target;
  try {
    target = new URL(new URL(req.url, 'https://local.invalid').searchParams.get('u'));
  } catch (_) {
    res.statusCode = 400;
    return res.end('Missing or invalid "u" parameter.');
  }
  const isApi = target.protocol === 'https:' && API_HOST.test(target.hostname);
  const isImage = target.protocol === 'https:' && req.method === 'GET' && IMAGE_HOST.test(target.hostname);
  if (!isApi && !isImage) {
    res.statusCode = 403;
    return res.end('This address is not allowed.');
  }
  if (!['GET', 'POST'].includes(req.method)) {
    res.statusCode = 405;
    return res.end('Method not allowed.');
  }

  const headers = {};
  if (isApi) FORWARD.forEach((name) => { if (req.headers[name]) headers[name] = req.headers[name]; });
  try {
    const upstream = await fetch(target, {
      method: req.method,
      headers,
      body: req.method === 'POST' ? await readBody(req) : undefined,
      redirect: 'follow'
    });
    res.statusCode = upstream.status;
    const type = upstream.headers.get('content-type');
    if (type) res.setHeader('Content-Type', type);
    res.end(Buffer.from(await upstream.arrayBuffer()));
  } catch (_) {
    res.statusCode = 502;
    res.end('Could not reach ModelScope.');
  }
};
