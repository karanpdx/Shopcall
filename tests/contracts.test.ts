import test from "node:test";
import assert from "node:assert/strict";
import { catalogChange, productFields } from "../src/contracts/catalog";

const fields = { title: "Blue mug", description: "Speckled glaze", priceMinor: 2400, currencyCode: "USD", inventoryTracked: true, quantityOnHand: 4 };
test("zero inventory and integer money are valid", () => {
  assert.equal(productFields.parse({ ...fields, quantityOnHand: 0 }).quantityOnHand, 0);
  assert.equal(productFields.safeParse({ ...fields, priceMinor: 24.5 }).success, false);
  assert.equal(productFields.safeParse({ ...fields, priceMinor: -1 }).success, false);
});
test("tracked and untracked inventory cannot contradict quantity", () => {
  assert.equal(productFields.safeParse({ ...fields, quantityOnHand: null }).success, false);
  assert.equal(productFields.safeParse({ ...fields, inventoryTracked: false }).success, false);
  assert.equal(productFields.safeParse({ ...fields, inventoryTracked: false, quantityOnHand: null }).success, true);
});
test("mutations require stable product identity and reject unknown fields", () => {
  assert.equal(catalogChange.safeParse({ type: "set_quantity", productId: "blue mug", newQuantity: 0 }).success, false);
  assert.equal(catalogChange.safeParse({ type: "set_quantity", productId: "f1fa84f0-c846-48ba-9cad-7bf073e906fb", newQuantity: -1 }).success, false);
  assert.equal(catalogChange.safeParse({ type: "set_quantity", productId: "f1fa84f0-c846-48ba-9cad-7bf073e906fb", newQuantity: 0, confirmed: true }).success, false);
});
