import assert from "node:assert/strict";
import test from "node:test";
import { createLicenseSchema, updateLicenseSchema } from "./license";

const baseCreateInput = {
  project_id: "00000000-0000-4000-8000-000000000001",
  domain: "example.com",
  environment: "production",
  product_name: "Örnek Ürün",
  starts_at: "",
  expires_at: "",
  grace_days: 0,
  activation_limit: 1,
  auto_suspend: false,
  features: "",
};

test("bitiş tarihi olmayan lisansta sıfır ek süreyi kabul eder", () => {
  assert.equal(createLicenseSchema.safeParse(baseCreateInput).success, true);
});

test("bitiş tarihi olmayan lisansta ek süreyi reddeder", () => {
  const result = createLicenseSchema.safeParse({
    ...baseCreateInput,
    grace_days: 14,
  });

  assert.equal(result.success, false);
  if (!result.success) {
    assert.equal(result.error.flatten().fieldErrors.grace_days?.[0],
      "Ek süre için bitiş tarihi girilmelidir."
    );
  }
});

test("lisans düzenlemede tarih ve ek süre birlikteliğini doğrular", () => {
  const result = updateLicenseSchema.safeParse({
    license_id: "00000000-0000-4000-8000-000000000002",
    product_name: "Örnek Ürün",
    starts_at: "2026-08-11",
    expires_at: "2027-08-11",
    grace_days: 14,
    activation_limit: 2,
    auto_suspend: true,
    features: "api_access",
    status: "active",
    reason: "",
  });

  assert.equal(result.success, true);
});

test("süresiz lisansı tarihsiz kabul eder", () => {
  const result = createLicenseSchema.safeParse({
    ...baseCreateInput,
    unlimited: true,
  });

  assert.equal(result.success, true);
});

test("süresiz lisansta girilen tarihi reddeder", () => {
  const result = createLicenseSchema.safeParse({
    ...baseCreateInput,
    unlimited: true,
    expires_at: "2027-08-11",
  });

  assert.equal(result.success, false);
  if (!result.success) {
    assert.equal(
      result.error.flatten().fieldErrors.expires_at?.[0],
      "Süresiz lisansta tarih girilemez."
    );
  }
});

test("süresiz lisansta ek süreyi reddeder", () => {
  const result = updateLicenseSchema.safeParse({
    license_id: "00000000-0000-4000-8000-000000000002",
    product_name: "Örnek Ürün",
    starts_at: "",
    expires_at: "",
    grace_days: 14,
    unlimited: true,
    activation_limit: 2,
    auto_suspend: false,
    features: "",
    status: "active",
    reason: "",
  });

  assert.equal(result.success, false);
  if (!result.success) {
    assert.equal(
      result.error.flatten().fieldErrors.grace_days?.[0],
      "Süresiz lisansta ek süre girilemez."
    );
  }
});
