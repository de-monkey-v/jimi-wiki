import { test } from "node:test";
import assert from "node:assert/strict";
import { parseUpdate, parseCommand, splitMessage, verifyWebhookSecret } from "./telegram";

// verifyWebhookSecret 는 process.env.TELEGRAM_WEBHOOK_SECRET 와 비교하므로 테스트에서 주입.
test("verifyWebhookSecret: 일치/불일치/빈값", () => {
  process.env.TELEGRAM_WEBHOOK_SECRET = "s3cr3t-token";
  assert.equal(verifyWebhookSecret("s3cr3t-token"), true);
  assert.equal(verifyWebhookSecret("wrong"), false);
  assert.equal(verifyWebhookSecret(null), false);
  assert.equal(verifyWebhookSecret(""), false);
  // 시크릿 미설정이면 항상 false(무설정 상태에서 통과 금지)
  delete process.env.TELEGRAM_WEBHOOK_SECRET;
  assert.equal(verifyWebhookSecret("anything"), false);
});

test("parseUpdate: 텍스트 메시지 정규화", () => {
  const m = parseUpdate({ update_id: 1, message: { message_id: 9, chat: { id: -100200, type: "group" }, from: { id: 42 }, text: "안녕 지미" } });
  assert.deepEqual(m, { chatId: "-100200", text: "안녕 지미", fromId: "42", chatType: "group" });
});

test("parseUpdate: 텍스트 없는/비메시지 업데이트는 null", () => {
  assert.equal(parseUpdate({ update_id: 1 }), null); // message 없음
  assert.equal(parseUpdate({ message: { chat: { id: 1 } } }), null); // text 없음
  assert.equal(parseUpdate({ message: { text: "hi", chat: {} } }), null); // chat.id 없음
  assert.equal(parseUpdate(null), null);
  assert.equal(parseUpdate("nope"), null);
});

test("parseUpdate: from 없으면 fromId null", () => {
  const m = parseUpdate({ message: { chat: { id: 5, type: "private" }, text: "hi" } });
  assert.equal(m?.fromId, null);
});

test("parseCommand: 슬래시 명령 + @봇멘션 + 인자", () => {
  assert.deepEqual(parseCommand("/bind my-wiki"), { cmd: "bind", args: "my-wiki" });
  assert.deepEqual(parseCommand("/bind@JimiBot my-wiki"), { cmd: "bind", args: "my-wiki" });
  assert.deepEqual(parseCommand("/HELP"), { cmd: "help", args: "" });
  assert.deepEqual(parseCommand("  /whoami  "), { cmd: "whoami", args: "" });
  assert.deepEqual(parseCommand("/bind  slug with spaces"), { cmd: "bind", args: "slug with spaces" });
});

test("parseCommand: 일반 텍스트는 null", () => {
  assert.equal(parseCommand("LoRA가 뭐야?"), null);
  assert.equal(parseCommand("이건 / 슬래시가 중간에"), null);
  assert.equal(parseCommand(""), null);
});

test("splitMessage: 상한 이하는 그대로, 초과는 분할", () => {
  assert.deepEqual(splitMessage("짧음", 100), ["짧음"]);
  const long = "a".repeat(250);
  const parts = splitMessage(long, 100);
  assert.ok(parts.length >= 3);
  assert.ok(parts.every((p) => p.length <= 100));
  assert.equal(parts.join(""), long);
});

test("splitMessage: 빈 문자열은 안내 문구", () => {
  assert.deepEqual(splitMessage(""), ["(빈 응답)"]);
});
