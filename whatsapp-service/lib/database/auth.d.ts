import { Execute } from './transport';
import { Actor } from './d1';
export const cookieName: string;
export const SESSION_SECONDS: number;
export function digest(value: string): string;
export function normalizeEmail(value: unknown): string;
export function validatePassword(value: unknown): string;
export type AuthUser = { id: string; email: string; email_confirmed_at?: string; last_sign_in_at?: string };
export type AuthSessionResult = { token: string; user: AuthUser; maxAge: number };
export type LinkResult = { user: AuthUser; token: string; type: string; isNewUser: boolean };
export function createAuthService(options: { execute: Execute; now?: () => number }): {
  session(token: string | undefined, options?: { allowRecovery?: boolean }): Promise<{ user: AuthUser; actor: Actor; purpose: string } | null>;
  authenticate(email: unknown, password: unknown): Promise<AuthSessionResult>;
  signOut(token: string | undefined): Promise<void>;
  generateLink(input: { email: string; type: string; name?: string; userId?: string; role?: string }): Promise<LinkResult>;
  verifyOtp(token: unknown, kind: unknown): Promise<AuthSessionResult>;
  updatePassword(token: string | undefined, password: unknown): Promise<AuthSessionResult>;
  requestRecovery(email: unknown, sendMail?: (link: LinkResult) => Promise<void>): Promise<{ ok: true }>;
};
