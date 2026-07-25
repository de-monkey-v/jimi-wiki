"use client";
import { useTranslations } from "next-intl";
import { revokeKeyAction } from "./actions";

/**
 * 키 폐기 버튼. 서버 액션 제출 시 `apikey:changed`를 쏴서 IssueKeyForm의 토큰 잔상을
 * 새로고침 없이 즉시 지우게 한다(발급 직후 폐기해도 노출 토큰이 화면에 남지 않도록).
 */
export function RevokeButton({ id }: { id: string }) {
  const t = useTranslations("KeysRevokeButton");
  return (
    <form action={revokeKeyAction} onSubmit={() => window.dispatchEvent(new Event("apikey:changed"))}>
      <input type="hidden" name="id" value={id} />
      <button className="btn-danger btn-compact">{t("revoke")}</button>
    </form>
  );
}
