import AxeBuilder from '@axe-core/playwright';
import { apiLogin, expect, test, USERS } from './fixtures';
import { E2E_BASE_URL } from './env';

/** Module 4 — Service Catalog: database-driven catalog administration, all on full pages with inline confirmation. */
test.describe('service catalog', () => {
  test('the catalog lists database rows and filters by category, status and dependency on the server', async ({ page }) => {
    await apiLogin(page, USERS.ops);
    await page.goto('/services');
    await expect(page.getByRole('heading', { level: 1, name: 'Service Catalog' })).toBeVisible();
    const rows = page.locator('table tbody tr');
    expect(await rows.count()).toBeGreaterThanOrEqual(18);
    await page.getByRole('link', { name: /^Security/ }).first().click();
    await expect(page).toHaveURL(/category=security/);
    for (const t of await rows.locator('td:nth-child(2)').allTextContents()) expect(t).toBe('Security');
    await page.goto('/services');
    await page.getByLabel('Dependency').selectOption('rmm');
    await page.getByRole('button', { name: 'Apply' }).click();
    await expect(page).toHaveURL(/dependency=rmm/);
    await expect(rows).toHaveCount(2);
    await page.getByLabel('Status').selectOption('inactive');
    await page.getByRole('button', { name: 'Apply' }).click();
    await expect(page.getByText('No services match these filters')).toBeVisible();
    await page.getByRole('link', { name: 'Clear' }).click();
    await expect(page).toHaveURL(/\/services$/);
  });

  test('create a service on a full page: inline validation, key suggestion, PSA consistency and a configuration requirement', async ({ page }) => {
    await apiLogin(page, USERS.ops);
    await page.goto('/services');
    await page.getByRole('link', { name: 'New service' }).click();
    await expect(page).toHaveURL(/\/services\/new$/);
    await page.getByRole('button', { name: 'Create service' }).click();
    await expect(page.getByRole('alert').filter({ hasText: 'Some fields need attention.' })).toBeVisible();
    await expect(page.getByText('Enter a name.')).toBeVisible();

    await page.getByLabel('Service name').fill('Dark Web Monitoring');
    await expect(page.getByLabel('Key')).toHaveValue('dark_web_monitoring');
    await page.getByLabel('Category').selectOption({ label: 'Security' });
    await page.getByLabel('Description').fill('Credential exposure monitoring with PSA ticket escalation.');
    // Choosing a PSA data dependency switches the PSA flag on (the API would refuse the inconsistent combination).
    const usesPsa = page.getByRole('checkbox', { name: /Uses the client’s PSA/ });
    await expect(usesPsa).not.toBeChecked();
    await page.getByRole('checkbox', { name: /^PSA tickets/ }).check();
    await expect(usesPsa).toBeChecked();
    await page.getByRole('checkbox', { name: /^EDR \/ security platform/ }).check();

    await page.getByRole('button', { name: 'Add setting' }).click();
    const row = page.getByTestId('requirement-row').first();
    await row.getByLabel('Label').fill('Monitored domains');
    await row.getByLabel('Key').fill('monitoredDomains');
    await row.getByRole('checkbox', { name: /Required/ }).check();
    await page.getByRole('button', { name: 'Add setting' }).click();
    const secret = page.getByTestId('requirement-row').nth(1);
    await secret.getByLabel('Label').fill('Vendor API token');
    await secret.getByLabel('Key').fill('apiToken');
    await page.getByRole('button', { name: 'Create service' }).click();
    await expect(page.getByText('Credentials are entered on the client’s appliance; the catalog holds no secrets.')).toBeVisible();
    await secret.getByRole('button', { name: 'Remove setting 2' }).click();

    await page.getByRole('button', { name: 'Create service' }).click();
    await expect(page).toHaveURL(/\/services\/[0-9a-f-]{36}\?saved=created$/);
    await expect(page.getByRole('heading', { level: 1, name: /Dark Web Monitoring/ })).toBeVisible();
    await expect(page.getByText('Service created and recorded in the activity history.')).toBeVisible();
    await expect(page.getByText('Monitored domains', { exact: true })).toBeVisible();
    await expect(page.getByRole('table', { name: /PSA provider support/ })).toBeVisible(); // dependency matrix from adapter descriptors
    await expect(page.getByText('service.created')).toBeVisible();
    const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
    expect(results.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical')).toEqual([]);
  });

  test('edit, deactivate with inline confirmation (assignments kept), reactivate; the key is immutable', async ({ page }) => {
    await apiLogin(page, USERS.ops);
    const svc = (await (await page.request.get(`${E2E_BASE_URL}/api/v1/services?q=dark_web`)).json())[0];
    await page.goto(`/services/${svc.id}/edit`);
    await expect(page.getByLabel('Key').first()).toHaveAttribute('readonly', '');
    await page.getByLabel('Description').first().fill('Credential exposure monitoring, takedown requests and PSA ticket escalation.');
    await page.getByRole('button', { name: 'Save service' }).click();
    await expect(page).toHaveURL(new RegExp(`/services/${svc.id}\\?saved=updated$`));
    await expect(page.getByText('Service saved and recorded in the activity history.')).toBeVisible();
    await expect(page.getByText('service.updated').first()).toBeVisible();

    await page.getByRole('button', { name: 'Deactivate' }).click();
    await expect(page.getByRole('group', { name: 'Confirm deactivation' })).toContainText('It can no longer be assigned');
    await page.getByRole('button', { name: 'Yes, deactivate' }).click();
    await expect(page.getByText('Service deactivated. Existing client assignments are kept; new ones are refused.')).toBeVisible();
    await expect(page.getByText('Inactive', { exact: true }).first()).toBeVisible();
    await page.goto('/services?status=inactive');
    await expect(page.locator('table tbody tr')).toHaveCount(1);
    await page.goto(`/services/${svc.id}`);
    await page.getByRole('button', { name: 'Activate' }).click();
    await page.getByRole('button', { name: 'Yes, activate' }).click();
    await expect(page.getByText('Service activated. It can be assigned to clients again.')).toBeVisible();
  });

  test('assigning the service to a client requires its settings; the deployment reflects the assignment', async ({ page }) => {
    await apiLogin(page, USERS.ops);
    const client = (await (await page.request.get(`${E2E_BASE_URL}/api/v1/clients?q=Bluepeak`)).json()).items[0];
    await page.goto(`/clients/${client.id}/services`);
    await page.getByRole('checkbox', { name: /^Dark Web Monitoring/ }).check();
    const settings = page.getByTestId('service-dark_web_monitoring');
    await expect(settings.getByText('Settings for Dark Web Monitoring')).toBeVisible();
    await page.getByRole('button', { name: 'Save services' }).click();
    await expect(page.getByText('Monitored domains is required.')).toBeVisible();
    await settings.getByLabel('Monitored domains').fill('bluepeak.example');
    await page.getByRole('button', { name: 'Save services' }).click();
    await expect(page.getByText('Services saved and recorded in the activity history.')).toBeVisible();
    await page.reload();
    await expect(page.getByRole('checkbox', { name: /^Dark Web Monitoring/ })).toBeChecked();
    await expect(page.getByTestId('service-dark_web_monitoring').getByLabel('Monitored domains')).toHaveValue('bluepeak.example');

    const svc = (await (await page.request.get(`${E2E_BASE_URL}/api/v1/services?q=dark_web`)).json())[0];
    await page.goto(`/services/${svc.id}`);
    await expect(page.getByRole('list', { name: 'Assigned clients' })).toContainText('Bluepeak');
    // The deployment sees the assignment with complete settings; because the service uses the PSA, it runs on the
    // appliance only once it is enabled on the deployment's PSA instance (so the page keeps listing Help Desk only).
    const dep = (await (await page.request.get(`${E2E_BASE_URL}/api/v1/deployments?clientId=${client.id}`)).json()).items[0];
    if (dep) {
      const detail = await (await page.request.get(`${E2E_BASE_URL}/api/v1/deployments/${dep.id}`)).json();
      expect(detail.services.find((s: { key: string }) => s.key === 'dark_web_monitoring')).toMatchObject({ requiresPsa: true, enabledOnPsa: false, configComplete: true });
      expect(detail.readiness.find((c: { key: string }) => c.key === 'service_config')).toMatchObject({ ok: true });
      await page.goto(`/deployments/${dep.id}`);
      await expect(page.getByText('Help Desk · via PSA')).toBeVisible();
      await expect(page.getByText('Dark Web Monitoring · via PSA')).toHaveCount(0);
    }
    // Clean up so other specs see Bluepeak's original services.
    await page.goto(`/clients/${client.id}/services`);
    await page.getByRole('checkbox', { name: /^Dark Web Monitoring/ }).uncheck();
    await page.getByRole('button', { name: 'Save services' }).click();
    await expect(page.getByText('Services saved and recorded in the activity history.')).toBeVisible();
  });

  test('categories: create on the same page, rename on a full page, delete only when empty (inline confirmation)', async ({ page }) => {
    await apiLogin(page, USERS.ops);
    await page.goto('/services/categories');
    await expect(page.getByRole('heading', { level: 1, name: 'Service categories' })).toBeVisible();
    await page.getByLabel('Category name').fill('Compliance');
    await expect(page.getByLabel('Key')).toHaveValue('compliance');
    await page.getByRole('button', { name: 'Create category' }).click();
    await expect(page.getByText('Category created and recorded in the activity history.')).toBeVisible();
    await page.getByRole('link', { name: 'Edit Compliance' }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'Edit Compliance' })).toBeVisible();
    await page.getByLabel('Category name').fill('Compliance & GRC');
    await page.getByRole('button', { name: 'Save category' }).click();
    await expect(page.getByText('Category saved and recorded in the activity history.')).toBeVisible();
    await expect(page.locator('table')).toContainText('Compliance & GRC');
    await page.getByRole('link', { name: 'Edit Compliance & GRC' }).click();
    await page.getByRole('button', { name: 'Delete category' }).click();
    await page.getByRole('button', { name: 'Yes, delete' }).click();
    await expect(page.getByText('Category deleted and recorded in the activity history.')).toBeVisible();
    await expect(page.locator('table')).not.toContainText('Compliance & GRC');
    // A category in use explains why it cannot be deleted.
    await page.getByRole('link', { name: 'Edit Security' }).click();
    await expect(page.getByText(/service\(s\)\. Move them to another category before deleting it\./)).toBeVisible();
    await expect(page.getByRole('button', { name: 'Delete category' })).toHaveCount(0);
  });

  test('read-only users browse the catalog without write controls; write pages are not found for them', async ({ page }) => {
    await apiLogin(page, USERS.viewer);
    await page.goto('/services');
    await expect(page.getByRole('heading', { level: 1, name: 'Service Catalog' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'New service' })).toHaveCount(0);
    await page.locator('table tbody tr').first().getByRole('link').first().click();
    await expect(page.getByRole('link', { name: 'Edit' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: /Deactivate|Activate/ })).toHaveCount(0);
    await page.goto('/services/new');
    await expect(page.getByText(/not found|404/i).first()).toBeVisible();
    await page.goto('/services/categories');
    await expect(page.getByRole('button', { name: 'Create category' })).toHaveCount(0);
    await expect(page.getByRole('link', { name: /^Edit / })).toHaveCount(0);
  });
});
