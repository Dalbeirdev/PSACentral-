import { commandResult, enrolledDeployment, heartbeat, reports, sendReports } from './agent';
import { apiLogin, csrfHeaders, expect, test, USERS } from './fixtures';

/**
 * Module 13 — Remote operations in the browser, with a simulated agent over real mTLS: issue a
 * command, watch it go pending → delivered → succeeded, cancel one, stage an upgrade, and the RBAC
 * and honesty rules of the page.
 */
test.describe('remote operations', () => {
  test('issue, deliver, answer and cancel commands from the Operations tab', async ({ page }) => {
    await apiLogin(page, USERS.admin);
    const a = await enrolledDeployment(page);
    await page.goto(`/deployments/${a.id}/operations`);
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Operations' })).toHaveAttribute('aria-current', 'page');
    await expect(page.getByTestId('no-commands')).toBeVisible();
    await expect(page.getByTestId('signing-key')).toHaveText(/^[0-9a-f]{16}$/);
    await expect(page.getByTestId('running-version')).toContainText('Not reported yet');

    // Restart a service: choose the command, pick the service, confirm inline (no dialog).
    await page.getByTestId('command-restart_service').click();
    await expect(page.getByTestId('issue-panel')).toContainText('Runs on: agent');
    await page.getByTestId('command-service').selectOption('edge-worker');
    await page.getByLabel('Note (kept with the audit record)').fill('Worker stuck after maintenance');
    await page.getByTestId('issue-command').click();
    await expect(page.getByTestId('command-row')).toHaveCount(1);
    const row = page.getByTestId('command-row').first();
    await expect(row).toContainText('Restart a service');
    await expect(row).toContainText('edge-worker');
    await expect(row).toContainText('Worker stuck after maintenance');
    await expect(row.getByTestId('command-status')).toHaveText('Waiting for the agent');
    await expect(row).toContainText(`by ${USERS.admin}`);
    // The same type cannot be issued twice while open.
    await expect(page.getByTestId('command-restart_service')).toBeDisabled();

    // The agent fetches it with its heartbeat: delivered.
    const hb = await heartbeat(a);
    expect(hb.status).toBe(200);
    const cmds = hb.body.commands as { id: string; type: string; signature: string }[];
    expect(cmds).toHaveLength(1);
    expect(cmds[0]!.type).toBe('restart_service');
    await page.getByRole('button', { name: 'Refresh', exact: true }).click();
    await expect(row.getByTestId('command-status')).toHaveText('Delivered — running on the appliance');
    await expect(page.getByTestId('cancel-command')).toHaveCount(0); // delivered commands cannot be cancelled

    // The agent answers: succeeded, with its message and version.
    const res = await commandResult(a, cmds[0]!.id, { code: 'restarting', message: 'The worker exits after this answer; Docker Compose starts it again.' });
    expect(res.status).toBe(200);
    await page.getByRole('button', { name: 'Refresh', exact: true }).click();
    await expect(row.getByTestId('command-status')).toHaveText('Succeeded');
    await expect(row.getByTestId('command-message')).toContainText('Docker Compose starts it again');
    await expect(row).toContainText('agent 0.1.0');
    await expect(page.getByTestId('command-restart_service')).toBeEnabled();

    // Cancel a pending one before the agent sees it.
    await page.getByTestId('command-refresh_health').click();
    await page.getByTestId('issue-command').click();
    await expect(page.getByTestId('command-row')).toHaveCount(2);
    await page.getByTestId('cancel-command').click();
    await expect(page.getByTestId('command-row').first().getByTestId('command-status')).toHaveText('Cancelled');
    expect(((await heartbeat(a)).body.commands as unknown[]).length).toBe(0);

    // Upgrade: staged by the agent, then reported once the new version runs; the appliance image is then up to date.
    await page.getByTestId('command-upgrade').click();
    await expect(page.getByTestId('issue-panel')).toContainText('Runs on: host operator');
    await page.getByTestId('issue-command').click();
    const up = ((await heartbeat(a)).body.commands as { id: string; type: string }[]).find((c) => c.type === 'upgrade')!;
    expect(up).toBeTruthy();
    expect((await commandResult(a, up.id, { status: 'staged', code: 'staged', message: 'Upgrade to psacc/psa-edge:0.1.0 staged. On the appliance host run: scripts/upgrade.sh' })).status).toBe(200);
    await page.getByRole('button', { name: 'Refresh', exact: true }).click();
    await expect(page.getByTestId('command-row').first().getByTestId('command-status')).toHaveText('Staged — waiting for the host operator');
    await expect(page.getByTestId('command-row').first()).toContainText('scripts/upgrade.sh');
    expect((await commandResult(a, up.id, { code: 'upgraded', message: 'The appliance now runs version 0.1.0.' })).status).toBe(200);
    expect((await sendReports(a, reports({ versions: { agent: '0.1.0', image: '0.1.0', application: '0.1.0', schema: '0004', postgres: '17.6' } }))).status).toBe(200);
    await page.getByRole('button', { name: 'Refresh', exact: true }).click();
    await expect(page.getByTestId('running-version')).toContainText('0.1.0');
    await expect(page.getByTestId('running-version')).toContainText('up to date');
    await expect(page.getByTestId('command-upgrade')).toBeDisabled();

    // The activity log carries issue, completion, cancellation and staging events.
    await page.goto(`/deployments/${a.id}/logs`);
    for (const action of ['deployment.command.issued', 'deployment.command.completed', 'deployment.command.cancelled', 'deployment.command.staged']) {
      await expect(page.getByText(action).first()).toBeVisible();
    }
  });

  test('the health page can ask the appliance to report now', async ({ page }) => {
    await apiLogin(page, USERS.admin);
    const a = await enrolledDeployment(page);
    await page.goto(`/deployments/${a.id}/health`);
    await page.getByTestId('report-now').click();
    await expect(page.getByRole('status')).toContainText('Asked the appliance to report now');
    const hb = await heartbeat(a);
    expect((hb.body.commands as { type: string }[]).map((c) => c.type)).toEqual(['refresh_health']);
    await page.getByRole('link', { name: 'Follow it on Operations' }).click();
    await expect(page.getByTestId('command-row').first()).toContainText('Refresh health now');
  });

  test('viewers follow but cannot issue; drafts and synthetic records say why; nothing destructive is offered', async ({ page }) => {
    await apiLogin(page, USERS.admin);
    const a = await enrolledDeployment(page);
    const headers = await csrfHeaders(page);
    expect((await page.request.post(`/api/v1/deployments/${a.id}/commands`, { data: { type: 'decommission' }, headers })).status()).toBe(400);
    await apiLogin(page, USERS.viewer);
    await page.goto(`/deployments/${a.id}/operations`);
    await expect(page.getByText('Issuing commands needs the')).toBeVisible();
    await expect(page.getByTestId('command-refresh_health')).toHaveCount(0);
    expect((await page.request.post(`/api/v1/deployments/${a.id}/commands`, { data: { type: 'refresh_health' }, headers: await csrfHeaders(page) })).status()).toBe(403);
    await apiLogin(page, USERS.admin);
    const draft = (await (await page.request.get('/api/v1/deployments?pageSize=100')).json()).items.find((d: { lifecycleState: string; isSynthetic: boolean }) => d.lifecycleState === 'draft' && !d.isSynthetic);
    if (draft) {
      await page.goto(`/deployments/${draft.id}/operations`);
      await expect(page.getByText('Commands cannot be issued yet')).toBeVisible();
    }
    await page.goto(`/deployments/${a.id}/operations`);
    for (const t of ['Suspend', 'Decommission', 'Uninstall', 'Revoke']) await expect(page.getByRole('button', { name: new RegExp(t) })).toHaveCount(0);
    await expect(page.getByText('deliberately not commands today')).toBeVisible();
  });
});
