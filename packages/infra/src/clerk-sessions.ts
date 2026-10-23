import { createClerkClient, verifyToken } from "@clerk/backend";
import type { Logger, SessionVerifier, UserIdentity } from "@latex-api/core";

export interface ClerkSessionOptions {
  secretKey: string;
  /** PEM public key for networkless verification (CLERK_JWT_KEY). Optional. */
  jwtKey?: string;
  /** Origins allowed in the `azp` claim, e.g. https://latex-api.crafter.run. */
  authorizedParties?: string[];
  logger: Logger;
}

const EMAIL_TTL_MS = 10 * 60_000;

/** Verifies Clerk session JWTs sent by the web dashboard as `Authorization: Bearer <jwt>`. */
export class ClerkSessionVerifier implements SessionVerifier {
  readonly enabled = true;
  private readonly client: ReturnType<typeof createClerkClient>;
  private readonly emails = new Map<string, { email?: string; at: number }>();

  constructor(private readonly opts: ClerkSessionOptions) {
    this.client = createClerkClient({ secretKey: opts.secretKey });
  }

  async verify(token: string): Promise<UserIdentity | null> {
    try {
      const result = await verifyToken(token, {
        secretKey: this.opts.secretKey,
        jwtKey: this.opts.jwtKey,
        authorizedParties: this.opts.authorizedParties?.length
          ? this.opts.authorizedParties
          : undefined,
      });
      if (result.errors || !result.data) return null;
      const sub = (result.data as { sub?: unknown }).sub;
      const userId = typeof sub === "string" ? sub : undefined;
      if (!userId) return null;
      return { id: userId, email: await this.email(userId) };
    } catch (error) {
      this.opts.logger.debug({ err: error }, "session token rejected");
      return null;
    }
  }

  private async email(userId: string): Promise<string | undefined> {
    const cached = this.emails.get(userId);
    if (cached && Date.now() - cached.at < EMAIL_TTL_MS) return cached.email;
    try {
      const user = await this.client.users.getUser(userId);
      const primary = user.emailAddresses.find((e) => e.id === user.primaryEmailAddressId);
      const email = primary?.emailAddress ?? user.emailAddresses[0]?.emailAddress;
      this.emails.set(userId, { email, at: Date.now() });
      return email;
    } catch {
      return cached?.email;
    }
  }
}

/** Used when Clerk is not configured (self-hosting with operator keys only). */
export const disabledSessions: SessionVerifier = {
  enabled: false,
  async verify() {
    return null;
  },
};
