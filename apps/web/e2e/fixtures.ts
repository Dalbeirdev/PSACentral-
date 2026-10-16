import { createHmac } from 'node:crypto';
import { test as base, expect, type Page } from '@playwright/test';
import { E2E_BASE_URL, SEED_PASSWORD } from './env';

export const USERS = {
  admin: 'avery.admin@psacc.test',
  ops: 'jordan.ops@psacc.test',
  technician: 'riley.technician@psacc.test',
  tech: 'morgan.tech@psacc.test',
  auditor: 'taylor.audit@psacc.test',
  viewer: 'quinn.viewer@psacc.test',
};

/**
 * Every test fails if the app opens a browser dialog (alert/confirm/prompt) — the product
 * forbids pop-up workflows — or logs a console error.
 */
export const test = base.extend<{ consoleErrors: string[] }>({
  consoleErrors: [
    async ({ page }, use) => {
      const errors: string[] = [];
      page.on('dialog', async (d) => {
        errors.push(`Unexpected browser dialog: ${d.type()} "${d.message()}"`);
        await d.dismiss();
      });
      page.on('console', (m) => {
        // Expected API rejections (e.g. a deliberately wrong password) are logged by the browser as
        // network errors; they are asserted in the tests themselves.
        if (m.type() === 'error' && !/Failed to load resource: the server responded with a status of 4\d\d/.test(m.text())) {
          errors.push(`console.error: ${m.text()}`);
        }
      });
      page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
      await use(errors);
      expect(errors, 'no dialogs, uncaught errors or console errors').toEqual([]);
    },
    { auto: true },
  ],
});
export { expect };

/** Signs in through the same-origin API (fast path). Cookies land in the browser context. */
export async function apiLogin(page: Page, email: string, password = SEED_PASSWORD()) {
  const r = await page.request.post(`${E2E_BASE_URL}/api/v1/auth/login`, {
    data: { email, password },
    headers: { origin: E2E_BASE_URL },
  });
  expect(r.status(), `login ${email}`).toBe(200);
  return (await r.json()) as { state: string; redirectTo: string };
}

export async function csrfHeaders(page: Page): Promise<Record<string, string>> {
  const cookies = await page.context().cookies();
  const csrf = cookies.find((c) => c.name === 'psacc_csrf')?.value ?? '';
  return { origin: E2E_BASE_URL, 'x-csrf-token': csrf };
}

/** RFC 6238 TOTP (SHA-1, 6 digits, 30 s) — the test plays the role of the authenticator app. */
export function totpNow(base32Secret: string, at = Date.now()): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = 0;
  let value = 0;
  const bytes: number[] = [];
  for (const ch of base32Secret.replace(/\s/g, '').toUpperCase()) {
    value = (value << 5) | alphabet.indexOf(ch);
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(at / 30_000)));
  const mac = createHmac('sha1', Buffer.from(bytes)).update(counter).digest();
  const o = mac[mac.length - 1]! & 15;
  const bin = ((mac[o]! & 127) << 24) | (mac[o + 1]! << 16) | (mac[o + 2]! << 8) | mac[o + 3]!;
  return (bin % 1_000_000).toString().padStart(6, '0');
}

/** Waits until at least `ms` remain in the current 30 s TOTP window (avoids edge flakiness). */
export async function freshTotpWindow(ms = 8_000) {
  const remaining = 30_000 - (Date.now() % 30_000);
  if (remaining < ms) await new Promise((r) => setTimeout(r, remaining + 250));
}
