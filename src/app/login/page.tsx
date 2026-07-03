import { loginAction } from "./actions";

export const dynamic = "force-dynamic";

const TEST_ACCOUNTS = [
  { email: "dev@jimi.local", label: "dev (기본 · owner 계정)" },
  { email: "dev2@jimi.local", label: "dev2 (공유 테스트용 계정)" },
];

export default function Login() {
  return (
    <main className="mx-auto max-w-sm px-6 py-20">
      <h1 className="text-2xl font-bold mb-2">jimi-wiki 로그인</h1>
      <p className="text-sm text-gray-500 mb-6">OAuth 붙이기 전 테스트 로그인입니다. 계정을 골라 로그인하세요.</p>

      <div className="space-y-2 mb-6">
        {TEST_ACCOUNTS.map((a) => (
          <form key={a.email} action={loginAction}>
            <input type="hidden" name="email" value={a.email} />
            <button className="w-full border rounded-lg px-4 py-3 text-left hover:bg-gray-50">
              <div className="font-medium">{a.email}</div>
              <div className="text-xs text-gray-400">{a.label}</div>
            </button>
          </form>
        ))}
      </div>

      <form action={loginAction} className="border-t pt-4">
        <label className="text-sm text-gray-500">다른 이메일로 로그인(자동 생성)</label>
        <div className="mt-1 flex gap-2">
          <input name="email" type="email" required placeholder="you@example.com" className="flex-1 border rounded px-3 py-2" />
          <button className="bg-stone-900 text-white rounded px-4 py-2">로그인</button>
        </div>
      </form>
    </main>
  );
}
