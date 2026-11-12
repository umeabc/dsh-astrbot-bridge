/** Tiny HTTP helpers shared by the bot API and the desktop settings routes. */

const BODY_LIMIT = 1024 * 1024;

export function sendJson(response, status, value) {
  const body = Buffer.from(JSON.stringify(value), 'utf8');
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': String(body.length),
  });
  response.end(body);
}

export function sendText(response, status, text, type = 'text/plain; charset=utf-8') {
  const body = Buffer.from(text, 'utf8');
  response.writeHead(status, {
    'content-type': type,
    'cache-control': 'no-store',
    'content-length': String(body.length),
  });
  response.end(body);
}

export function readText(request, limit = BODY_LIMIT) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    request.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error('request body is too large'));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    request.on('error', reject);
  });
}

export function parseJsonObject(text) {
  if (String(text ?? '').trim() === '') return {};
  const value = JSON.parse(text);
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('body must be a JSON object');
  }
  return value;
}
