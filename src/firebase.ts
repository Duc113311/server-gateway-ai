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
 *
 * Two credential paths, and which one runs is decided by whether
 * SERVICE_ACCOUNT_PATH is set:
 *
 * - **empty** — Application Default Credentials. On Cloud Run, Cloud
 *   Functions or GCE inside the same GCP project, the runtime service account
 *   is read from the metadata server, so there is no key file to ship, to
 *   mount, or to leak. This is what a deployment should use.
 * - **a path** — the downloaded service account JSON. For running outside
 *   Google's infrastructure, and for local work against the real project.
 */
export function getAuth(): admin.auth.Auth {
  if (!auth) {
    const useAdc = config.serviceAccountPath === '';
    const app = admin.initializeApp(
      useAdc
        ? { credential: admin.credential.applicationDefault() }
        : { credential: admin.credential.cert(loadServiceAccount()) },
    );
    const projectId = (app.options.credential as any)?.projectId ?? 'unknown';
    log.info(
      `firebase-admin initialized (project=${projectId} ` +
        `credential=${useAdc ? 'application-default' : 'service-account-file'})`,
    );
    auth = admin.auth();
  }
  return auth;
}
