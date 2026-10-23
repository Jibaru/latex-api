import type { ReactNode } from "react";
import { DashboardNav } from "@/components/account/dashboard-nav";
import { Footer } from "@/components/landing/footer";
import { Masthead } from "@/components/landing/masthead";

export const dynamic = "force-dynamic";

export default function DashboardLayout({ children }: { children: ReactNode }) {
  return (
    <>
      <a href="#main" className="skip-link">
        Skip to content
      </a>
      <Masthead />
      <div className="border-b border-rule">
        <div className="wrap">
          <DashboardNav />
        </div>
      </div>
      <main id="main" className="wrap flex-1 py-12 lg:py-16">
        {children}
      </main>
      <Footer />
    </>
  );
}
