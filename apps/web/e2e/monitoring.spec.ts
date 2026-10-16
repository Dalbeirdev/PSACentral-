import AxeBuilder from '@axe-core/playwright';
import { enrolledDeployment, reports, sendReports } from './agent';
import { apiLogin, expect, test, USERS } from './fixtures';

test.describe('health monitoring', () => {
  test('fleet page separates synthetic sample states from live ones and filters on the server', async ({ page }) => {
    await apiLogin(page, USERS.ops);
    const a = await enrolledDeployment(page);
    expect((await sendReports(a, reports())).status).toBe(200);
    await page.goto('/monitoring');
    await expect(page.getByRole('heading', { level: 1, name: 'Health Monitoring' })).toBeVisible();
    await expect(page.getByText(/deployments are synthetic sample records/)).toBeVisible();
    await expect(page.getByTestId('health-healthy')).not.toHaveText('0');
    await page.getByRole('link', { name: 'Show live only' }).click();
    await expect(page).toHaveURL(/live=1/);
    await expect(page.getByText('Synthetic', { exact: true })).toHaveCount(0);
    const row = page.locator('table tbody tr').filter({ hasText: a.code });
    await expect(row).toContainText('Healthy');
    await expect(row.getByRole('meter', { name: 'CPU usage' })).toHaveAttribute('aria-valuenow', '23.4');
    await expect(row).toContainText('Available');
    await page.getByRole('navigation', { name: 'Health states' }).getByRole('link', { name: /Critical/ }).click();
    await expect(page).toHaveURL(/state=critical/);
    await expect(page.locator('table tbody tr').filter({ hasText: a.code })).toHaveCount(0);
  });

  test('deployment health: scorecard, findings and timeline follow real reports; database down turns critical', async ({ page }) => {
    await apiLogin(page, USERS.ops);
    const a = await enrolledDeployment(page);
    await page.goto(`/deployments/${a.id}/health`);
    await expect(page.getByText('Awaiting the first agent reports')).toBeVisible();
    await expect(page.getByText('Not yet — needs a healthy evaluation')).toBeVisible();
    await sendReports(a, reports());
    await page.getByRole('button', { name: 'Refresh' }).click();
    await expect(page.getByText('All checks passed.')).toBeVisible();
    await expect(page.getByRole('main').getByLabel(/Lifecycle: Verified/)).toBeVisible();
    await expect(page.getByRole('meter', { name: 'Disk usage' })).toHaveAttribute('aria-valuenow', '55');
    await expect(page.getByRole('img', { name: 'Resource utilisation chart' })).toBeVisible();
    await expect(page.getByText('PSA credentials not entered yet (redacted message example)')).toBeVisible();
    await sendReports(a, reports({ database: { available: false, error: 'database_unavailable' } }));
    await page.getByRole('button', { name: 'Refresh' }).click();
    await expect(page.getByTestId('health-reason')).toHaveText('PostgreSQL is not available (database_unavailable).');
    await expect(page.getByRole('list', { name: 'Findings' })).toContainText('database_unavailable');
    const timeline = page.locator('ol').filter({ hasText: 'agent' }).first();
    await expect(timeline).toContainText('Critical');
    await expect(timeline).toContainText('Healthy');
    await page.goto(`/deployments/${a.id}/logs`);
    await expect(page.getByText('psa_not_configured')).toBeVisible();
    await expect(page.getByText('agent.enrolled')).toBeVisible();
  });

  test('the health policy is edited on a full page, validated inline, and applied to live deployments', async ({ page }) => {
    await apiLogin(page, USERS.admin);
    const a = await enrolledDeployment(page);
    await sendReports(a, reports()); // disk 55 %
    await page.goto('/settings/health');
    await expect(page.getByRole('heading', { name: 'Health policy' })).toBeVisible();
    await expect(page.getByRole('navigation', { name: 'Settings' }).getByRole('link', { name: 'Health policy' })).toHaveAttribute('aria-current', 'page');
    await page.getByLabel('Disk warning (%)').fill('97');
    await page.getByRole('button', { name: 'Save policy' }).click();
    await expect(page.getByText('The critical threshold must be above the warning threshold.')).toBeVisible();
    await page.getByLabel('Disk warning (%)').fill('50');
    await page.getByRole('button', { name: 'Save policy' }).click();
    await expect(page.getByText('Health policy saved.')).toBeVisible();
    await page.goto(`/deployments/${a.id}/health`);
    await expect(page.getByTestId('health-reason')).toHaveText('Disk usage is 55% (warning above 50%).');
    await page.goto('/settings/health');
    await page.getByRole('button', { name: 'Reset to defaults' }).click();
    await page.getByRole('button', { name: 'Save policy' }).click();
    await expect(page.getByText('Health policy saved.')).toBeVisible();
    await page.context().clearCookies();
    await apiLogin(page, USERS.viewer);
    expect((await page.goto('/settings/health'))!.status()).toBe(404);
    await page.goto('/monitoring');
    await expect(page.getByRole('link', { name: 'Health policy' })).toHaveCount(0);
  });

  test('monitoring pages have no serious accessibility violations', async ({ page }) => {
    await apiLogin(page, USERS.admin);
    const a = await enrolledDeployment(page);
    await sendReports(a, reports());
    for (const path of ['/monitoring', `/deployments/${a.id}/health`, `/deployments/${a.id}/logs`, '/settings/health']) {
      await page.goto(path);
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
      const r = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
      expect(r.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical').map((v) => `${v.id}: ${v.nodes[0]?.target}`), path).toEqual([]);
    }
  });
});
