import type { Metadata } from "next";
import { Manrope, Unbounded } from "next/font/google";
import { Providers } from "@/components/providers";
import "./globals.css";

const display = Unbounded({
  variable: "--font-display",
  subsets: ["latin", "cyrillic"],
  weight: ["400", "500", "600", "700"],
});

const body = Manrope({
  variable: "--font-body",
  subsets: ["latin", "cyrillic"],
  weight: ["400", "500", "600", "700", "800"],
});

export const metadata: Metadata = {
  title: "ТендерКонтур — отбор строительных тендеров",
  description:
    "Личный кабинет для отбора строительных тендеров: закупки, документы, расчёты, ГПР, деньги, риски и план/факт. Договор № TMA361.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="ru"
      className={`${display.variable} ${body.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col font-[family-name:var(--font-body)]">
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
