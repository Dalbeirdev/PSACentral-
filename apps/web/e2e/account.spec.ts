import { apiLogin, csrfHeaders, expect, freshTotpWindow, test, totpNow, USERS } from './fixtures';
import { E2E_BASE_URL } from './env';

test.describe('user administration → first sign-in', () => {
  test('an admin creates a user on a full page; the temporary password is shown once; the user must replace it', async ({ page, browser }) => {
    await apiLogin(page, USERS.admin);
    await page.goto('/settings/users');
    await page.getByRole('link', { name: 'New user' }).click();
    await expect(page).toHaveURL(/\/settings\/users\/new$/);
    await page.getByRole('button', { name: 'Create user' }).click();
    await expect(page.getByText('Assign at least one role.')).toBeVisible();
    await page.getByLabel('Full name').fill('Morgan Field');
    await page.getByLabel('Email address').fill('morgan.field@psacc.test');
    await page.getByRole('checkbox', { name: /^Technician/ }).check();
    await page.getByRole('button', { name: 'Create user' }).click();
    await expect(page.getByText('Morgan Field was created')).toBeVisible();
    const temp = (await page.getByTestId('temporary-password').textContent())!.trim();
    expect(temp).toMatch(/^[A-Za-z2-9-]{27}$/);

    const ctx = await browser.newContext();
    const p2 = await ctx.newPage();
    await p2.goto('/login');
    await p2.getByLabel('Email address').fill('morgan.field@psacc.test');
    await p2.getByLabel('Password', { exact: true }).fill(temp);
    await p2.getByRole('button', { name: 'Sign in' }).click();
    await expect(p2).toHaveURL(/\/login\/password$/);
    await expect(p2.getByRole('heading', { name: 'Choose a new password' })).toBeVisible();
    // Business pages stay closed until the password is replaced.
    await p2.goto('/dashboard');
    await expect(p2).toHaveURL(/\/login\/password$/);
    await p2.getByLabel('Temporary password').fill(temp);
    await p2.getByLabel('New password', { exact: true }).fill('Field-Engineer-Passphrase-42');
    await p2.getByLabel('Confirm new password').fill('Field-Engineer-Passphrase-42');
    await p2.getByRole('button', { name: 'Save and continue' }).click();
    await expect(p2).toHaveURL(/\/dashboard$/);
    await expect(p2.getByText('showing your assigned clients only')).toBeVisible();
    await ctx.close();
  });

  test('an admin changes roles and disables a user with an inline confirmation', async ({ page }) => {
    await apiLogin(page, USERS.admin);
    const created = await page.request.post(`${E2E_BASE_URL}/api/v1/users`, {
      data: { email: 'inline.confirm@psacc.test', displayName: 'Inline Confirm', roleKeys: ['read_only'] },
      headers: await csrfHeaders(page),
    });
    const { user } = await created.json();
    await page.goto(`/settings/users/${user.id}`);
    await page.getByRole('checkbox', { name: /^Auditor/ }).check();
    await page.getByRole('button', { name: 'Save changes' }).click();
    await expect(page.getByText('Changes saved and recorded in the audit log.')).toBeVisible();
    await page.getByRole('button', { name: 'Disable user…' }).click();
    await expect(page.getByText('Confirm: disable Inline Confirm?')).toBeVisible();
    await page.getByRole('button', { name: 'Yes, disable' }).click();
    await expect(page.getByText('Disabled', { exact: true }).first()).toBeVisible();
  });
});

test.describe('two-step verification', () => {
  test('enroll in Settings, store recovery codes, then sign in with an authenticator code', async ({ page, browser }) => {
    // Fresh user so other tests keep password-only sign-in.
    await apiLogin(page, USERS.admin);
    await page.request.post(`${E2E_BASE_URL}/api/v1/users`, {
      data: { email: 'mfa.e2e@psacc.test', displayName: 'MFA Person', roleKeys: ['auditor'], initialPassword: 'Mfa-E2E-Initial-Pass-1' },
      headers: await csrfHeaders(page),
    });
    const ctx = await browser.newContext();
    const p = await ctx.newPage();
    await apiLogin(p, 'mfa.e2e@psacc.test', 'Mfa-E2E-Initial-Pass-1');
    await p.request.post(`${E2E_BASE_URL}/api/v1/auth/password`, {
      data: { currentPassword: 'Mfa-E2E-Initial-Pass-1', newPassword: 'Mfa-E2E-Second-Pass-2' },
      headers: await csrfHeaders(p),
    });

    await p.goto('/settings/security');
    await p.getByRole('button', { name: 'Set up authenticator app' }).click();
    await expect(p.getByRole('img', { name: 'QR code for authenticator enrollment' })).toBeVisible();
    await p.getByText("Can't scan? Enter the key manually").click();
    const secret = (await p.getByTestId('mfa-secret').textContent())!.replace(/\s/g, '');
    await freshTotpWindow();
    await p.getByLabel('Verification code').fill(totpNow(secret));
    await p.getByRole('button', { name: 'Verify and enable' }).click();
    await expect(p.getByText('Two-step verification is on')).toBeVisible();
    await expect(p.getByTestId('recovery-codes').getByRole('listitem')).toHaveCount(10);
    await expect(p.getByRole('button', { name: 'Continue' })).toBeDisabled();
    await p.getByRole('checkbox', { name: /stored my recovery codes/ }).check();
    await p.getByRole('button', { name: 'Continue' }).click();
    await expect(p.getByText('Two-step verification is enabled.')).toBeVisible();
    await ctx.close();

    const ctx2 = await browser.newContext();
    const q = await ctx2.newPage();
    await q.goto('/login');
    await q.getByLabel('Email address').fill('mfa.e2e@psacc.test');
    await q.getByLabel('Password', { exact: true }).fill('Mfa-E2E-Second-Pass-2');
    await q.getByRole('button', { name: 'Sign in' }).click();
    await expect(q).toHaveURL(/\/login\/mfa$/);
    await q.goto('/dashboard');
    await expect(q).toHaveURL(/\/login\/mfa$/);
    await q.getByLabel('Authentication code').fill('000000');
    await q.getByRole('button', { name: 'Verify and continue' }).click();
    await expect(q.getByRole('alert').filter({ hasText: 'not valid' })).toBeVisible();
    // Wait for the next time step: the enrollment code's step is already used (replay protection).
    await new Promise((r) => setTimeout(r, 30_000 - (Date.now() % 30_000) + 300));
    await q.getByLabel('Authentication code').fill(totpNow(secret));
    await q.getByRole('button', { name: 'Verify and continue' }).click();
    await expect(q).toHaveURL(/\/dashboard$/);
    await ctx2.close();
  });
});

test.describe('profile', () => {
  test('changing the preferred time zone changes displayed timestamps', async ({ page }) => {
    await apiLogin(page, USERS.ops);
    await page.goto('/settings/profile');
    await page.getByLabel('Preferred time zone').selectOption('Asia/Tokyo');
    await page.getByRole('button', { name: 'Save profile' }).click();
    await expect(page.getByText('Profile saved. Times now display in Asia/Tokyo.')).toBeVisible();
    await page.goto('/dashboard');
    await expect(page.getByText('(Asia/Tokyo)')).toBeVisible();
    await expect(page.getByText(/Data as of \d{2}:\d{2} GMT\+9/)).toBeVisible();
  });
});
