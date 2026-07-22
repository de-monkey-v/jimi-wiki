import NextAuth from "next-auth";
import Credentials from "next-auth/providers/credentials";
import { PrismaAdapter } from "@auth/prisma-adapter";
import { prisma } from "@/lib/db";
import { verifyPassword } from "@/lib/password";
import { authMode } from "@/lib/auth-mode";

/**
 * AUTH_MODE에 따라 providers를 조립한다.
 * - single: providers 없음 — 로그인 화면 없이 getCurrentUser가 암묵 owner를 반환(session.ts).
 * - local : 이메일+비밀번호(argon2) Credentials.
 * - oidc  : phase-2(미배선). 켜려면 여기에 generic OIDC provider를 추가한다(어댑터가 이미 있어 그대로 동작).
 */
function buildProviders() {
  if (authMode() === "single" || authMode() === "tailscale") return [];
  return [
    Credentials({
      credentials: { email: {}, password: {} },
      authorize: async (creds) => {
        const email = String(creds?.email ?? "").trim().toLowerCase();
        const password = String(creds?.password ?? "");
        if (!email || !password) return null;
        const user = await prisma.user.findUnique({ where: { email } });
        if (!user?.passwordHash) return null; // 비밀번호 미설정(초대 미수락/oidc 유저)은 로그인 불가
        if (!(await verifyPassword(user.passwordHash, password))) return null;
        return { id: user.id, email: user.email, name: user.name, image: user.image };
      },
    }),
  ];
}

export const { handlers, auth, signIn, signOut } = NextAuth({
  adapter: PrismaAdapter(prisma), // JWT 전환 후 credentials엔 미사용(idle) — oidc 확장 시 재사용
  session: { strategy: "jwt" }, // Credentials provider 필수 조건
  providers: buildProviders(),
  pages: { signIn: "/login", error: "/login" },
  callbacks: {
    async jwt({ token, user }) {
      if (user) token.uid = user.id;
      return token;
    },
    async session({ session, token }) {
      if (session.user && token.uid) session.user.id = token.uid;
      return session;
    },
  },
  trustHost: true,
});
