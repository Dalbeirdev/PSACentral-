import type { DeploymentLifecycleState, HealthState, PsaProviderKey } from './common.js';

/** Where the numbers on a page came from. The UI must surface synthetic data explicitly. */
export interface DataProvenance {
  syntheticRecords: number;
  liveRecords: number;
  /** True when any record contributing to this response is synthetic. */
  containsSynthetic: boolean;
}

export interface DashboardKpis {
  totalClients: number;
  newClientsLast30Days: number;
  totalPsaInstances: number;
  psaProvidersInUse: number;
  totalDeployments: number;
  /** Lifecycle enrolled/verified AND health not offline/unknown. */
  activeDeployments: number;
  offlineDeployments: number;
  healthyInstallations: number;
  /** Deployments currently reporting a critical health state. */
  criticalAlerts: number;
  dockerVersionsInUse: number;
  latestImageVersion: string | null;
  recentDeploymentsLast30Days: number;
}

export interface RecentDeployment {
  id: string;
  code: string;
  clientId: string;
  clientName: string;
  psaProvider: PsaProviderKey | null;
  psaProviderName: string | null;
  imageVersion: string | null;
  lifecycleState: DeploymentLifecycleState;
  healthState: HealthState;
  lastHeartbeatAt: string | null;
  createdAt: string;
  isSynthetic: boolean;
}

export interface DashboardSummary {
  generatedAt: string;
  provenance: DataProvenance;
  kpis: DashboardKpis;
  healthDistribution: { state: HealthState; count: number }[];
  psaProviderDistribution: { provider: PsaProviderKey; name: string; count: number }[];
  onboardingTrend: { month: string; count: number }[];
  versionDistribution: { version: string; count: number }[];
  /** Daily snapshot of deployment health states (end-of-day state per deployment). */
  statusOverTime: ({ date: string } & Record<HealthState, number>)[];
  recentDeployments: RecentDeployment[];
}

export interface SearchResult {
  type: 'client' | 'deployment' | 'psa_instance';
  id: string;
  title: string;
  subtitle: string;
  href: string;
  isSynthetic: boolean;
}

export interface SearchResponse {
  query: string;
  results: SearchResult[];
}

export interface NotificationItem {
  id: string;
  severity: 'critical' | 'warning' | 'info';
  title: string;
  detail: string;
  occurredAt: string | null;
  href: string;
  isSynthetic: boolean;
}

export interface NotificationsResponse {
  items: NotificationItem[];
  counts: { critical: number; warning: number; info: number };
}
