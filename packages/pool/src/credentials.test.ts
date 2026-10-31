import assert from "node:assert/strict";
import { createCipheriv, createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { decryptAesGcm, decryptCredential, importCredentials, readCredentials, readDeviceMid } from "./credentials.ts";

const SECRET = { secret: "test-secret" };

function jwt(ident: string, extra: Record<string, unknown> = {}): string {
  const payload = Buffer.from(JSON.stringify({ user_id: ident, sub: ident, iat: 1, ...extra })).toString("base64url");
  return `eyJhbGciOiJIUzI1NiJ9.${payload}.not-a-real-signature-zzzz`;
}

function seal(plaintext: string): string {
  const key = createHash("sha256").update(SECRET.secret, "utf8").digest();
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return `enc:v1:${iv.toString("base64url")}.${cipher.getAuthTag().toString("base64url")}.${ciphertext.toString("base64url")}`;
}

test("AES-GCM accepts the known vector and rejects a tampered tag", () => {
  const key = Buffer.alloc(32);
  const iv = Buffer.alloc(12);
  const cipher = Buffer.from("cea7403d4d606b6e074ec5d3baf39d18", "hex");
  const tag = Buffer.from("d0d1c8a799996bf0265b98b5d48ab919", "hex");
  assert.equal(decryptAesGcm(key, iv, cipher, tag).equals(Buffer.alloc(16)), true);
  assert.throws(() => decryptAesGcm(key, iv, cipher, Buffer.alloc(16)), /authentication failed/);
});

test("a tampered enc:v1 blob stays sealed and does not echo the plaintext", () => {
  const packed = seal("plain-token-value");
  const parts = packed.slice("enc:v1:".length).split(".");
  parts[1] = Buffer.alloc(16, 9).toString("base64url");
  const broken = `enc:v1:${parts.join(".")}`;
  assert.throws(() => decryptCredential(broken, SECRET), (error: unknown) => {
    const message = error instanceof Error ? error.message : "";
    assert.match(message, /Cannot decrypt ZCode credentials/);
    assert.equal(message.includes("plain-token-value"), false);
    return true;
  });
});

test("credential import keeps coding-plan JWTs and drops other secrets", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "azc-cred-"));
  const file = path.join(dir, "credentials.json");
  const individual = jwt("individual");
  const team = jwt("team", { iat: 2 });
  fs.writeFileSync(
    file,
    JSON.stringify({
      zcodejwttoken: seal(individual),
      "oauth:zai:user_info": seal(JSON.stringify({ email: "owner@example.test", name: "Owner" })),
      "oauth:zai:access_token": "oauth-secret-not-for-import",
      "account-provider:coding-plan:account:team:api-key": team,
      "account-provider:coding-plan:account:individual:api-key": individual,
      "account-provider:coding-plan:account:custom:api-key": "api-key-value",
    }),
  );
  fs.writeFileSync(path.join(dir, "telemetry-state.json"), JSON.stringify({ deviceMid: "saved-device" }));
  fs.writeFileSync(path.join(dir, "bad.json"), JSON.stringify({ deviceMid: "bad\nheader" }));
  const accounts = readCredentials(file, SECRET);
  assert.deepEqual(
    accounts.map((account) => account.account_id).sort(),
    ["individual", "team"],
  );
  assert.equal(accounts.find((account) => account.account_id === "individual")?.email, "owner@example.test");
  assert.equal(accounts.find((account) => account.account_id === "team")?.email, "");
  assert.equal(accounts.find((account) => account.account_id === "individual")?.device_mid, "saved-device");
  const out = path.join(dir, "out");
  const result = importCredentials(file, out, SECRET);
  assert.equal(result.written, 2);
  assert.equal(result.emails.includes("owner@example.test"), true);
  const dumped = fs.readdirSync(out).map((name) => fs.readFileSync(path.join(out, name), "utf8")).join("\n");
  assert.equal(dumped.includes("oauth-secret-not-for-import"), false);
  assert.equal(dumped.includes("api-key-value"), false);
  assert.equal(dumped.includes("not-a-real-signature-zzzz"), true);
  assert.equal(readDeviceMid(path.join(dir, "missing.json")), null);
  assert.equal(readDeviceMid(path.join(dir, "bad.json")), null);
  assert.equal(readDeviceMid(path.join(dir, "telemetry-state.json")), "saved-device");
});
