import type { DefaultJWT } from "next-auth/jwt";

// jwt 콜백에서 token.uid에 User.id를 실어 session.user.id로 전달한다.
declare module "next-auth/jwt" {
  interface JWT extends DefaultJWT {
    uid?: string;
  }
}
