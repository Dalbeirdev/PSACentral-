# Reuse Assessment — Existing Projects (read-only survey, 2026-10-14)

No existing project was modified. Everything below is a reference to **port patterns from**, not code that is shared at runtime.

| Project | Path | Stack | Relevance |
|---|---|---|---|
| **desk-portal** (main ticket-management system) | `E:\autotask\DPI-Autotask\desk-portal` | .NET 9, EF Core, PostgreSQL, Keycloak OIDC; Next.js 15 web | **High (design/schema).** The PSA connector contract `packages/psa-core/Contracts/IServiceManagementConnector.cs` + `ProviderCapabilities.cs` is the template for our `PsaAdapter`. Autotask & ConnectWise connectors (`packages/connectors/*`) inform Module 11. Ticket/sync schema (`tickets`, `sync_events`, `sync_runs`, `psa_connections`) informs the edge DB (Module 6/12). `SecretCipher.cs` (AES-256-GCM) is aligned with our envelope format. Permission catalog (`packages/domain/Authorization`) informed our RBAC. |
| **PioDesk** | `E:\autotask\PioDesk` | .NET 9 backend + edge gateway, Vite/React 19 dashboard | **High (edge model).** Edge gateway single-use enrollment, cloud-controlled heartbeat cadence, mTLS listener (`docs/edge-mtls-security.md`), and `agent.proto` inform Modules 7–8. Its shadcn components informed our component API, but we did not copy them (we have a different framework and design identity). |
| **DeployHub** | `E:\autotask\DeployHub` | .NET 9, SQL Server, WPF agent | **Medium.** Agent enrollment + heartbeat commands and the offline job queue inform the agent loop. Its hash-chained audit log is a candidate enhancement to our append-only audit. |
| autotask-plugin / ConnectWise osTicket plugins | `E:\autotask\DPI-Autotask\*` | PHP 8 | **Low–medium.** Autotask/ConnectWise REST know-how (picklists, time entries, webhooks) for Module 11–12. |
| piotrack, gh-repo (osTicket fork) | | Laravel / PHP | Not relevant. |

**Integration plan:** no runtime coupling to desk-portal in Modules 1–10. Integration points will be defined before Module 12, potentially as a desk-portal connector that reads ticket data from edge appliances. Under the client-hosted data-plane rule (ARCHITECTURE AD-11/AD-12), any such transfer of ticket data out of a client deployment is an explicitly authorized, per-client opt-in feature. It is never a default, and never part of the Control Plane. That plan will be written up as its own document and approved before any change is made to desk-portal.
