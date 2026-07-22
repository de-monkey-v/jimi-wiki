import "server-only";
import { headers } from "next/headers";
import { prisma } from "@/lib/db";
import {
  resolveTailscaleIdentity,
  AUTH_TRANSITION_LOCK_ID,
  TAILSCALE_PROVIDER,
  type TailscaleIdentity,
} from "@/lib/tailscale-auth-core";
import type { User } from "@/generated/prisma/client";

export type TailscaleRequestState =
  | TailscaleIdentity
  | { status: "unclaimed"; login: string }
  | { status: "authenticated"; login: string; user: User };

export type TailscaleClaimInspection =
  | Exclude<TailscaleIdentity, { status: "allowed" }>
  | { status: "authenticated"; login: string; user: User }
  | { status: "claimable"; login: string; candidate: Pick<User, "id" | "email" | "name"> }
  | { status: "recovery-required"; login: string; candidateCount: number };

export type TailscaleClaimErrorCode = "recovery-required" | "mapping-conflict";

export class TailscaleClaimError extends Error {
  constructor(public readonly code: TailscaleClaimErrorCode) {
    super(code);
  }
}

export async function getTailscaleIdentity(): Promise<TailscaleIdentity> {
  return resolveTailscaleIdentity(await headers(), process.env.TAILSCALE_ALLOWED_LOGIN);
}

async function findMappedUser(login: string): Promise<User | null> {
  const account = await prisma.account.findUnique({
    where: { provider_providerAccountId: { provider: TAILSCALE_PROVIDER, providerAccountId: login } },
    include: { user: true },
  });
  return account?.user ?? null;
}

export async function getTailscaleRequestState(): Promise<TailscaleRequestState> {
  const identity = await getTailscaleIdentity();
  if (identity.status !== "allowed") return identity;
  const user = await findMappedUser(identity.login);
  return user
    ? { status: "authenticated", login: identity.login, user }
    : { status: "unclaimed", login: identity.login };
}

async function ownerCandidates(client: Pick<typeof prisma, "membership">, take = 2) {
  const rows = await client.membership.findMany({
    where: { role: "owner" },
    distinct: ["userId"],
    take,
    orderBy: { userId: "asc" },
    select: { user: { select: { id: true, email: true, name: true } } },
  });
  return rows.map((row) => row.user);
}

export async function inspectTailscaleClaim(): Promise<TailscaleClaimInspection> {
  const identity = await getTailscaleIdentity();
  if (identity.status !== "allowed") return identity;
  const mapped = await findMappedUser(identity.login);
  if (mapped) return { status: "authenticated", login: identity.login, user: mapped };
  const candidates = await ownerCandidates(prisma);
  return candidates.length === 1
    ? { status: "claimable", login: identity.login, candidate: candidates[0] }
    : { status: "recovery-required", login: identity.login, candidateCount: candidates.length };
}

/** 이 함수는 헤더 검증을 끝낸 server action만 호출한다. */
export async function claimTailscaleOwner(login: string): Promise<User> {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(${AUTH_TRANSITION_LOCK_ID})`;
    const existing = await tx.account.findUnique({
      where: { provider_providerAccountId: { provider: TAILSCALE_PROVIDER, providerAccountId: login } },
      include: { user: true },
    });
    if (existing) return existing.user;

    // 단일 사용자 모드에서 다른 login 매핑을 자동 교체하지 않는다.
    if (await tx.account.findFirst({ where: { provider: TAILSCALE_PROVIDER } })) {
      throw new TailscaleClaimError("mapping-conflict");
    }

    const candidates = await ownerCandidates(tx);
    if (candidates.length !== 1) throw new TailscaleClaimError("recovery-required");
    const account = await tx.account.create({
      data: {
        userId: candidates[0].id,
        type: TAILSCALE_PROVIDER,
        provider: TAILSCALE_PROVIDER,
        providerAccountId: login,
      },
      include: { user: true },
    });
    return account.user;
  });
}
