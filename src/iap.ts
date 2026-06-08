import type { RuntimeEnv } from "./bindings";
import { requireD1 } from "./bindings";
import { HttpError } from "./http";
import { SignJWT, importPKCS8, decodeJwt } from "jose";

export interface IAPVerifyRequest {
  tenantId: string;
  transactionId: string;
}

export async function verifyIAPReceipt(env: RuntimeEnv, request: IAPVerifyRequest): Promise<{ success: boolean; newBalance: number; tier: string }> {
  const db = requireD1(env);

  // 1. Check if we already processed this transaction
  const existing = await db.prepare("SELECT transaction_id FROM iap_transactions WHERE transaction_id = ?").bind(request.transactionId).first();
  if (existing) {
    throw new HttpError(400, "Transaction already processed");
  }

  // 2. Prepare App Store Server API Request
  if (!env.APPLE_ISSUER_ID || !env.APPLE_KEY_ID || !env.APPLE_PRIVATE_KEY || !env.APPLE_BUNDLE_ID) {
    throw new HttpError(500, "Apple API credentials not configured");
  }

  // Generate JWT for Apple
  let privateKeyString = env.APPLE_PRIVATE_KEY;
  // If the string contains escaped newlines (e.g. from cloudflare secrets), unescape them
  privateKeyString = privateKeyString.replace(/\\n/g, '\n');
  
  const privateKey = await importPKCS8(privateKeyString, "ES256");
  const jwt = await new SignJWT({
    iss: env.APPLE_ISSUER_ID,
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 3600,
    aud: "appstoreconnect-v1",
    bid: env.APPLE_BUNDLE_ID
  })
    .setProtectedHeader({ alg: "ES256", kid: env.APPLE_KEY_ID, typ: "JWT" })
    .sign(privateKey);

  // Try production first, then sandbox
  let url = `https://api.storekit.itunes.apple.com/inApps/v1/transactions/${request.transactionId}`;
  let response = await fetch(url, {
    method: "GET",
    headers: { "Authorization": `Bearer ${jwt}` }
  });

  if (response.status === 404) {
    url = `https://api.storekit-sandbox.itunes.apple.com/inApps/v1/transactions/${request.transactionId}`;
    response = await fetch(url, {
      method: "GET",
      headers: { "Authorization": `Bearer ${jwt}` }
    });
  }

  if (!response.ok) {
    throw new HttpError(400, `Failed to verify transaction with Apple: ${response.status}`);
  }

  const result: any = await response.json();
  const transactionInfoJWS = result.signedTransactionInfo;
  
  if (!transactionInfoJWS) {
    throw new HttpError(400, "Invalid response from Apple");
  }

  // Decode the JWS payload (we trust it because it came from Apple over HTTPS)
  const payload = decodeJwt(transactionInfoJWS);

  // 3. Process the purchase
  let addedCredits = 0;
  let newTier = "";
  
  if (payload.productId === "com.floreboard.credits.500k") {
    addedCredits = 500000;
  } else if (payload.productId === "com.floreboard.pro.monthly") {
    newTier = "pro";
  } else {
    throw new HttpError(400, `Unknown product ID: ${payload.productId}`);
  }

  // Ensure wallet exists
  await db.prepare("INSERT OR IGNORE INTO user_wallets (tenant_id, balance, tier, created_at, updated_at) VALUES (?, 0, 'free', ?, ?)")
    .bind(request.tenantId, Date.now(), Date.now())
    .run();

  // Apply changes
  if (addedCredits > 0) {
    await db.prepare("UPDATE user_wallets SET balance = balance + ?, updated_at = ? WHERE tenant_id = ?")
      .bind(addedCredits, Date.now(), request.tenantId)
      .run();
  }
  
  if (newTier) {
    await db.prepare("UPDATE user_wallets SET tier = ?, updated_at = ? WHERE tenant_id = ?")
      .bind(newTier, Date.now(), request.tenantId)
      .run();
  }

  // Record transaction
  await db.prepare("INSERT INTO iap_transactions (transaction_id, tenant_id, product_id, environment, created_at) VALUES (?, ?, ?, ?, ?)")
    .bind(request.transactionId, request.tenantId, payload.productId as string, payload.environment as string, Date.now())
    .run();

  // Fetch updated wallet
  const wallet = await db.prepare("SELECT balance, tier FROM user_wallets WHERE tenant_id = ?").bind(request.tenantId).first<{ balance: number; tier: string }>();

  return { success: true, newBalance: wallet?.balance ?? 0, tier: wallet?.tier ?? "free" };
}

export async function handleAppleWebhook(env: RuntimeEnv, payload: any): Promise<void> {
  console.log("Received Apple Webhook", JSON.stringify(payload));
}
