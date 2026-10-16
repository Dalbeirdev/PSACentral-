import { apiLogin, expect, test, USERS } from './fixtures';
import { SEED_PASSWORD } from './env';

test.describe('sign-in', () => {
  test('unauthenticated visitors are sent to the full-page sign-in', async ({ page }) => {
    await page.goto('/dashboard');
    await expect(page).toHaveURL(/\/login$/);
    await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
    await page.goto('/audit?outcome=failure');
    await expect(page).toHaveURL(/\/login\?next=%2Faudit%3Foutcome%3Dfailure$/);
  });

  test('client-side validation and a wrong password show inline errors (no pop-ups)', async ({ page }) => {
    await page.goto('/login');
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page.getByText('Enter a valid email address.')).toBeVisible();
    await page.getByLabel('Email address').fill(USERS.viewer);
    await page.getByLabel('Password', { exact: true }).fill('not-the-right-password');
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page.getByRole('alert').filter({ hasText: 'Invalid email or password.' })).toBeVisible();
    await expect(page.getByLabel('Password', { exact: true })).toHaveValue('');
  });

  test('a valid sign-in lands on the requested page, and sign-out ends the session', async ({ page }) => {
    await page.goto('/audit');
    await expect(page).toHaveURL(/\/login\?next=%2Faudit/);
    await page.getByLabel('Email address').fill(USERS.admin);
    await page.getByLabel('Password', { exact: true }).fill(SEED_PASSWORD());
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page).toHaveURL(/\/audit$/);
    await expect(page.getByRole('heading', { level: 1, name: 'Activity & audit logs' })).toBeVisible();

    await page.getByRole('button', { name: /Account menu/ }).click();
    await page.getByRole('menuitem', { name: 'Sign out' }).click();
    await expect(page).toHaveURL(/\/login\?signedOut=1$/);
    await expect(page.getByText('You have been signed out.')).toBeVisible();
    await page.goto('/dashboard');
    await expect(page).toHaveURL(/\/login/);
  });

  test('open-redirect attempts via ?next= are ignored', async ({ page }) => {
    await page.goto('/login?next=//evil.example/phish');
    await page.getByLabel('Email address').fill(USERS.viewer);
    await page.getByLabel('Password', { exact: true }).fill(SEED_PASSWORD());
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page).toHaveURL(/localhost:3310\/dashboard$/);
  });

  test('a signed-in user visiting /login is sent to the dashboard', async ({ page }) => {
    await apiLogin(page, USERS.viewer);
    await page.goto('/login');
    await expect(page).toHaveURL(/\/dashboard$/);
  });

  test('pages are served with a nonce-based Content-Security-Policy and hardening headers', async ({ page }) => {
    const res = await page.goto('/login');
    const h = res!.headers();
    expect(h['content-security-policy']).toMatch(/script-src 'self' 'nonce-[^']+' 'strict-dynamic'/);
    expect(h['content-security-policy']).toContain("frame-ancestors 'none'");
    expect(h['x-frame-options']).toBe('DENY');
    expect(h['x-content-type-options']).toBe('nosniff');
    expect(h['x-powered-by']).toBeUndefined();
  });
});
