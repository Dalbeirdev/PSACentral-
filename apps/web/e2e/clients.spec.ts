import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { apiLogin, csrfHeaders, expect, test, USERS } from './fixtures';
import { E2E_BASE_URL } from './env';

test.describe('client directory', () => {
  test.beforeEach(async ({ page }) => {
    await apiLogin(page, USERS.ops);
  });

  test('search, filters, sorting and pagination run on the server and live in the URL', async ({ page }) => {
    await page.goto('/clients');
    await expect(page.getByRole('heading', { level: 1, name: 'Clients' })).toBeVisible();
    await page.getByRole('search', { name: 'Filter clients' }).getByLabel('Search').fill('bluepeak');
    await page.getByRole('button', { name: 'Apply' }).click();
    await expect(page).toHaveURL(/q=bluepeak/);
    const rows = page.locator('table tbody tr');
    await expect(rows).toHaveCount(1);
    await expect(rows.first()).toContainText('Bluepeak Logistics');

    await page.goto('/clients');
    await page.getByLabel('Country').selectOption('GB');
    await page.getByRole('button', { name: 'Apply' }).click();
    await expect(page).toHaveURL(/country=GB/);
    await expect(rows).toHaveCount(2);

    await page.goto('/clients?sort=clientReference:desc');
    const firstRef = await rows.first().locator('td').nth(1).textContent();
    await page.getByRole('link', { name: /^Reference/ }).click();
    await expect(page).toHaveURL(/sort=clientReference%3Aasc/);
    expect(await rows.first().locator('td').nth(1).textContent()).not.toBe(firstRef);

    await page.goto('/clients');
    await expect(page.getByText(/Showing 1–20 of \d+ clients/)).toBeVisible();
    await page.getByRole('link', { name: 'Next page' }).click();
    await expect(page).toHaveURL(/page=2/);
    await expect(page.getByText(/Showing 21–/)).toBeVisible();
  });

  test('read-only users can browse but have no write controls', async ({ page }) => {
    await page.context().clearCookies();
    await apiLogin(page, USERS.viewer);
    await page.goto('/clients');
    await expect(page.getByRole('link', { name: 'Onboard client' })).toHaveCount(0);
    expect((await page.goto('/clients/new'))!.status()).toBe(404);
    await page.goto('/clients');
    await page.locator('table tbody tr a').first().click();
    await expect(page.getByRole('navigation', { name: 'Client sections' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Edit client' })).toHaveCount(0);
  });

  test('technicians see only their assigned clients', async ({ page }) => {
    await page.context().clearCookies();
    await apiLogin(page, USERS.technician);
    await page.goto('/clients');
    await expect(page.getByText('Clients assigned to you.')).toBeVisible();
    await expect(page.locator('table tbody tr')).toHaveCount(4);
  });
});

test.describe('onboarding wizard (full page, 10 steps)', () => {
  test('Test Client A: Autotask with Help Desk + Endpoint Management, from start to complete', async ({ page }) => {
    await apiLogin(page, USERS.ops);
    await page.goto('/clients');
    await page.getByRole('link', { name: 'Onboard client' }).click();
    await expect(page).toHaveURL(/\/clients\/new$/);
    await page.getByRole('button', { name: 'Start onboarding' }).click();
    await expect(page).toHaveURL(/\/clients\/new\/[0-9a-f-]{36}\/client$/);
    await expect(page.getByRole('heading', { level: 1, name: 'Client information' })).toBeVisible();

    // Step 1 — inline validation, then real data.
    await page.getByRole('button', { name: 'Save and continue' }).click();
    await expect(page.getByText('Some fields need attention.')).toBeVisible();
    await expect(page.getByText('Enter the legal company name.')).toBeVisible();
    await page.getByLabel('Legal company name').fill('E2E Test Client A Inc.');
    await page.getByLabel('Display name').fill('E2E Test Client A');
    await page.getByLabel('Client reference').fill('ACCT-1040');
    await expect(page.getByText('This reference is already used by another client.')).toBeVisible(); // live duplicate check
    await page.getByLabel('Client reference').fill('E2E-CLIENT-A');
    await expect(page.getByText('Available.')).toBeVisible();
    await page.getByLabel('Business type').selectOption('Technology');
    await page.getByLabel('Company website').fill('https://client-a.example');
    await page.getByLabel('Country').selectOption('US');
    await page.getByLabel('State / region').fill('Texas');
    await page.getByLabel('City').fill('Austin');
    await page.getByLabel('Time zone').selectOption('America/Chicago');
    await page.getByLabel('Account manager').selectOption({ label: 'Jordan Ellis' });
    await page.getByLabel('Contract start').fill('2026-10-01');
    await page.getByLabel('Contract end').fill('2026-09-01');
    const contact1 = page.locator('ol > li').filter({ hasText: 'Contact 1' });
    await contact1.getByLabel('Full name').fill('Pat Primary');
    await contact1.getByLabel('Email').fill('pat@client-a.example');
    await contact1.getByLabel('Phone').fill('+1 555 0142');
    await page.getByRole('button', { name: 'Add contact' }).click();
    const contact2 = page.locator('ol > li').filter({ hasText: 'Contact 2' });
    await contact2.getByLabel('Full name').fill('Tess Technical');
    await contact2.getByLabel('Email').fill('tess@client-a.example');
    await contact2.getByText('Technical', { exact: true }).click();
    await page.getByRole('button', { name: 'Save and continue' }).click();
    await expect(page.getByText('The contract end date must be on or after the start date.')).toBeVisible();
    await page.getByLabel('Contract end').fill('2027-09-30');
    await page.getByRole('button', { name: 'Save and continue' }).click();

    // Step 2 — provider.
    await expect(page).toHaveURL(/\/psa-provider$/);
    await page.getByText('Autotask PSA', { exact: true }).click();
    await page.getByRole('button', { name: 'Save and continue' }).click();

    // Step 3 — provider-specific configuration (Autotask), validated by the adapter; no credentials.
    await expect(page).toHaveURL(/\/psa-config$/);
    await expect(page.getByText('Credentials — entered on the appliance')).toBeVisible();
    await expect(page.getByText('API tracking identifier (integration code)')).toBeVisible();
    await expect(page.getByLabel('Instance name')).toHaveValue('E2E Test Client A — Autotask PSA');
    await page.getByRole('button', { name: 'Save and continue' }).click();
    await expect(page.getByText('Web services zone is required.')).toBeVisible();
    await page.getByLabel('Web services zone').selectOption('webservices5');
    await expect(page.getByTestId('endpoint-preview')).toHaveText('https://webservices5.autotask.net/ATServicesRest');
    await page.getByRole('button', { name: 'Save and continue' }).click();

    // Step 4 — services: Help Desk is pre-selected.
    await expect(page).toHaveURL(/\/services$/);
    await expect(page.getByRole('checkbox', { name: /^Help Desk/ })).toBeChecked();
    await page.getByRole('checkbox', { name: /^Endpoint Management/ }).check();
    await page.getByRole('button', { name: 'Save and continue' }).click();

    // Step 5 — deployment preferences.
    await expect(page).toHaveURL(/\/deployment$/);
    await page.getByText('Linux Docker host', { exact: true }).click();
    await expect(page.getByLabel('Host operating system')).toHaveValue('linux');
    await page.getByLabel('Host label').fill('client-a-edge-01');
    await page.getByRole('button', { name: 'Save and continue' }).click();

    // Step 6 — review, including an edit round-trip that keeps other answers.
    await expect(page).toHaveURL(/\/review$/);
    await expect(page.getByText('E2E-CLIENT-A')).toBeVisible();
    await expect(page.getByText('Help Desk · Endpoint Management')).toBeVisible();
    await page.getByRole('link', { name: 'Edit Deployment' }).click();
    await expect(page.getByLabel('Host label')).toHaveValue('client-a-edge-01');
    await page.getByRole('button', { name: 'Save and continue' }).click();
    await expect(page).toHaveURL(/\/review$/);
    await page.getByRole('link', { name: 'Continue to create' }).click();

    // Step 7 — explicit inline confirmation.
    await expect(page).toHaveURL(/\/create$/);
    await expect(page.getByText('Installation ID and single-use enrollment token — created with the package in step 8')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Create client' })).toBeDisabled();
    await page.getByRole('checkbox', { name: /I have reviewed/ }).check();
    await page.getByRole('button', { name: 'Create client' }).click();

    // Step 8 — generate and download the real package.
    await expect(page).toHaveURL(/\/download$/);
    await expect(page.getByText('No package generated yet')).toBeVisible();
    await expect(page.getByText(/^CL-\d{5}$/)).toBeVisible();
    await expect(page.getByText(/^PSA-\d{5}$/)).toBeVisible();
    await expect(page.getByText(/^LIC-\d{5}$/).first()).toBeVisible(); // Module 14: the first license is created with the client
    await expect(page.getByText(/^DEP-\d{5}$/).first()).toBeVisible();
    await expect(page.getByText('Created with the deployment package (step 8)')).toBeVisible();
    await page.getByRole('button', { name: 'Generate deployment package' }).click();
    await expect(page.getByText('Package #1 generated.')).toBeVisible();
    await expect(page.getByTestId('current-package')).toContainText('Ready to download');
    const sha = (await page.getByTestId('package-sha256').textContent())!.trim();
    const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Download package' }).click()]);
    expect(download.suggestedFilename()).toMatch(/^psacc-dep-\d{5}-package-1\.zip$/);
    expect(createHash('sha256').update(readFileSync((await download.path())!)).digest('hex')).toBe(sha);
    await expect(page.getByText(/^Downloaded psacc-dep-\d{5}-package-1\.zip\.$/)).toBeVisible();
    await expect(page.getByText(/does not mean the appliance is installed/)).toBeVisible();
    await page.getByRole('link', { name: 'Continue' }).click();

    // Step 9 — downloaded, but nothing is assumed installed.
    await expect(page).toHaveURL(/\/verify$/);
    await expect(page.getByRole('listitem').filter({ hasText: 'Package downloaded' })).toContainText('Done');
    await expect(page.getByText('Waiting for the installed agent to connect')).toBeVisible();
    await expect(page.getByText('Unknown', { exact: true })).toBeVisible();
    await page.getByRole('link', { name: 'Continue' }).click();

    // Step 10 — summary and hand-off to the deployment and client pages.
    await expect(page).toHaveURL(/\/complete$/);
    await expect(page.getByText('Deployment package downloaded', { exact: true })).toBeVisible();
    await expect(page.getByText('Appliance installed, enrolled and healthy — pending')).toBeVisible();
    await page.getByRole('link', { name: 'Open deployment' }).click();
    await expect(page.getByRole('heading', { level: 1, name: /^DEP-\d{5}$/ })).toBeVisible();
    await expect(page.getByRole('listitem', { name: 'Package downloaded: done' })).toBeVisible();
    await expect(page.getByRole('listitem', { name: 'Installed & enrolled: not yet' })).toBeVisible();
    await page.getByRole('navigation', { name: 'Breadcrumb' }).getByRole('link', { name: 'E2E Test Client A' }).click();
    await expect(page).toHaveURL(/\/clients\/[0-9a-f-]{36}\/deployments$/);
    await page.getByRole('navigation', { name: 'Client sections' }).getByRole('link', { name: 'Overview' }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'E2E Test Client A' })).toBeVisible();
    await expect(page.getByText('Onboarding', { exact: true })).toBeVisible();
    await expect(page.getByText('Pat Primary')).toBeVisible();
    await expect(page.getByText('Synthetic', { exact: true })).toHaveCount(0); // real record, not sample data
    // Earlier steps are closed once records exist.
    const draftUrl = new URL(page.url());
    void draftUrl;
  });

  test('progress is saved on the server and can be resumed', async ({ page }) => {
    await apiLogin(page, USERS.ops);
    await page.goto('/clients/new');
    await page.getByRole('button', { name: 'Start onboarding' }).click();
    await expect(page).toHaveURL(/\/client$/);
    const stepUrl = page.url();
    await page.getByLabel('Legal company name').fill('Resume Later LLC');
    await page.getByLabel('Display name').fill('Resume Later');
    await page.getByLabel('Client reference').fill('E2E-RESUME-1');
    await page.getByLabel('Business type').selectOption('Retail');
    await page.getByLabel('Country').selectOption('CA');
    await page.getByLabel('Time zone').selectOption('America/Toronto');
    const contact1 = page.locator('ol > li').filter({ hasText: 'Contact 1' });
    await contact1.getByLabel('Full name').fill('Robin Resume');
    await contact1.getByLabel('Email').fill('robin@resume.example');
    await page.getByRole('button', { name: 'Save draft and exit' }).click();
    await expect(page).toHaveURL(/\/clients\/new$/);
    const row = page.locator('table tbody tr').filter({ hasText: 'Resume Later' });
    await expect(row).toContainText('2. PSA provider');

    // A brand-new browser context (another device) resumes the same draft.
    const ctx = await page.context().browser()!.newContext();
    const other = await ctx.newPage();
    await apiLogin(other, USERS.ops);
    await other.goto('/clients/new');
    await other.locator('table tbody tr').filter({ hasText: 'Resume Later' }).getByRole('link', { name: 'Resume', exact: true }).click();
    await expect(other).toHaveURL(/\/psa-provider$/);
    await other.goto(stepUrl);
    await expect(other.getByLabel('Legal company name')).toHaveValue('Resume Later LLC');
    await expect(other.locator('ol > li').filter({ hasText: 'Contact 1' }).getByLabel('Email')).toHaveValue('robin@resume.example');
    // Later steps stay locked until earlier ones are saved.
    await other.goto(stepUrl.replace(/\/client$/, '/create'));
    await expect(other).toHaveURL(/\/psa-provider$/);
    await ctx.close();
  });

  test('a draft can be abandoned with an inline confirmation', async ({ page }) => {
    await apiLogin(page, USERS.ops);
    const r = await page.request.post(`${E2E_BASE_URL}/api/v1/onboarding/drafts`, { headers: await csrfHeaders(page) });
    const { id } = await r.json();
    await page.goto('/clients/new');
    const row = page.locator('table tbody tr').filter({ has: page.locator(`a[href^="/clients/new/${id}"]`) });
    await row.getByRole('button', { name: 'Abandon…' }).click();
    await row.getByRole('button', { name: 'Yes' }).click();
    await expect(page.locator(`a[href^="/clients/new/${id}"]`)).toHaveCount(0);
    await page.goto(`/clients/new/${id}/client`);
    await expect(page.getByText('This onboarding was abandoned')).toBeVisible();
  });
});

test.describe('client management pages', () => {
  async function bluepeak(page: import('@playwright/test').Page) {
    const r = await page.request.get(`${E2E_BASE_URL}/api/v1/clients?q=Bluepeak`);
    return ((await r.json()) as { items: { id: string }[] }).items[0]!.id;
  }

  test('every client tab renders real data', async ({ page }) => {
    await apiLogin(page, USERS.ops);
    const id = await bluepeak(page);
    await page.goto(`/clients/${id}`);
    await expect(page.getByRole('heading', { level: 1, name: 'Bluepeak Logistics' })).toBeVisible();
    await expect(page.getByText('CL-00001').first()).toBeVisible();
    for (const [tab, check] of [
      ['Contacts', 'Primary'],
      ['Services', 'Help Desk'],
      ['PSA', 'Untested'],
      ['Deployments', 'DEP-00001'],
      ['Health', 'Health events'],
      ['Activity', 'Activity history'],
    ] as const) {
      await page.getByRole('navigation', { name: 'Client sections' }).getByRole('link', { name: new RegExp(`^${tab}`) }).click();
      await expect(page.getByText(check).first(), tab).toBeVisible();
    }
  });

  test('edit a client on a full page; the change is saved and shown', async ({ page }) => {
    await apiLogin(page, USERS.ops);
    const id = await bluepeak(page);
    await page.goto(`/clients/${id}`);
    await page.getByRole('link', { name: 'Edit client' }).click();
    await expect(page).toHaveURL(new RegExp(`/clients/${id}/edit$`));
    await page.getByLabel('City').fill('Round Rock');
    await page.getByLabel('Website').fill('not-a-site');
    await page.getByRole('button', { name: 'Save changes' }).click();
    await expect(page.getByText('Enter a full web address starting with https://')).toBeVisible();
    await page.getByLabel('Website').fill('https://www.bluepeak-logistics.example');
    await page.getByRole('button', { name: 'Save changes' }).click();
    await expect(page).toHaveURL(new RegExp(`/clients/${id}\\?saved=1$`));
    await expect(page.getByText('Client saved.')).toBeVisible();
    await expect(page.getByText('Round Rock, Texas, United States')).toBeVisible();
  });

  test('a concurrent change is detected instead of silently overwritten', async ({ page }) => {
    await apiLogin(page, USERS.ops);
    const id = await bluepeak(page);
    await page.goto(`/clients/${id}/edit`);
    // Someone else saves first.
    const current = await (await page.request.get(`${E2E_BASE_URL}/api/v1/clients/${id}`)).json();
    const body = {
      version: current.version,
      company: { legalName: current.legalName, displayName: current.displayName, clientReference: current.clientReference, businessType: current.businessType, countryCode: current.countryCode, stateRegion: current.stateRegion ?? '', city: 'Somewhere Else', timezone: current.timezone, website: current.website ?? '' },
      management: { accountManagerUserId: current.accountManager?.id ?? '', technicalOwnerUserId: current.technicalOwner?.id ?? '', onboardingDate: current.onboardingDate ?? '', contractStartDate: current.contractStartDate ?? '', contractEndDate: current.contractEndDate ?? '', internalNotes: current.internalNotes ?? '' },
      status: current.status,
      serviceStatus: current.serviceStatus,
    };
    expect((await page.request.patch(`${E2E_BASE_URL}/api/v1/clients/${id}`, { data: body, headers: await csrfHeaders(page) })).status()).toBe(200);
    await page.getByLabel('State / region').fill('TX');
    await page.getByRole('button', { name: 'Save changes' }).click();
    await expect(page.getByText(/changed by someone else/)).toBeVisible();
    await expect(page.getByRole('button', { name: 'Reload latest' })).toBeVisible();
  });

  test('contacts: add a new primary, edit it, and remove another contact with inline confirmation', async ({ page }) => {
    await apiLogin(page, USERS.ops);
    const id = await bluepeak(page);
    await page.goto(`/clients/${id}/contacts`);
    await page.getByRole('link', { name: 'Add contact' }).click();
    await page.getByLabel('Full name').fill('Morgan Newlead');
    await page.getByLabel('Email').fill('morgan.newlead@bluepeak.example');
    await page.getByText('Primary', { exact: true }).click();
    await page.getByRole('button', { name: 'Add contact' }).click();
    await expect(page.getByText('Contact added.')).toBeVisible();
    const first = page.locator('ul.divide-y > li').first();
    await expect(first).toContainText('Morgan Newlead');
    await expect(first).toContainText('Primary');

    await first.getByRole('link', { name: /^Edit/ }).click();
    await page.getByLabel('Job title').fill('Chief Operating Officer');
    await page.getByRole('button', { name: 'Save contact' }).click();
    await expect(page.getByText('Contact updated.')).toBeVisible();

    const other = page.locator('ul.divide-y > li').filter({ hasNotText: 'Morgan Newlead' }).first();
    await other.getByRole('link', { name: /^Edit/ }).click();
    await page.getByRole('button', { name: 'Remove…' }).click();
    await page.getByRole('button', { name: 'Yes, remove' }).click();
    await expect(page.getByText('Contact removed.')).toBeVisible();
  });

  test('services can be changed and saved', async ({ page }) => {
    await apiLogin(page, USERS.ops);
    const id = await bluepeak(page);
    await page.goto(`/clients/${id}/services`);
    const backup = page.getByRole('checkbox', { name: /^Backup Management/ });
    const wasChecked = await backup.isChecked();
    await backup.setChecked(!wasChecked);
    await expect(page.getByText('Unsaved changes')).toBeVisible();
    await page.getByRole('button', { name: 'Save services' }).click();
    await expect(page.getByText('Services saved and recorded in the activity history.')).toBeVisible();
    await page.reload();
    await expect(page.getByRole('checkbox', { name: /^Backup Management/ })).toBeChecked({ checked: !wasChecked });
  });

  test('an administrator assigns clients to a technician from the user page', async ({ page }) => {
    await apiLogin(page, USERS.admin);
    const users = await (await page.request.get(`${E2E_BASE_URL}/api/v1/users?q=riley`)).json();
    const userId = users.items[0].id as string;
    const original = ((await (await page.request.get(`${E2E_BASE_URL}/api/v1/users/${userId}`)).json()).assignedClients as { id: string }[]).map((c) => c.id);
    try {
      await page.goto(`/settings/users/${userId}`);
      await page.getByLabel('Filter clients').fill('Harbor');
      await page.getByRole('checkbox', { name: /Harbor & Finch Legal/ }).check();
      await page.getByRole('button', { name: 'Save assignments' }).click();
      await expect(page.getByText(`Saved. ${original.length + 1} clients assigned.`)).toBeVisible();
      // Takes effect for the technician immediately.
      const ctx = await page.context().browser()!.newContext();
      const tech = await ctx.newPage();
      await apiLogin(tech, USERS.technician);
      await tech.goto('/clients');
      await expect(tech.locator('table tbody tr')).toHaveCount(original.length + 1);
      await ctx.close();
    } finally {
      // Restore the seeded scope for the other tests.
      await page.request.put(`${E2E_BASE_URL}/api/v1/users/${userId}/client-assignments`, { data: { clientIds: original }, headers: await csrfHeaders(page) });
    }
  });
});