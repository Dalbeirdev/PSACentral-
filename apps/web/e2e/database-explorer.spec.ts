import AxeBuilder from '@axe-core/playwright';
import { enrolledDeployment, reports, schemaSnapshot, sendReports } from './agent';
import { apiLogin, expect, test, USERS } from './fixtures';

test.describe('database explorer', () => {
  test('fleet entry point separates synthetic records, filters on the server and opens a deployment', async ({ page }) => {
    await apiLogin(page, USERS.ops);
    const a = await enrolledDeployment(page);
    await page.goto('/database-explorer');
    await expect(page.getByRole('heading', { level: 1, name: 'Database Explorer' })).toBeVisible();
    await expect(page.getByText(/deployments are synthetic sample records/)).toBeVisible();
    const row = page.locator('table tbody tr').filter({ hasText: a.code });
    await expect(row).toContainText('Awaiting first inventory');
    expect((await sendReports(a, reports())).status).toBe(200);
    await page.getByRole('button', { name: 'Refresh' }).click();
    await expect(row).toContainText('Available');
    await expect(row).toContainText('17.6');
    await expect(row).toContainText('1'); // one table in the inventory
    await page.getByRole('link', { name: 'Show live only' }).click();
    await expect(page).toHaveURL(/live=1/);
    await expect(page.getByText('Synthetic', { exact: true })).toHaveCount(0);
    await page.getByRole('navigation', { name: 'Database availability' }).getByRole('link', { name: /Database unavailable/ }).click();
    await expect(page).toHaveURL(/availability=unavailable/);
    await expect(page.locator('table tbody tr').filter({ hasText: a.code })).toHaveCount(0);
    await page.goto('/database-explorer?live=1');
    await page.locator('table tbody tr').filter({ hasText: a.code }).getByRole('link', { name: a.code }).click();
    await expect(page).toHaveURL(new RegExp(`/deployments/${a.id}/database$`));
  });

  test('deployment database page: inventory with labelled estimates, pending then delivered details, table detail, no SQL console', async ({ page }) => {
    await apiLogin(page, USERS.ops);
    const a = await enrolledDeployment(page);
    await page.goto(`/deployments/${a.id}/database`);
    await expect(page.getByText('Awaiting the first inventory')).toBeVisible();
    await sendReports(a, reports());
    await page.getByRole('button', { name: 'Refresh' }).click();
    await expect(page.getByText('Est. rows ≈')).toBeVisible();
    await expect(page.getByText('not an exact count')).toBeVisible();
    const row = page.getByRole('table', { name: 'Table inventory' }).locator('tbody tr').filter({ hasText: 'helpdesk_tickets' });
    await expect(row).toContainText('≈ 0');
    await expect(row).toContainText('Details pending');
    await expect(row.getByRole('link')).toHaveCount(0); // no detail page until details arrive
    await expect(page.getByText('Pending — the agent sends them after the inventory')).toBeVisible();
    expect((await sendReports(a, schemaSnapshot())).status).toBe(200);
    await page.getByRole('button', { name: 'Refresh' }).click();
    await expect(row).toContainText('Analysed');
    await expect(page.getByText('1 of 1 tables')).toBeVisible();
    await expect(page.getByRole('img', { name: 'Largest tables by size' })).toBeVisible();
    // Nothing that could run or browse data.
    await expect(page.locator('main textarea')).toHaveCount(0);
    await expect(page.locator('main button').filter({ hasNotText: 'Refresh' })).toHaveCount(0);
    await expect(page.getByText(/psa_edge_inspector/).first()).toBeVisible();

    await row.getByRole('link', { name: 'helpdesk_tickets' }).click();
    await expect(page).toHaveURL(/\/database\/tables\/public\.helpdesk_tickets$/);
    await expect(page.getByRole('heading', { level: 2, name: 'public.helpdesk_tickets' })).toBeVisible();
    const columns = page.locator('table').first();
    await expect(columns).toContainText('gen_random_uuid()');
    await expect(columns.locator('tbody tr')).toHaveCount(5);
    await expect(page.getByText('helpdesk_tickets_pkey').first()).toBeVisible();
    await expect(page.getByRole('list', { name: 'Foreign keys' })).toContainText('public.psa_connections');
    await expect(page.getByText('CREATE INDEX helpdesk_tickets_status_idx')).toBeVisible();
    await expect(page.getByText('≈ 0').first()).toBeVisible();
    // A table that was never reported is a real 404, not an empty page.
    expect((await page.goto(`/deployments/${a.id}/database/tables/public.nope`))!.status()).toBe(404);
    expect((await page.goto(`/deployments/${a.id}/database/tables/nodot`))!.status()).toBe(404);
  });

  test('permission: a read-only user neither sees the explorer nor its deployment tab', async ({ page }) => {
    await apiLogin(page, USERS.viewer);
    expect((await page.goto('/database-explorer'))!.status()).toBe(404);
    await page.goto('/dashboard');
    await expect(page.getByRole('navigation', { name: 'Primary' }).first().getByRole('link', { name: 'Database Explorer' })).toHaveCount(0);
    const dep = (await (await page.request.get('/api/v1/deployments?q=DEP-00001')).json()).items[0];
    await page.goto(`/deployments/${dep.id}`);
    await expect(page.getByRole('navigation', { name: 'Deployment sections' }).getByRole('link', { name: 'Database' })).toHaveCount(0);
    expect((await page.goto(`/deployments/${dep.id}/database`))!.status()).toBe(404);
  });

  test('explorer pages have no serious accessibility violations and fit a phone', async ({ page }) => {
    await apiLogin(page, USERS.admin);
    const a = await enrolledDeployment(page);
    await sendReports(a, reports());
    await sendReports(a, schemaSnapshot());
    for (const path of ['/database-explorer', `/deployments/${a.id}/database`, `/deployments/${a.id}/database/tables/public.helpdesk_tickets`]) {
      await page.goto(path);
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
      const r = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
      expect(r.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical').map((v) => `${v.id}: ${v.nodes[0]?.target.join(' ')}`), path).toEqual([]);
    }
    await page.setViewportSize({ width: 375, height: 812 });
    for (const path of [`/deployments/${a.id}/database`, `/deployments/${a.id}/database/tables/public.helpdesk_tickets`]) {
      await page.goto(path);
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), path).toBe(true);
    }
  });
});
