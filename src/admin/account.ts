import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs';
import { dirname, resolve } from 'path';
import { randomBytes, scryptSync, timingSafeEqual } from 'crypto';
import { config } from '../config';
import { log } from '../log';

/**
 * scrypt rather than a plain hash: it is memory-hard, so an attacker who
 * steals the file cannot brute-force it on a GPU at the speed SHA-256 would
 * allow. These are the Node defaults with a raised cost — `N=2^15` takes
 * roughly 100ms here, which is nothing on a login and a great deal across a
 * dictionary.
 */
const SCRYPT = { N: 32768, r: 8, p: 1, keylen: 64 };

function hash(secret: string, salt: Buffer): Buffer {
  // maxmem must be raised alongside N, or scrypt refuses the parameters.
  return scryptSync(secret.normalize('NFKC'), salt, SCRYPT.keylen, {
    ...SCRYPT,
    maxmem: 128 * SCRYPT.N * SCRYPT.r * 2,
  });
}

/** `salt:derived`, both hex. Self-describing, so a rotation can change params. */
export function hashSecret(secret: string): string {
  const salt = randomBytes(16);
  return `${salt.toString('hex')}:${hash(secret, salt).toString('hex')}`;
}

export function verifySecret(secret: string, stored: string): boolean {
  const [saltHex, expectedHex] = stored.split(':');
  if (!saltHex || !expectedHex) return false;
  try {
    const expected = Buffer.from(expectedHex, 'hex');
    const actual = hash(secret, Buffer.from(saltHex, 'hex'));
    return expected.length === actual.length && timingSafeEqual(expected, actual);
  } catch {
    return false;
  }
}

export interface AdminAccount {
  username: string;
  /** scrypt, `salt:derived`. */
  passwordHash: string;
  /** Base32 TOTP secret. Plain by necessity: TOTP needs it to compute codes. */
  totpSecret: string;
  /** scrypt hashes of the unused recovery codes; a used one is removed. */
  recoveryHashes: string[];
  /**
   * The last TOTP step accepted. A code is valid for 30 seconds, so without
   * this a code shoulder-surfed or replayed inside its own window would work
   * a second time.
   */
  lastTotpStep: number;
  createdAt: number;
  lastLoginAt?: number;
}

let account: AdminAccount | null = null;
let loaded = false;
let filePath = '';

function pathOf(): string {
  if (!filePath) filePath = resolve(config.adminAccountPath);
  return filePath;
}

function load(): void {
  if (loaded) return;
  loaded = true;
  const path = pathOf();
  if (!existsSync(path)) return;
  try {
    account = JSON.parse(readFileSync(path, 'utf8')) as AdminAccount;
  } catch (e) {
    // Refusing to boot would lock the operator out of their own gateway over a
    // file they can simply delete and re-enrol, so this is a loud warning.
    log.error(`admin account file unreadable (${(e as Error).message}); re-run setup`);
  }
}

function persist(): void {
  const path = pathOf();
  try {
    mkdirSync(dirname(path), { recursive: true });
  } catch {
    // Already there, or unwritable — the write below reports the real problem.
  }
  // Written through a temporary file so an interrupted save cannot leave a
  // half-written account that locks the operator out.
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(account, null, 2), { encoding: 'utf8', mode: 0o600 });
  renameSync(tmp, path);
}

export function getAccount(): AdminAccount | null {
  load();
  return account;
}

/** True before anyone has enrolled — the only state in which setup is allowed. */
export function needsSetup(): boolean {
  return getAccount() === null;
}

export interface Enrolment {
  account: AdminAccount;
  /** Shown once, never recoverable afterwards. */
  recoveryCodes: string[];
}

/** Ten single-use codes, formatted in two groups so they can be read aloud. */
function makeRecoveryCodes(): string[] {
  return Array.from({ length: 10 }, () => {
    const raw = randomBytes(5).toString('hex').toUpperCase();
    return `${raw.slice(0, 5)}-${raw.slice(5, 10)}`;
  });
}

export function createAccount(
  username: string,
  password: string,
  totpSecret: string,
): Enrolment {
  const recoveryCodes = makeRecoveryCodes();
  account = {
    username: username.trim(),
    passwordHash: hashSecret(password),
    totpSecret,
    recoveryHashes: recoveryCodes.map(hashSecret),
    lastTotpStep: 0,
    createdAt: Date.now(),
  };
  loaded = true;
  persist();
  log.info(`admin account created (user=${account.username})`);
  return { account, recoveryCodes };
}

export function markTotpStepUsed(step: number): void {
  if (!account) return;
  account.lastTotpStep = step;
  persist();
}

export function markLogin(): void {
  if (!account) return;
  account.lastLoginAt = Date.now();
  persist();
}

/**
 * Spends a recovery code, if it matches an unused one.
 *
 * Every stored hash is checked even after a match, so the time taken does not
 * reveal how many codes remain.
 */
export function consumeRecoveryCode(code: string): boolean {
  if (!account) return false;
  const cleaned = code.trim().toUpperCase();
  let matchedAt = -1;
  account.recoveryHashes.forEach((stored, i) => {
    if (verifySecret(cleaned, stored) && matchedAt === -1) matchedAt = i;
  });
  if (matchedAt === -1) return false;
  account.recoveryHashes.splice(matchedAt, 1);
  persist();
  log.warn(
    `admin signed in with a recovery code (${account.recoveryHashes.length} left)`,
  );
  return true;
}

/** Replaces the TOTP secret, for re-enrolling a lost or replaced phone. */
export function resetTotp(totpSecret: string): void {
  if (!account) return;
  account.totpSecret = totpSecret;
  account.lastTotpStep = 0;
  persist();
  log.warn('admin TOTP secret was reset');
}
