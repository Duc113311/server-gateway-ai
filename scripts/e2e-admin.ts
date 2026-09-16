// End-to-end check of the admin flow: enrolment, both login factors, TOTP
// replay rejection, CSRF, and the dashboard APIs.
//
// Needs a gateway running against a throwaway account file, because enrolment
// happens exactly once:
//
//   rm -rf data-test
//   ADMIN_ENABLED=true ADMIN_SETUP_TOKEN=test-setup-token \
//     ADMIN_ACCOUNT_PATH=./data-test/admin.json \
//     ADMIN_LOG_PATH=./data-test/requests.jsonl \
//     PORT=8110 AUTH_MODE=none npm run dev
//
// then `npm run e2e:admin` in another shell.
import { codeFor, stepFor } from '../src/admin/totp';

const BASE = process.env.BASE ?? 'http://localhost:8110';
const TOKEN = process.env.ADMIN_SETUP_TOKEN ?? 'test-setup-token';

let cookie = '';

async function call(path: string, init: RequestInit = {}) {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    redirect: 'manual',
    headers: {
      'content-type': 'application/json',
      ...(cookie ? { cookie } : {}),
      ...(init.headers ?? {}),
    },
  });
  const setCookie = res.headers.get('set-cookie');
  if (setCookie) cookie = setCookie.split(';')[0];
  const text = await res.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch { /* html page */ }
  return { status: res.status, json, text };
}

function check(label: string, ok: boolean, extra = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${extra ? `  ${extra}` : ''}`);
  if (!ok) process.exitCode = 1;
}

async function main() {
  // 1. Setup page is gated on the token.
  const noToken = await call('/admin/setup');
  check('setup without token is refused', noToken.status === 403);

  const withToken = await call(`/admin/setup?token=${TOKEN}`);
  check('setup with token serves the page', withToken.status === 200 && withToken.text.includes('Create the admin account'));

  // 2. Secret + QR.
  const secretRes = await call('/admin/setup/secret', {
    method: 'POST',
    body: JSON.stringify({ token: TOKEN, username: 'operator' }),
  });
  const secret = secretRes.json?.secret as string;
  check('secret issued', typeof secret === 'string' && secret.length >= 32, secret?.slice(0, 12));
  check('qr is a data uri', String(secretRes.json?.qr).startsWith('data:image/png;base64,'));
  check('otpauth uri well formed', String(secretRes.json?.uri).startsWith('otpauth://totp/'));

  // 3. A wrong code must not enrol.
  const badConfirm = await call('/admin/setup/confirm', {
    method: 'POST',
    body: JSON.stringify({ token: TOKEN, username: 'operator', password: 'correct-horse-battery', secret, code: '000000' }),
  });
  check('wrong enrolment code refused', badConfirm.status === 400, badConfirm.json?.error);

  // 4. Weak password refused.
  const weak = await call('/admin/setup/confirm', {
    method: 'POST',
    body: JSON.stringify({ token: TOKEN, username: 'operator', password: 'short', secret, code: codeFor(secret, stepFor()) }),
  });
  check('weak password refused', weak.status === 400, weak.json?.error);

  // 5. Real enrolment.
  const good = await call('/admin/setup/confirm', {
    method: 'POST',
    body: JSON.stringify({ token: TOKEN, username: 'operator', password: 'correct-horse-battery', secret, code: codeFor(secret, stepFor()) }),
  });
  check('enrolment succeeds', good.status === 200 && good.json?.ok === true, good.json?.error ?? '');
  const recovery: string[] = good.json?.recoveryCodes ?? [];
  check('ten recovery codes returned', recovery.length === 10);

  // 6. Setup is closed afterwards.
  const reopen = await call(`/admin/setup?token=${TOKEN}`);
  check('setup closes after enrolment', reopen.status === 302);

  // 7. Enrolment signs the operator in directly.
  const meAfterSetup = await call('/admin/api/me');
  check('enrolment yields a signed-in session', meAfterSetup.status === 200 && meAfterSetup.json?.username === 'operator');
  await call('/admin/logout', { method: 'POST' });

  // 8. Dashboard is closed to an anonymous caller.
  cookie = '';
  const anon = await call('/admin/api/stats');
  check('api rejects anonymous', anon.status === 401);

  // 8. Wrong password.
  const badPw = await call('/admin/login/password', {
    method: 'POST',
    body: JSON.stringify({ username: 'operator', password: 'wrong' }),
  });
  check('wrong password refused', badPw.status === 401);

  // 9. Right password -> pending session only.
  const pw = await call('/admin/login/password', {
    method: 'POST',
    body: JSON.stringify({ username: 'operator', password: 'correct-horse-battery' }),
  });
  check('password step succeeds', pw.status === 200 && pw.json?.next === 'totp');

  const pending = await call('/admin/api/stats');
  check('pending session cannot read the api', pending.status === 401);

  // 10. Wrong code, then the right one.
  const badCode = await call('/admin/login/totp', { method: 'POST', body: JSON.stringify({ code: '000000' }) });
  check('wrong totp refused', badCode.status === 401);

  // The enrolment burnt the current step, so this uses the next one — which the
  // ±1 verification window accepts, and which avoids a 30-second sleep here.
  const step = stepFor() + 1;
  const totp = await call('/admin/login/totp', { method: 'POST', body: JSON.stringify({ code: codeFor(secret, step) }) });
  check('totp step signs in', totp.status === 200 && totp.json?.ok === true, totp.json?.error ?? '');

  // 11. Replaying the very same code must fail.
  const savedCookie = cookie;
  cookie = '';
  await call('/admin/login/password', { method: 'POST', body: JSON.stringify({ username: 'operator', password: 'correct-horse-battery' }) });
  const replay = await call('/admin/login/totp', { method: 'POST', body: JSON.stringify({ code: codeFor(secret, step) }) });
  check('replayed totp code refused', replay.status === 401 && replay.json?.error === 'code_already_used', replay.json?.error);

  // 12. Back to the real session: read the dashboard APIs.
  cookie = savedCookie;
  const me = await call('/admin/api/me');
  check('me returns identity + csrf', me.status === 200 && me.json?.username === 'operator' && typeof me.json?.csrf === 'string');

  const stats = await call('/admin/api/stats');
  check('stats returns buckets', stats.status === 200 && Array.isArray(stats.json?.byHour), `requests=${stats.json?.requests}`);

  const reqs = await call('/admin/api/requests?limit=5');
  check('requests returns a page', reqs.status === 200 && Array.isArray(reqs.json?.entries), `total=${reqs.json?.total}`);

  const csv = await call('/admin/api/export.csv');
  check('csv export works', csv.status === 200 && csv.text.startsWith('time,uid,feature'), csv.text.slice(0, 30));

  const dash = await call('/admin');
  check('dashboard page serves', dash.status === 200 && dash.text.includes('Requests per hour'));

  // 13. CSRF is enforced on the state-changing call.
  const noCsrf = await call('/admin/api/prune', { method: 'POST', body: JSON.stringify({}) });
  check('prune without csrf refused', noCsrf.status === 403);

  const withCsrf = await call('/admin/api/prune', {
    method: 'POST',
    body: JSON.stringify({ csrf: me.json.csrf }),
  });
  check('prune with csrf accepted', withCsrf.status === 200);

  // 14. Logout invalidates the session.
  await call('/admin/logout', { method: 'POST' });
  const after = await call('/admin/api/stats');
  check('session dead after logout', after.status === 401);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
