import type { Metadata, Viewport } from 'next';
import { Inter, JetBrains_Mono } from 'next/font/google';
import { headers } from 'next/headers';
import type { ReactNode } from 'react';
import './globals.css';

const inter = Inter({ subsets: ['latin'], variable: '--font-inter', display: 'swap' });
const mono = JetBrains_Mono({ subsets: ['latin'], variable: '--font-mono-face', display: 'swap' });

export const metadata: Metadata = {
  title: { default: 'PSA Control Center', template: '%s · PSA Control Center' },
  description: 'Client onboarding, Docker deployment and fleet management for PSA edge appliances.',
  robots: { index: false, follow: false },
};

export const viewport: Viewport = { themeColor: '#2563eb', width: 'device-width', initialScale: 1 };

export default async function RootLayout({ children }: { children: ReactNode }) {
  // Reading the request makes every page dynamic, so Next.js can stamp the per-request CSP nonce.
  await headers();
  return (
    <html lang="en" className={`${inter.variable} ${mono.variable}`}>
      <body className="min-h-dvh font-sans">{children}</body>
    </html>
  );
}
