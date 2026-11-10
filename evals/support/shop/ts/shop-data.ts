import { request, type APIRequestContext } from '@playwright/test';

// Test data helpers for the shop app, shared by all shop tests ("reuse before creating").
// They use the app's own API, so tests own their data instead of relying on whatever is in the database.

const baseURL = () => process.env.SHOP_URL || 'http://localhost:4101';

/** An API client signed in as the admin role (credentials from the environment). */
export async function adminApi(): Promise<APIRequestContext> {
  const api = await request.newContext({ baseURL: baseURL() });
  const res = await api.post('/api/login', { data: { email: process.env.SHOP_ADMIN_EMAIL, password: process.env.SHOP_ADMIN_PASSWORD } });
  if (!res.ok()) throw new Error(`admin login failed: ${res.status()}`);
  return api;
}

/** Creates a single-use coupon that no test has used yet. */
export async function freshCoupon(percent: number): Promise<string> {
  const api = await adminApi();
  const code = `T${percent}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`.toUpperCase();
  const res = await api.post('/api/coupons', { data: { code, percent, singleUse: true } });
  await api.dispose();
  if (res.status() !== 201) throw new Error(`could not create coupon: ${res.status()} ${await res.text()}`);
  return code;
}

/** Replaces the signed-in user's cart (use the page's request context so it shares the session). */
export async function setCart(api: APIRequestContext, items: { productId: number; qty: number }[]) {
  const res = await api.put('/api/cart', { data: { items } });
  if (!res.ok()) throw new Error(`could not set cart: ${res.status()} ${await res.text()}`);
}

/** A product name no other test run has used. */
export const uniqueName = (base: string) => `${base} ${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;

export const PRODUCTS = { deskLamp: 1, notebook: 2, monitorArm: 3, deskMat: 4, cableTray: 5 } as const;
