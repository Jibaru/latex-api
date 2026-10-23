import { CodeTabs } from "@/components/landing/code-tabs";
import { Features } from "@/components/landing/features";
import { Footer } from "@/components/landing/footer";
import { Hero } from "@/components/landing/hero";
import { HowItWorks } from "@/components/landing/how-it-works";
import { LimitsStrip } from "@/components/landing/limits";
import { Masthead } from "@/components/landing/masthead";
import { PlaygroundSection } from "@/components/landing/playground-section";
import { Templates } from "@/components/landing/templates";

export const dynamic = "force-dynamic";

export default function HomePage() {
  return (
    <>
      <a href="#main" className="skip-link">
        Skip to content
      </a>
      <Masthead />
      <main id="main">
        <Hero />
        <PlaygroundSection />
        <HowItWorks />
        <Features />
        <Templates />
        <CodeTabs />
        <LimitsStrip />
      </main>
      <Footer />
    </>
  );
}
