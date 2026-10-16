import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';
import { apiLogin, csrfHeaders, expect, test, USERS } from './fixtures';
import { E2E_BASE_URL } from './env';

const PAGES = ['/dashboard', '/audit', '/settings', '/settings/users', '/settings/security', '/settings/roles', '/notifications', '/clients', '/clients/new', '/psa', '/psa/new', '/services', '/services/new', '/services/categories', '/integrations', '/deployments', '/deployments/new', '/docker-images', '/monitoring', '/settings/health', '/settings/retention', '/database-explorer', '/licenses', '/licenses/new'];

async function seriousViolations(page: Page) {
  const r = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
  return r.violations
    .filter((v) => v.impact === 'serious' || v.impact === 'critical')
    .map((v) => `${v.id}: ${v.nodes.slice(0, 3).map((n) => n.target.join(' ')).join(', ')}`);
}

test.describe('accessibility (axe-core, WCAG 2.1 A/AA)', () => {
  test('sign-in page has no serious or critical violations', async ({ page }) => {
    await page.goto('/login');
    expect(await seriousViolations(page)).toEqual([]);
  });

  for (const path of PAGES) {
    test(`${path} has no serious or critical violations`, async ({ page }) => {
      await apiLogin(page, USERS.admin);
      await page.goto(path);
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
      expect(await seriousViolations(page)).toEqual([]);
    });
  }

  test('client pages and every onboarding data step have no serious or critical violations', async ({ page }) => {
    await apiLogin(page, USERS.admin);
    const client = (await (await page.request.get(`${E2E_BASE_URL}/api/v1/clients?q=Harbor`)).json()).items[0].id as string;
    for (const sub of ['', '/edit', '/contacts', '/contacts/new', '/services', '/psa', '/deployments', '/health', '/activity']) {
      await page.goto(`/clients/${client}${sub}`);
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
      expect(await seriousViolations(page), sub || 'overview').toEqual([]);
    }
    // Module 13: the deployment Operations tab (an enrolled appliance with the issue panel open).
    const dep = (await (await page.request.get(`${E2E_BASE_URL}/api/v1/deployments?pageSize=100`)).json()).items.find((d: { lifecycleState: string; isSynthetic: boolean }) => !d.isSynthetic) as { id: string } | undefined;
    if (dep) {
      await page.goto(`/deployments/${dep.id}/operations`);
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
      const card = page.getByTestId('command-restart_service');
      if (await card.count()) await card.click();
      expect(await seriousViolations(page), 'operations').toEqual([]);
    }
    const draft = (await (await page.request.post(`${E2E_BASE_URL}/api/v1/onboarding/drafts`, { headers: await csrfHeaders(page) })).json()).id as string;
    await page.goto(`/clients/new/${draft}/client`);
    await expect(page.getByRole('heading', { level: 1, name: 'Client information' })).toBeVisible();
    expect(await seriousViolations(page), 'wizard step 1').toEqual([]);
  });
});
