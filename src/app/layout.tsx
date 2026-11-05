import type { Metadata } from "next";
import { Manrope, Onest } from "next/font/google";
import { Providers } from "@/components/providers";
import "./globals.css";

const display = Onest({
  variable: "--font-display",
  subsets: ["latin", "cyrillic"],
  weight: ["500", "600", "700"],
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
        <div className="tk-liquid" aria-hidden>
          <span className="tk-blob tk-blob-a" />
          <span className="tk-blob tk-blob-b" />
          <span className="tk-blob tk-blob-c" />
          <span className="tk-blob tk-blob-d" />
        </div>
        <div className="relative z-10 flex min-h-full flex-1 flex-col">
          <Providers>{children}</Providers>
        </div>
      </body>
    </html>
  );
}
