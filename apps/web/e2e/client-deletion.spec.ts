import { deleteFromAppliance, enrolledDeployment, heartbeat, reports, sendReports } from './agent';
import { E2E_BASE_URL } from './env';
import { apiLogin, expect, test, USERS } from './fixtures';

/**
 * Module 17 — Client-initiated deletion from the appliance, seen from the dashboard: the simulated agent
 * deletes its deployment over its own identity; the deployment is gone everywhere; the one audit event
 * that remains is visible in Activity & audit logs and on the client's activity tab.
 */
test.describe('client-initiated deletion', () => {
  test('the appliance deletes the deployment; only the audit event remains and is visible', async ({ page }) => {
    await apiLogin(page, USERS.admin);
    const a = await enrolledDeployment(page);
    expect((await heartbeat(a)).status).toBe(200);
    expect((await sendReports(a, reports())).status).toBe(200);
    await page.goto(`/deployments/${a.id}`);
    await expect(page.getByRole('heading', { name: a.code })).toBeVisible();
    const client = (await (await page.request.get(`${E2E_BASE_URL}/api/v1/deployments/${a.id}`)).json()).client as { id: string; displayName: string };

    const r = await deleteFromAppliance(a, 'harpal', 'Switching providers');
    expect(r.status).toBe(200);
    expect(r.body.status).toBe('deleted');
    expect((r.body.deleted as Record<string, number>).deployments).toBe(1);
    // The certificate is unknown now; a retry is answered "already deleted".
    expect((await heartbeat(a)).status).toBe(401);
    expect((await deleteFromAppliance(a, 'harpal', 'Switching providers')).body.status).toBe('already-deleted');

    // Gone from the Control Plane: the detail answers 404 and the list no longer carries the code.
    expect((await page.request.get(`${E2E_BASE_URL}/api/v1/deployments/${a.id}`)).status()).toBe(404);
    await page.goto('/deployments');
    await expect(page.getByRole('heading', { name: 'Deployments' })).toBeVisible();
    await expect(page.getByRole('link', { name: a.code, exact: true })).toHaveCount(0);

    // The audit trail shows who asked, from which appliance, with the counts.
    await page.goto(`/audit?q=${encodeURIComponent(a.code)}&action=deployment.deleted_by_client`);
    await expect(page.getByText('deployment.deleted_by_client').first()).toBeVisible();
    await expect(page.getByText(`Appliance ${a.code} (local administrator harpal)`).first()).toBeVisible();
    await expect(page.getByRole('combobox', { name: 'Category' })).toHaveValue('deployment.deleted_by_client');

    // The client's activity tab carries the same event.
    await page.goto(`/clients/${client.id}/activity`);
    await expect(page.getByText('deployment.deleted_by_client').first()).toBeVisible();
  });
});
