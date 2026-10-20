// A negative OAuth probe: no real authorization code, user, or session is used.
const account = process.env.CLOUDFLARE_ACCOUNT_ID;
const headers = { Authorization: `Bearer ${process.env.CLOUDFLARE_API_TOKEN}` };
const base = `https://api.cloudflare.com/client/v4/accounts/${account}/pages/projects/moemail`;
async function api(path, method = 'GET', body) {
  const response = await fetch(base + path, {
    method, headers: { ...headers, 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const payload = await response.json();
  if (!response.ok || !payload.success) throw new Error(`Cloudflare ${method} failed (${response.status})`);
  return payload.result;
}
const project = await api('');
if (project.subdomain !== 'moemail-2ba.pages.dev') throw new Error('Unexpected Pages project');
const deployment = project.canonical_deployment?.id;
if (!deployment) throw new Error('No production deployment');
const path = `/deployments/${deployment}/tails`;
const tail = await api(path, 'POST', {});
const socket = new WebSocket(tail.url, 'trace-v1');
const marker = `moemail-issuer-probe-${Date.now()}`;
let timer;
let received = 0;
try {
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Log connection timed out')), 15000);
    socket.addEventListener('open', () => { clearTimeout(timeout); socket.send(JSON.stringify({ debug: false })); resolve(); }, { once: true });
    socket.addEventListener('error', () => { clearTimeout(timeout); reject(new Error('Log connection failed')); }, { once: true });
  });
  const captured = new Promise((resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`Probe log was not received (${received} tail events)`)), 20000);
    socket.addEventListener('message', async event => {
      try {
        const message = typeof event.data === 'string' ? event.data : await event.data.text();
        const record = JSON.parse(message);
        received++;
        const requestUrl = record.event?.request?.url;
        if (received <= 3) console.log(`Tail event keys: ${Object.keys(record).join(',')}; path: ${requestUrl ? new URL(requestUrl).pathname : 'none'}`);
        if (!requestUrl?.includes('/api/auth/callback/github')) return;
        clearTimeout(timer);
        resolve(record);
      } catch (error) { clearTimeout(timer); reject(error); }
    });
  });
  const url = new URL('https://moemail-2ba.pages.dev/api/auth/callback/github');
  url.searchParams.set('code', marker);
  url.searchParams.set('iss', 'https://github.com/login/oauth');
  const response = await fetch(url, { redirect: 'manual' });
  console.log(`Probe response: HTTP ${response.status}; location: ${response.headers.get('location')}; ray: ${response.headers.get('cf-ray')}`);
  const record = await captured;
  const messages = (record.logs || []).flatMap(log => log.message || []).map(value => typeof value === 'string' ? value : JSON.stringify(value)).join('\n');
  console.log(`Production deployment: ${deployment}; probe HTTP status: ${response.status}`);
  if (/unexpected.*iss.*response parameter value/i.test(messages)) throw new Error('Production still rejects the GitHub issuer');
  if (!/bad_verification_code|invalid_grant|TokenEndpointError/i.test(messages)) {
    console.log(messages.slice(0, 5000));
    throw new Error('The probe did not reach the expected token rejection');
  }
  console.log('PASS: production accepted the GitHub issuer and reached the token endpoint; the intentionally invalid code was rejected.');
} finally {
  clearTimeout(timer);
  socket.close();
  await api(`${path}/${tail.id}`, 'DELETE');
}
