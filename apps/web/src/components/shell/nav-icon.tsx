import {
  Boxes,
  Building,
  Container,
  Database,
  HeartPulse,
  KeyRound,
  LayoutDashboard,
  Plug,
  Puzzle,
  Rocket,
  ScrollText,
  Settings,
} from 'lucide-react';
import type { NavIconName } from '@/lib/nav';

const ICONS = {
  overview: LayoutDashboard,
  clients: Building,
  psa: Plug,
  services: Boxes,
  deployments: Rocket,
  images: Container,
  database: Database,
  health: HeartPulse,
  integrations: Puzzle,
  licenses: KeyRound,
  audit: ScrollText,
  settings: Settings,
} satisfies Record<NavIconName, unknown>;

export function NavIcon({ name, className }: { name: NavIconName; className?: string }) {
  const Icon = ICONS[name];
  return <Icon className={className} aria-hidden="true" />;
}
