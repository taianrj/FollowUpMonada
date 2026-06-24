import type { Metadata } from "next";
import "./globals.css";
import { NotificationProvider } from "@/context/NotificationContext";

export const metadata: Metadata = {
  title: "FollowUp Mônada | Gestão Inteligente de Demandas",
  description: "Otimize seus fluxos de trabalho com gerenciamento moderno de clientes, painel interativo e extração de demandas automatizada por Inteligência Artificial.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="pt-BR">
      <body>
        <NotificationProvider>
          {children}
        </NotificationProvider>
      </body>
    </html>
  );
}
