import { apiLogin, csrfHeaders, expect, test, USERS } from './fixtures';
import { E2E_BASE_URL } from './env';

test.describe('role-based UI', () => {
  test('a Read Only user sees no administration and cannot reach it by URL', async ({ page }) => {
    await apiLogin(page, USERS.viewer);
    await page.goto('/dashboard');
    const nav = page.getByRole('navigation', { name: 'Primary' }).first();
    await expect(nav.getByRole('link', { name: 'Activity & Audit Logs' })).toHaveCount(0);
    await expect(nav.getByRole('link', { name: 'Database Explorer' })).toHaveCount(0);
    await page.goto('/settings');
    await expect(page.getByRole('navigation', { name: 'Settings' }).getByRole('link', { name: 'Users' })).toHaveCount(0);
    expect((await page.goto('/audit'))!.status()).toBe(404);
    expect((await page.goto('/settings/users'))!.status()).toBe(404);
    // The API refuses regardless of the UI.
    const r = await page.request.post(`${E2E_BASE_URL}/api/v1/users`, {
      data: { email: 'x@psacc.test', displayName: 'X Y', roleKeys: ['read_only'] },
      headers: await csrfHeaders(page),
    });
    expect(r.status()).toBe(403);
  });

  test('a Technician sees only assigned clients', async ({ page }) => {
    await apiLogin(page, USERS.technician);
    await page.goto('/dashboard');
    await expect(page.getByText('showing your assigned clients only')).toBeVisible();
    await expect(page.getByTestId('kpi-clients-value')).toHaveText('4');
    await expect(page.getByText('Access: assigned clients only')).toBeVisible();
  });

  test('an Auditor can read the audit log but has no write controls', async ({ page }) => {
    await apiLogin(page, USERS.auditor);
    await page.goto('/audit');
    await expect(page.getByRole('heading', { level: 1, name: 'Activity & audit logs' })).toBeVisible();
    await expect(page.locator('table tbody tr').first()).toBeVisible();
    await page.goto('/settings/users');
    await expect(page.getByRole('link', { name: 'New user' })).toHaveCount(0);
  });
});

test.describe('audit log', () => {
  test('filters, sorts and paginates on the server', async ({ page }) => {
    await apiLogin(page, USERS.admin);
    await page.goto('/audit');
    await page.getByLabel('Category').selectOption('auth.login');
    await page.getByRole('button', { name: 'Apply' }).click();
    await expect(page).toHaveURL(/action=auth\.login/);
    const actions = await page.locator('table tbody tr td:nth-child(2) > span.font-mono').allTextContents();
    expect(actions.length).toBeGreaterThan(0);
    expect(actions.every((a) => a.startsWith('auth.login'))).toBe(true);
    await page.getByRole('link', { name: /^Action/ }).click();
    await expect(page).toHaveURL(/sort=action%3Aasc/);
  });
});
