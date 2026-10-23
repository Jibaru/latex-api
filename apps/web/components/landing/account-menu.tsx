"use client";

import { UserButton } from "@clerk/nextjs";

/** Clerk's account menu, with shortcuts into the dashboard. */
export function AccountMenu() {
  return (
    <span className="ml-1 inline-flex size-11 items-center justify-center">
      <UserButton appearance={{ elements: { avatarBox: { width: "1.75rem", height: "1.75rem" } } }}>
        <UserButton.MenuItems>
          <UserButton.Link label="Dashboard" labelIcon={<Glyph>§</Glyph>} href="/dashboard" />
          <UserButton.Link
            label="API tokens"
            labelIcon={<Glyph>¶</Glyph>}
            href="/dashboard/tokens"
          />
        </UserButton.MenuItems>
      </UserButton>
    </span>
  );
}

function Glyph({ children }: { children: string }) {
  return (
    <span aria-hidden="true" className="font-serif text-[0.95rem] leading-none">
      {children}
    </span>
  );
}
