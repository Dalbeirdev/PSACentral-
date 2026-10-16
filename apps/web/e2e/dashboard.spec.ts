import type { DashboardSummary } from '@psacc/contracts';
import { apiLogin, expect, test, USERS } from './fixtures';
import { E2E_BASE_URL } from './env';

test.describe('operations dashboard', () => {
  test.beforeEach(async ({ page }) => {
    await apiLogin(page, USERS.admin);
  });

  test('KPI cards show exactly the values returned by the API (no hard-coded data)', async ({ page }) => {
    const summary = (await (await page.request.get(`${E2E_BASE_URL}/api/v1/dashboard/summary`)).json()) as DashboardSummary;
    await page.goto('/dashboard');
    const k = summary.kpis;
    const expected: Record<string, number> = {
      'kpi-clients': k.totalClients,
      'kpi-psa': k.totalPsaInstances,
      'kpi-active': k.activeDeployments,
      'kpi-offline': k.offlineDeployments,
      'kpi-healthy': k.healthyInstallations,
      'kpi-critical': k.criticalAlerts,
      'kpi-versions': k.dockerVersionsInUse,
      'kpi-recent': k.recentDeploymentsLast30Days,
    };
    for (const [id, value] of Object.entries(expected)) {
      await expect(page.getByTestId(`${id}-value`), id).toHaveText(String(value));
    }
    expect(k.totalClients).toBeGreaterThanOrEqual(26);
  });

  test('synthetic data is labeled everywhere it appears', async ({ page }) => {
    await page.goto('/dashboard');
    await expect(page.getByRole('status').filter({ hasText: 'Development sample data' })).toBeVisible();
    const rows = page.locator('table tbody tr').filter({ has: page.locator('a[href^="/deployments/"]') });
    await expect(rows.first()).toBeVisible();
    const count = await rows.count();
    for (let i = 0; i < count; i++) {
      const row = rows.nth(i);
      if ((await row.getByText('Synthetic', { exact: true }).count()) > 0) {
        // Synthetic rows never show a heartbeat time as if it were live.
        await expect(row.getByText('Synthetic — not live')).toBeVisible();
      } else {
        // Real records created in this run have not enrolled: no heartbeat, honestly shown.
        await expect(row.getByText('Never')).toBeVisible();
      }
    }
  });

  test('every chart renders and has a data-table equivalent', async ({ page }) => {
    await page.goto('/dashboard');
    for (const title of ['Installation status over time', 'Deployment health', 'Client onboarding', 'PSA provider distribution', 'Deployment version distribution']) {
      const card = page.locator('section').filter({ has: page.getByRole('heading', { name: title, exact: true }) });
      await expect(card, title).toBeVisible();
      await card.getByText('View data table').click();
      await expect(card.locator('details table tbody tr').first(), `${title} table`).toBeVisible();
    }
    await expect(page.locator('.recharts-surface').first()).toBeVisible();
    // Provider list: all 7 providers from the catalog are in use in the synthetic dataset.
    await expect(page.getByRole('list', { name: 'PSA instances per provider' }).getByRole('listitem')).toHaveCount(7);
  });

  test('refresh re-fetches without a full reload', async ({ page }) => {
    await page.goto('/dashboard');
    await page.evaluate(() => ((window as unknown as { __marker: number }).__marker = 1));
    await page.getByRole('button', { name: 'Refresh' }).click();
    await expect(page.getByRole('button', { name: 'Refresh' })).toBeEnabled();
    expect(await page.evaluate(() => (window as unknown as { __marker?: number }).__marker)).toBe(1);
  });

  test('global search finds clients and deployments on a full results page', async ({ page }) => {
    await page.goto('/dashboard');
    await page.getByRole('searchbox', { name: /Search clients/ }).fill('Bluepeak');
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(/\/search\?q=Bluepeak$/);
    await expect(page.getByRole('heading', { level: 1 })).toContainText('Bluepeak');
    await expect(page.getByRole('link', { name: /Bluepeak Logistics/ }).first()).toBeVisible();
  });

  test('notifications list critical deployments from live records', async ({ page }) => {
    await page.goto('/notifications');
    await expect(page.getByRole('heading', { level: 1, name: 'Notifications' })).toBeVisible();
    await expect(page.getByText(/is critical$/).first()).toBeVisible();
  });
});

test.describe('navigation', () => {
  test.beforeEach(async ({ page }) => {
    await apiLogin(page, USERS.admin);
  });

  test('every sidebar destination loads with a heading; planned modules are clearly marked', async ({ page }) => {
    await page.goto('/dashboard');
    const nav = page.getByRole('navigation', { name: 'Primary' }).first();
    const hrefs = await nav.locator('a').evaluateAll((as) => as.map((a) => a.getAttribute('href')!));
    expect(hrefs).toEqual([
      '/dashboard', '/clients', '/psa', '/services', '/deployments', '/docker-images', '/database-explorer',
      '/monitoring', '/integrations', '/licenses', '/audit', '/settings',
    ]);
    const planned: Record<string, number> = {}; // every sidebar destination is delivered (Modules 1–14)
    for (const href of hrefs) {
      await nav.locator(`a[href="${href}"]`).click();
      await expect(page).toHaveURL(new RegExp(`${href}$`));
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
      if (planned[href]) {
        await expect(page.getByText(`Planned · Module ${planned[href]}`)).toBeVisible();
        await expect(page.getByText('Not available in this build')).toBeVisible();
        // No pretend controls: the only actionable element in the content is "Back to overview".
        await expect(page.locator('main button')).toHaveCount(0);
      }
    }
  });

  test('unknown deep links are real 404s, never placeholders', async ({ page }) => {
    expect((await page.goto('/licenses/entitlements/abc'))!.status()).toBe(404);
    expect((await page.goto('/licenses/00000000-0000-4000-8000-000000000000'))!.status()).toBe(404);
    // A deployment that does not exist is a real 404, not a placeholder.
    expect((await page.goto('/deployments/00000000-0000-4000-8000-000000000000'))!.status()).toBe(404);
  });

  test('unknown routes show the 404 page', async ({ page }) => {
    const r = await page.goto('/definitely-not-a-page');
    expect(r!.status()).toBe(404);
    await expect(page.getByRole('heading', { name: 'Page not found' })).toBeVisible();
  });
});
