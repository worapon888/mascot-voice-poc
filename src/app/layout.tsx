import type { Metadata } from 'next';
import { Prompt, Geist_Mono } from 'next/font/google';
import './globals.css';

const promptSans = Prompt({
  variable: '--font-geist-sans',
  weight: ['400', '500', '600', '700'],
  subsets: ['thai', 'latin'],
});

const geistMono = Geist_Mono({
  variable: '--font-geist-mono',
  subsets: ['latin'],
});

export const metadata: Metadata = {
  title: 'ผู้ช่วยประชาสัมพันธ์ | Mascot Voice POC',
  description: 'Thai-speaking 2D Mascot AI Voice Chatbot POC',
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="th"
      className={`${promptSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col font-sans">{children}</body>
    </html>
  );
}
