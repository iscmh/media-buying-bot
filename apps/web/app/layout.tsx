import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Media Buying Bot',
  description: 'Multi-tenant media buying automation for performance marketers.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body className="min-h-screen bg-background antialiased">{children}</body>
    </html>
  );
}
