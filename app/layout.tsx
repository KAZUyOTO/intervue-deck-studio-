import './globals.css';
import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Deck Studio',
  description: 'Personalise the sales deck and download a compressed PDF.',
  robots: { index: false, follow: false },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        {/* Brand fonts used by the deck live in public/fonts (see the README there). */}
        <link rel="stylesheet" href="/fonts/fonts.css" />
      </head>
      <body>{children}</body>
    </html>
  );
}
