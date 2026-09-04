import { readFileSync } from 'fs';
import { resolve } from 'path';
import admin from 'firebase-admin';
import { config } from './config';
import { log } from './log';

function loadServiceAccount(): admin.ServiceAccount {
  const path = resolve(config.serviceAccountPath);
  try {
    const raw = readFileSync(path, 'utf8');
    return JSON.parse(raw) as admin.ServiceAccount;
  } catch (e) {
    log.error(
      `Cannot read service account at "${path}". ` +
        `Set SERVICE_ACCOUNT_PATH in .env and download the key from the ` +
        `smartdrink-ai Firebase console, or set AUTH_MODE=none for local dev.`,
    );
    throw e;
  }
}

let auth: admin.auth.Auth | null = null;

/**
 * Initialised lazily so `AUTH_MODE=none` can run without a service account
 * file — handy for local development against a provider key alone.
 */
export function getAuth(): admin.auth.Auth {
  if (!auth) {
    const app = admin.initializeApp({
      credential: admin.credential.cert(loadServiceAccount()),
    });
    const projectId = (app.options.credential as any)?.projectId ?? 'unknown';
    log.info(`firebase-admin initialized (project=${projectId})`);
    auth = admin.auth();
  }
  return auth;
}
