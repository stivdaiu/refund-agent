import { describe, expect, it } from "vitest";
import type { Order } from "../src/models.js";
import { evaluateEligibility } from "../src/tools.js";

const TODAY = "2026-11-10";

function order(overrides: Partial<Order> = {}): Order {
  return {
    order_id: "ORD-9999",
    customer_email: "test@example.com",
    status: "delivered",
    order_date: "2026-10-25",
    delivered_at: "2026-11-01",
    delivered_late: false,
    items: [
      { sku: "X", name: "Thing", unit_price: 50, qty: 2, final_sale: false },
    ],
    shipping_fee: 5,
    total: 105,
    currency: "EUR",
    refunded_amount: 0,
    ...overrides,
  };
}

describe("refund windows", () => {
  it.each([
    ["changed_mind", "2026-10-11", true],
    ["changed_mind", "2026-10-10", false],
    ["damaged", "2026-09-11", true],
    ["damaged", "2026-09-10", false],
  ] as const)(
    "%s delivered %s -> eligible=%s",
    (reason, deliveredAt, expected) => {
      expect(
        evaluateEligibility(
          order({ delivered_at: deliveredAt }),
          reason,
          TODAY,
          150,
        ).eligible,
      ).toBe(expected);
    },
  );
});

describe("special rules", () => {
  it("rejects orders that are not delivered", () => {
    expect(
      evaluateEligibility(
        order({ status: "shipped", delivered_at: null }),
        "damaged",
        TODAY,
        150,
      ).eligible,
    ).toBe(false);
  });

  it("rejects orders that were already refunded", () => {
    expect(
      evaluateEligibility(order({ refunded_amount: 10 }), "damaged", TODAY, 150)
        .eligible,
    ).toBe(false);
  });

  it("excludes final-sale items for change of mind, but not for damage", () => {
    const mixed = order({
      items: [
        { sku: "A", name: "Normal", unit_price: 20, qty: 1, final_sale: false },
        {
          sku: "B",
          name: "Clearance",
          unit_price: 99,
          qty: 1,
          final_sale: true,
        },
      ],
    });
    expect(evaluateEligibility(mixed, "changed_mind", TODAY, 150).amount).toBe(
      20,
    );
    expect(evaluateEligibility(mixed, "damaged", TODAY, 150).amount).toBe(119);
  });

  it("requires a human above the auto-approval limit", () => {
    const r = evaluateEligibility(order(), "damaged", TODAY, 50);
    expect(r.eligible).toBe(true);
    expect(r.requiresHuman).toBe(true);
    expect(r.amount).toBe(100);
  });

  it("refunds only shipping for late delivery", () => {
    expect(
      evaluateEligibility(
        order({ delivered_late: true }),
        "late_delivery",
        TODAY,
        150,
      ).amount,
    ).toBe(5);
    expect(
      evaluateEligibility(order(), "late_delivery", TODAY, 150).eligible,
    ).toBe(false);
  });

  it("sends unknown reasons to a human", () => {
    expect(
      evaluateEligibility(order(), "other", TODAY, 150).requiresHuman,
    ).toBe(true);
  });
});
