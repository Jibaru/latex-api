import Link from "next/link";
import { Footer } from "@/components/landing/footer";
import { Masthead } from "@/components/landing/masthead";

export default function NotFound() {
  return (
    <>
      <a href="#main" className="skip-link">
        Skip to content
      </a>
      <Masthead />
      <main id="main" className="wrap flex flex-1 flex-col justify-center py-24">
        <p className="font-mono text-[0.8rem] text-ink-2">404</p>
        <h1 className="display mt-3 text-5xl">Undefined control sequence.</h1>
        <p className="lede mt-5 max-w-[40ch]">
          There is no page at this address. The documentation index is a good place to restart.
        </p>
        <div className="mt-8 flex gap-3">
          <Link href="/docs" className="btn btn-primary">
            Read the docs
          </Link>
          <Link href="/" className="btn btn-secondary">
            Home
          </Link>
        </div>
      </main>
      <Footer />
    </>
  );
}
