import http from 'node:http';

const port = Number(process.env.RELAY_PORT || 3102);
const bindHost = process.env.RELAY_HOST || '127.0.0.1';
const upstreamUrl = process.env.RELAY_UPSTREAM_URL || 'http://127.0.0.1:3001/api/auth/auto/webhook';
const relaySecret = (process.env.RELAY_SHARED_SECRET || '').trim();

if (!relaySecret) {
  console.error('Missing RELAY_SHARED_SECRET');
  process.exit(1);
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.method !== 'POST') {
      res.writeHead(405, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: 'POST only' }));
      return;
    }

    const incomingSecret = String(req.headers['x-webhook-secret'] || '').trim();
    if (incomingSecret !== relaySecret) {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: 'Invalid webhook secret' }));
      return;
    }

    const chunks = [];
    for await (const chunk of req) {
      chunks.push(chunk);
    }
    const body = Buffer.concat(chunks);

    const upstreamResponse = await fetch(upstreamUrl, {
      method: 'POST',
      headers: {
        'content-type': req.headers['content-type'] || 'application/json',
        'x-webhook-secret': relaySecret,
      },
      body,
    });

    const responseText = await upstreamResponse.text();
    res.writeHead(upstreamResponse.status, {
      'content-type': upstreamResponse.headers.get('content-type') || 'application/json',
    });
    res.end(responseText);
  } catch (error) {
    res.writeHead(500, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      success: false,
      error: error instanceof Error ? error.message : String(error),
    }));
  }
});

server.listen(port, bindHost, () => {
  console.log(`OTP webhook relay listening on http://${bindHost}:${port}`);
  console.log(`Forwarding to ${upstreamUrl}`);
});
