import { apiLogin, expect, test, USERS } from './fixtures';

const noHorizontalOverflow = async (page: import('@playwright/test').Page) =>
  page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);

test.describe('mobile layout (375 px)', () => {
  test('sign-in fits the screen', async ({ page }) => {
    await page.goto('/login');
    await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible();
    expect(await noHorizontalOverflow(page)).toBe(true);
  });

  for (const path of ['/dashboard', '/audit', '/settings/users', '/settings/security', '/clients', '/clients/new', '/psa', '/psa/new', '/services', '/services/new', '/services/categories', '/integrations', '/deployments', '/deployments/new', '/docker-images', '/monitoring', '/settings/health', '/settings/retention', '/database-explorer', '/licenses', '/licenses/new']) {
    test(`${path} has no horizontal page scroll`, async ({ page }) => {
      await apiLogin(page, USERS.admin);
      await page.goto(path);
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
      expect(await noHorizontalOverflow(page)).toBe(true);
    });
  }

  test('navigation collapses into a menu that expands inline (no overlay) and navigates', async ({ page }) => {
    await apiLogin(page, USERS.admin);
    await page.goto('/dashboard');
    await expect(page.getByTestId('kpi-clients')).toBeVisible();
    const kpiTop = (await page.getByTestId('kpi-clients').boundingBox())!.y;
    await page.getByRole('button', { name: 'Open navigation' }).click();
    const menu = page.locator('#mobile-nav');
    await expect(menu).toBeVisible();
    // Inline: the content is pushed down rather than covered.
    expect((await page.getByTestId('kpi-clients').boundingBox())!.y).toBeGreaterThan(kpiTop);
    await menu.getByRole('link', { name: 'Settings' }).click();
    await expect(page).toHaveURL(/\/settings$/);
    await expect(menu).toBeHidden();
  });

  test('KPI cards stack in a single column', async ({ page }) => {
    await apiLogin(page, USERS.admin);
    await page.goto('/dashboard');
    await expect(page.getByTestId('kpi-psa')).toBeVisible();
    const a = (await page.getByTestId('kpi-clients').boundingBox())!;
    const b = (await page.getByTestId('kpi-psa').boundingBox())!;
    expect(Math.abs(a.x - b.x)).toBeLessThan(2);
    expect(b.y).toBeGreaterThan(a.y + a.height - 1);
  });
});

test.describe('mobile client pages (375 px)', () => {
  test('client overview and wizard step fit the screen', async ({ page }) => {
    await apiLogin(page, USERS.admin);
    const id = (await (await page.request.get('/api/v1/clients?q=Bluepeak')).json()).items[0].id;
    for (const path of [`/clients/${id}`, `/clients/${id}/contacts`, `/clients/${id}/edit`]) {
      await page.goto(path);
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
      expect(await noHorizontalOverflow(page), path).toBe(true);
    }
    const r = await page.request.post('/api/v1/onboarding/drafts', { headers: { origin: 'http://localhost:3310', 'x-csrf-token': (await page.context().cookies()).find((c) => c.name === 'psacc_csrf')!.value } });
    const draft = (await r.json()).id;
    await page.goto(`/clients/new/${draft}/client`);
    await expect(page.getByRole('heading', { level: 1, name: 'Client information' })).toBeVisible();
    expect(await noHorizontalOverflow(page)).toBe(true);
  });

  test('PSA instance detail and configure pages fit the screen', async ({ page }) => {
    await apiLogin(page, USERS.admin);
    const id = (await (await page.request.get('/api/v1/psa-instances?provider=connectwise')).json()).items[0].id;
    for (const path of [`/psa/${id}`, `/psa/${id}/configure`]) {
      await page.goto(path);
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
      expect(await noHorizontalOverflow(page), path).toBe(true);
    }
  });

  test('deployment overview and installation pages fit the screen', async ({ page }) => {
    await apiLogin(page, USERS.admin);
    const id = (await (await page.request.get('/api/v1/deployments?q=DEP-00001')).json()).items[0].id;
    for (const path of [`/deployments/${id}`, `/deployments/${id}/installation`, `/deployments/${id}/operations`]) {
      await page.goto(path);
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
      expect(await noHorizontalOverflow(page), path).toBe(true);
    }
  });
});
