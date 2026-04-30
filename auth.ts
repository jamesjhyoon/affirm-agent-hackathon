import NextAuth from "next-auth";
import Google from "next-auth/providers/google";
import type { StoredCredential } from "@/app/lib/webauthn";
import type { LoanOverride } from "@/app/lib/loans";

const ALLOWED_DOMAIN = "affirm.com";

export const { handlers, signIn, signOut, auth } = NextAuth({
  providers: [
    Google({
      authorization: {
        params: {
          prompt: "select_account",
          hd: ALLOWED_DOMAIN,
        },
      },
    }),
  ],
  callbacks: {
    async signIn({ profile }) {
      const email = profile?.email;
      const verified = (profile as { email_verified?: boolean } | undefined)
        ?.email_verified;
      if (!email || !verified) return false;
      return email.toLowerCase().endsWith(`@${ALLOWED_DOMAIN}`);
    },
    async jwt({ token, profile, trigger, session }) {
      if (profile?.email) token.email = profile.email;
      if (profile?.name) token.name = profile.name;
      const picture = (profile as { picture?: string } | undefined)?.picture;
      if (picture) token.picture = picture;

      // The client calls update({ passkey: <StoredCredential> }) after a
      // successful WebAuthn registration ceremony to persist the credential
      // into the encrypted JWT. update({ passkey: null }) clears it (used by
      // "re-register" flows or a future "remove biometric" UI).
      // update({ passkeyCounter: N }) bumps just the counter after a
      // successful authentication ceremony — replay protection.
      // update({ loanOverride: <override> }) appends a new servicing mutation
      // (payoff / reschedule / extra payment) so the Manage screen can show it.
      // update({ loanOverridesReset: true }) clears them — useful for "fresh
      // demo run" buttons.
      if (trigger === "update" && session && typeof session === "object") {
        const next = (session as { passkey?: StoredCredential | null }).passkey;
        if (next === null) {
          delete (token as { passkey?: StoredCredential }).passkey;
        } else if (next) {
          (token as { passkey?: StoredCredential }).passkey = next;
        }
        const counter = (
          session as { passkeyCounter?: number }
        ).passkeyCounter;
        if (typeof counter === "number") {
          const existing = (token as { passkey?: StoredCredential }).passkey;
          if (existing) existing.counter = counter;
        }
        const override = (session as { loanOverride?: LoanOverride })
          .loanOverride;
        if (override) {
          const existing =
            (token as { loanOverrides?: LoanOverride[] }).loanOverrides ?? [];
          // Cap at a generous demo size so the JWT can't grow without bound.
          const next20 = [...existing, override].slice(-20);
          (token as { loanOverrides?: LoanOverride[] }).loanOverrides = next20;
        }
        if (
          (session as { loanOverridesReset?: boolean }).loanOverridesReset
        ) {
          delete (token as { loanOverrides?: LoanOverride[] }).loanOverrides;
        }
      }

      return token;
    },
    async session({ session, token }) {
      if (session.user) {
        if (token.email) session.user.email = token.email;
        if (token.name) session.user.name = token.name;
        if (typeof token.picture === "string")
          session.user.image = token.picture;
      }
      // Expose the full stored credential. WebAuthn public keys are public by
      // definition, and the JWT itself is encrypted+signed so the client can
      // never tamper with it — server reads the same value off auth() during
      // verification. Keeping it here means route handlers can call auth()
      // and get everything they need without a second cookie read.
      const passkey = (token as { passkey?: StoredCredential }).passkey;
      if (passkey) {
        (session as { passkey?: StoredCredential }).passkey = passkey;
      }
      const overrides = (token as { loanOverrides?: LoanOverride[] })
        .loanOverrides;
      if (overrides) {
        (session as { loanOverrides?: LoanOverride[] }).loanOverrides =
          overrides;
      }
      return session;
    },
  },
  pages: {
    signIn: "/",
    error: "/",
  },
  session: { strategy: "jwt" },
  trustHost: true,
});
