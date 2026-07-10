import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  approvedFaqRecordsForProduct,
  buildConversationPlan,
  classifyFaqSalesPromptResponse,
  extractOrderDetails,
  findApprovedFaqExactMatch,
  findProduct,
  findProductMatch,
  isGeneralBusinessQuestion,
  isProductNameMessage,
  normalizeCustomerMessage,
  isProductSpecificQuestion,
  usesFixedOpeningFlow,
} from "./conversation.mjs";

const catalog = JSON.parse(
  await readFile(new URL("../data/product_catalog.json", import.meta.url), "utf8")
);
const faqLibrary = JSON.parse(
  await readFile(new URL("../data/general_faqs.json", import.meta.url), "utf8")
);
const storedOrders = JSON.parse(
  await readFile(new URL("../data/order_parser_regression_cases.json", import.meta.url), "utf8")
).orders;
const product = catalog.products.find((item) => item.id === "blackhead-remover");
const ilsoProduct = catalog.products.find((item) => item.id === "p08-ilso-super-melting-sebum-softener");
const blackheadSalesPrompt = product.opening_flow.at(-1).body;
product.sales_prompt = blackheadSalesPrompt;
ilsoProduct.sales_prompt = "Ada minat nak ambil special combo?";

function asEscapedDemoSubmission(rawMessage) {
  return String(rawMessage).replace(/\r?\n/g, "\\n");
}

test("stored order submissions stay structured when demo input contains escaped line breaks", () => {
  assert.ok(storedOrders.length > 0, "Expected stored order parser regression cases");

  for (const order of storedOrders) {
    const parsed = extractOrderDetails(asEscapedDemoSubmission(order.rawMessage), product);

    assert.equal(parsed.name, order.name, `name for ${order.id}`);
    assert.equal(parsed.phone, order.phone, `phone for ${order.id}`);
    assert.equal(parsed.address, order.address, `address for ${order.id}`);
    assert.equal(parsed.packageId, order.packageId, `package for ${order.id}`);
    assert.equal(parsed.quantity, order.quantity, `quantity for ${order.id}`);
    assert.equal(parsed.isComplete, true, `completed order for ${order.id}`);
  }
});

test("completed order hands admin clean separated fields", async () => {
  const order = storedOrders[0];
  const plan = await buildConversationPlan({
    catalog,
    customer: { id: order.customerId, productId: order.productId },
    customerMessage: asEscapedDemoSubmission(order.rawMessage),
  });

  assert.equal(plan.handoffRequired, true);
  assert.deepEqual(
    {
      packageId: plan.order.packageId,
      name: plan.order.name,
      phone: plan.order.phone,
      address: plan.order.address,
    },
    {
      packageId: order.packageId,
      name: order.name,
      phone: order.phone,
      address: order.address,
    }
  );
  assert.match(plan.adminMessage, new RegExp(`Name: ${order.name}\\nPhone: ${order.phone}\\nAddress: ${order.address}`));
  assert.doesNotMatch(plan.order.name, /Full address|Phone number|Order Package/i);
});

test("completed order includes the product shopping link for order processing", async () => {
  const linkedCatalog = structuredClone(catalog);
  linkedCatalog.products.find((item) => item.id === product.id).shopping_link =
    "https://supplier.example.com/blackhead-remover";
  const order = storedOrders[0];
  const plan = await buildConversationPlan({
    catalog: linkedCatalog,
    customer: { id: order.customerId, productId: order.productId },
    customerMessage: asEscapedDemoSubmission(order.rawMessage),
  });

  assert.equal(plan.order.shoppingLink, "https://supplier.example.com/blackhead-remover");
  assert.match(plan.adminMessage, /Shopping link: https:\/\/supplier\.example\.com\/blackhead-remover/);
});

test("order details without a selected package do not create an admin handoff", async () => {
  const plan = await buildConversationPlan({
    catalog,
    customer: { id: "customer_missing_package", productId: product.id },
    customerMessage: "Full name: Ali\\nFull address: Kiulap\\nPhone number: 6731234567",
  });

  assert.equal(plan.order, undefined);
  assert.equal(plan.handoffRequired, false);
});

test("product order form labels are editable per product", async () => {
  const customCatalog = structuredClone(catalog);
  const customProduct = customCatalog.products.find((item) => item.id === product.id);
  customProduct.order_form = {
    intro: "Share details untuk lock promo ya",
    nameLabel: "Nama penuh",
    addressLabel: "Alamat delivery",
    phoneLabel: "Nombor WhatsApp",
    optionLabel: "Pilihan package",
  };

  const plan = await buildConversationPlan({
    catalog: customCatalog,
    customer: { id: "customer_custom_order_form", productId: product.id },
    customerMessage: "mau order",
  });

  assert.match(plan.messages[1].body, /Share details untuk lock promo ya/);
  assert.match(plan.messages[1].body, /Nama penuh :/);
  assert.match(plan.messages[1].body, /Alamat delivery :/);
  assert.match(plan.messages[1].body, /Nombor WhatsApp :/);
  assert.match(plan.messages[1].body, /Pilihan package :/);
});

test("order parser accepts custom product order form labels", () => {
  const customProduct = structuredClone(product);
  customProduct.order_form = {
    nameLabel: "Nama penuh",
    addressLabel: "Alamat delivery",
    phoneLabel: "Nombor WhatsApp",
    optionLabel: "Pilihan package",
  };

  const parsed = extractOrderDetails(
    "Nama penuh: Ali\\nAlamat delivery: Kiulap\\nNombor WhatsApp: 6731234567\\nPilihan package: Package B",
    customProduct
  );

  assert.equal(parsed.name, "Ali");
  assert.equal(parsed.address, "Kiulap");
  assert.equal(parsed.phone, "6731234567");
  assert.equal(parsed.packageId, "B");
  assert.equal(parsed.isComplete, true);
});

test("free-form order details create draft and ask only for missing package option", async () => {
  const plan = await buildConversationPlan({
    catalog,
    customer: { id: "customer_free_form_order", productId: product.id },
    customerMessage: "syuk aiman\nno 15 spg 120-48-70-5-13 stkrj MUMONG\n8306830",
  });

  assert.equal(plan.order, undefined);
  assert.equal(plan.handoffRequired, false);
  assert.equal(plan.customerPatch.pendingOrder.draft.name, "syuk aiman");
  assert.equal(plan.customerPatch.pendingOrder.draft.phone, "8306830");
  assert.equal(plan.customerPatch.pendingOrder.draft.address, "no 15 spg 120-48-70-5-13 stkrj MUMONG");
  assert.match(plan.messages[0].body, /tinggal pilih order option/i);
  assert.doesNotMatch(plan.messages[0].body, /Full name/i);
});

test("pending free-form order completes when customer replies with bare package letter", async () => {
  const plan = await buildConversationPlan({
    catalog,
    customer: {
      id: "customer_pending_package_letter",
      productId: product.id,
      pendingOrder: {
        productId: product.id,
        startedAt: "2026-06-27T00:00:00.000Z",
        draft: {
          name: "syuk aiman",
          phone: "8306830",
          address: "no 15 spg 120-48-70-5-13 stkrj MUMONG",
          quantity: 1,
        },
      },
    },
    customerMessage: "A",
  });

  assert.equal(plan.handoffRequired, true);
  assert.equal(plan.customerPatch.pendingOrder, null);
  assert.equal(plan.order.name, "syuk aiman");
  assert.equal(plan.order.phone, "8306830");
  assert.equal(plan.order.address, "no 15 spg 120-48-70-5-13 stkrj MUMONG");
  assert.equal(plan.order.orderOptionName, "Package A");
});

test("pending free-form order completes when customer replies with paket alias and phone", async () => {
  const plan = await buildConversationPlan({
    catalog,
    customer: {
      id: "customer_pending_paket_alias",
      productId: product.id,
      pendingOrder: {
        productId: product.id,
        startedAt: "2026-07-04T00:00:00.000Z",
        draft: {
          name: "Yeti Suryati",
          address: "Kampung perpindahan mentiri jalan D simpang penghujung 41 das 24 no 8",
          quantity: 1,
        },
      },
    },
    customerMessage: "Paket A\n+6737248011",
  });

  assert.equal(plan.handoffRequired, true);
  assert.equal(plan.customerPatch.pendingOrder, null);
  assert.equal(plan.order.name, "Yeti Suryati");
  assert.equal(plan.order.phone, "+6737248011");
  assert.equal(plan.order.address, "Kampung perpindahan mentiri jalan D simpang penghujung 41 das 24 no 8");
  assert.equal(plan.order.orderOptionName, "Package A");
});

test("buffered split free-form order parses as one complete submission", async () => {
  const plan = await buildConversationPlan({
    catalog,
    customer: { id: "customer_buffered_order", productId: product.id },
    customerMessage:
      "Yeti Suryati\nKampung perpindahan mentiri jalan D simpang penghujung 41 das 24 no 8\nPaket A\n+6737248011",
  });

  assert.equal(plan.handoffRequired, true);
  assert.equal(plan.customerPatch.pendingOrder, null);
  assert.equal(plan.order.name, "Yeti Suryati");
  assert.equal(plan.order.phone, "+6737248011");
  assert.equal(plan.order.address, "Kampung perpindahan mentiri jalan D simpang penghujung 41 das 24 no 8");
  assert.equal(plan.order.orderOptionName, "Package A");
});

test("combo products require the customer add-on choice", () => {
  const missingAddOn = extractOrderDetails(
    "Full name: Aina\\nFull address: Kiulap\\nPhone number: 6738123456\\nOrder option: Special Combo",
    ilsoProduct
  );
  assert.equal(missingAddOn.orderOptionId, "special-combo");
  assert.equal(missingAddOn.isComplete, false);

  const completed = extractOrderDetails(
    "Full name: Aina\\nFull address: Kiulap\\nPhone number: 6738123456\\nSpecial combo collagen mask",
    ilsoProduct
  );
  assert.equal(completed.orderOptionId, "special-combo");
  assert.equal(completed.orderOptionName, "Special Combo");
  assert.equal(completed.orderOptionPrice, "B$55");
  assert.equal(completed.addOnChoice, "Bio Collagen Mask x 5");
  assert.equal(completed.isComplete, true);
});

test("incomplete order reply follows the order request flow", async () => {
  const plan = await buildConversationPlan({
    catalog,
    customer: { id: "customer_missing_address", productId: ilsoProduct.id },
    customerMessage:
      "Full name: ken\nFull address:\nPhone number: 11\nOrder option: Special Combo\nAdd-on choice: scrub tool",
  });

  assert.equal(plan.order, undefined);
  assert.equal(plan.handoffRequired, false);
  assert.equal(plan.messages.length, 1);
  assert.match(plan.messages[0].body, /tinggal full address/i);
  assert.match(plan.messages[0].body, /alamat penuh/i);
  assert.equal(plan.customerPatch.pendingOrder.draft.name, "ken");
  assert.equal(plan.customerPatch.pendingOrder.draft.phone, "11");
  assert.equal(plan.customerPatch.pendingOrder.draft.orderOptionId, "special-combo");
  assert.equal(plan.customerPatch.pendingOrder.draft.addOnChoice, "ilso Scrub Tool");
});

test("pending incomplete order completes when customer sends the missing address only", async () => {
  const plan = await buildConversationPlan({
    catalog,
    customer: {
      id: "customer_pending_address",
      productId: ilsoProduct.id,
      pendingOrder: {
        productId: ilsoProduct.id,
        startedAt: "2026-06-26T00:00:00.000Z",
        draft: {
          name: "Aina",
          phone: "6738123456",
          orderOptionId: "special-combo",
          orderOptionName: "Special Combo",
          orderOptionPrice: "B$55",
          requiresAddOn: true,
          addOnChoice: "Bio Collagen Mask x 5",
          quantity: 1,
        },
      },
    },
    customerMessage: "Kiulap, Bandar Seri Begawan",
  });

  assert.equal(plan.handoffRequired, true);
  assert.equal(plan.customerPatch.pendingOrder, null);
  assert.equal(plan.order.name, "Aina");
  assert.equal(plan.order.phone, "6738123456");
  assert.equal(plan.order.address, "Kiulap, Bandar Seri Begawan");
  assert.equal(plan.order.orderOptionId, "special-combo");
  assert.equal(plan.order.addOnChoice, "Bio Collagen Mask x 5");
});

test("combo order asks only for missing add-on choice", async () => {
  const plan = await buildConversationPlan({
    catalog,
    customer: { id: "customer_missing_addon", productId: ilsoProduct.id },
    customerMessage:
      "Full name: Aina\\nFull address: Kiulap\\nPhone number: 6738123456\\nOrder option: Special Combo",
  });

  assert.equal(plan.order, undefined);
  assert.equal(plan.handoffRequired, false);
  assert.equal(plan.messages.length, 1);
  assert.match(plan.messages[0].body, /tinggal pilih add-on/i);
  assert.match(plan.messages[0].body, /Bio Collagen Mask x 5/i);
});

test("completed combo order hands admin option and add-on fields", async () => {
  const plan = await buildConversationPlan({
    catalog,
    customer: { id: "customer_ilso_combo", productId: ilsoProduct.id },
    customerMessage:
      "Full name: Aina\\nFull address: Kiulap\\nPhone number: 6738123456\\nOrder option: Special Combo\\nAdd-on choice: Bio Collagen Mask x 5",
  });

  assert.equal(plan.handoffRequired, true);
  assert.equal(plan.order.orderOptionId, "special-combo");
  assert.equal(plan.order.orderOptionName, "Special Combo");
  assert.equal(plan.order.addOnChoice, "Bio Collagen Mask x 5");
  assert.match(plan.adminMessage, /Order option: Special Combo \(B\$55\)/);
  assert.match(plan.adminMessage, /Add-on choice: Bio Collagen Mask x 5/);
});

test("single-option products can complete order without typing the option name", () => {
  const singleOptionProduct = {
    id: "single-product",
    name: "Single Product",
    order_options: [
      { id: "single-unit", name: "Single Unit", price: "B$39", quantity: 1 },
    ],
  };
  const parsed = extractOrderDetails(
    "Full name: Lina\\nFull address: Gadong\\nPhone number: 6738000000",
    singleOptionProduct
  );

  assert.equal(parsed.orderOptionId, "single-unit");
  assert.equal(parsed.orderOptionName, "Single Unit");
  assert.equal(parsed.isComplete, true);
});

test("package price question does not begin order collection", async () => {
  const plan = await buildConversationPlan({
    catalog,
    customer: { id: "customer_price_question", productId: product.id },
    customerMessage: "Package A harga berapa?",
    ragAnswer: {
      reply: "Model answer is only needed when no stored FAQ matches.",
      buyingIntent: "not_buying",
      handoffRequired: false,
      handoffReason: "",
    },
  });

  assert.match(plan.messages[0].body, /Package A: B\$39/);
  assert.doesNotMatch(plan.messages[0].body, /Full name/);
  assert.equal(plan.messages[1].body, blackheadSalesPrompt);
  assert.equal(plan.customerPatch.pendingOrder, undefined);
  assert.equal(plan.handoffRequired, false);
});

test("product name plus pm does not begin order collection without ad context", async () => {
  const plan = await buildConversationPlan({
    catalog,
    customer: { id: "customer_product_pm", productId: product.id },
    customerMessage: "Blackhead Remover\nPm",
    ragAnswer: {
      reply: "",
      buyingIntent: "not_buying",
      handoffRequired: true,
      handoffReason: "No matching sales response, FAQ, or RAG answer.",
    },
  });

  assert.equal(plan.order, undefined);
  assert.equal(plan.customerPatch.pendingOrder, undefined);
  assert.equal(plan.handoffRequired, false);
  assert.doesNotMatch(plan.messages[0].body, /Full name/i);
});

test("GPT-confirmed buying intention begins order collection", async () => {
  const plan = await buildConversationPlan({
    catalog,
    customer: { id: "customer_ready_to_order", productId: product.id },
    customerMessage: "Boleh simpan Package B untuk saya, saya jadi ambil.",
    ragAnswer: {
      reply: "",
      buyingIntent: "buying",
      handoffRequired: false,
      handoffReason: "",
    },
  });

  assert.equal(plan.customerPatch.pendingOrder.productId, product.id);
  assert.equal(plan.messages.length, 1);
  assert.match(plan.messages[0].body, /full name/i);
  assert.match(plan.messages[0].body, /phone number/i);
  assert.equal(plan.customerPatch.pendingOrder.draft.orderOptionName, "Package B");
  assert.equal(plan.handoffRequired, false);
});

test("local Malay order intent begins order collection without OpenAI", async () => {
  const plan = await buildConversationPlan({
    catalog,
    customer: { id: "customer_malay_order_intent", productId: ilsoProduct.id },
    customerMessage: "sya mau order",
  });

  assert.equal(plan.customerPatch.pendingOrder.productId, ilsoProduct.id);
  assert.match(plan.messages[1].body, /Full name|Nama/i);
  assert.equal(plan.handoffRequired, false);
});

test("core customer lifecycle covers new customer, follow-up, handoff, and submitted order", async () => {
  let customer = { id: "customer_lifecycle", productId: "" };

  const newCustomerPlan = await buildConversationPlan({
    catalog,
    customer,
    customerMessage: "Assalamualaikum, saya berminat",
    source: { referralHeadline: "Facebook ad blackhead remover" },
  });
  customer = { ...customer, ...newCustomerPlan.customerPatch };

  assert.equal(customer.productId, product.id);
  assert.equal(newCustomerPlan.handoffRequired, false);
  assert.ok(newCustomerPlan.messages.length > 1);

  const faqFollowUpPlan = await buildConversationPlan({
    catalog,
    faqLibrary,
    customer,
    customerMessage: "Package B berapa?",
  });
  customer = { ...customer, ...faqFollowUpPlan.customerPatch };

  assert.equal(faqFollowUpPlan.messages[1].body, blackheadSalesPrompt);
  assert.equal(customer.awaitingPackageBInterest, true);
  assert.equal(faqFollowUpPlan.handoffRequired, false);

  const orderStartPlan = await buildConversationPlan({
    catalog,
    customer,
    customerMessage: "ada",
  });
  customer = { ...customer, ...orderStartPlan.customerPatch };

  assert.equal(orderStartPlan.messages[0].body, "Noted and thank you.");
  assert.match(orderStartPlan.messages[1].body, /Full name/i);
  assert.equal(customer.pendingOrder.productId, product.id);
  assert.equal(orderStartPlan.handoffRequired, false);

  const handoffPlan = await buildConversationPlan({
    catalog,
    customer: { id: "customer_lifecycle_handoff", productId: product.id },
    customerMessage: "Can you issue tax invoice?",
  });

  assert.equal(handoffPlan.handoffRequired, true);
  assert.equal(handoffPlan.customerPatch.handoffStatus, "human_required");
  assert.equal(handoffPlan.messages.length, 0);

  const submittedOrderPlan = await buildConversationPlan({
    catalog,
    customer,
    customerMessage: storedOrders[1].rawMessage,
  });

  assert.equal(submittedOrderPlan.handoffRequired, true);
  assert.equal(submittedOrderPlan.handoffReason, "Customer submitted complete order details.");
  assert.equal(submittedOrderPlan.customerPatch.pendingOrder, null);
  assert.equal(submittedOrderPlan.customerPatch.handoffStatus, "human_required");
  assert.equal(submittedOrderPlan.order.name, storedOrders[1].name);
  assert.equal(submittedOrderPlan.order.packageId, storedOrders[1].packageId);
  assert.match(submittedOrderPlan.adminMessage, /New WhatsApp order to process/i);
});

test("order closing messages come from the product sequence", async () => {
  const customCatalog = structuredClone(catalog);
  const customProduct = customCatalog.products.find((item) => item.id === product.id);
  customProduct.order_closing_messages = ["Closing message one", "Closing message two"];

  const submittedOrderPlan = await buildConversationPlan({
    catalog: customCatalog,
    customer: { id: "customer_custom_closing", productId: customProduct.id },
    customerMessage: storedOrders[1].rawMessage,
  });

  assert.equal(submittedOrderPlan.handoffRequired, true);
  assert.deepEqual(submittedOrderPlan.messages.map((message) => message.body), [
    "Closing message one",
    "Closing message two",
  ]);
});

test("empty product order closing sequence sends no closing messages", async () => {
  const customCatalog = structuredClone(catalog);
  const customProduct = customCatalog.products.find((item) => item.id === product.id);
  customProduct.order_closing_messages = [];

  const submittedOrderPlan = await buildConversationPlan({
    catalog: customCatalog,
    customer: { id: "customer_empty_closing", productId: customProduct.id },
    customerMessage: storedOrders[1].rawMessage,
  });

  assert.equal(submittedOrderPlan.handoffRequired, true);
  assert.deepEqual(submittedOrderPlan.messages, []);
});

test("opening flow sends uncaptioned testimonial images before testimonial text", async () => {
  const plan = await buildConversationPlan({
    catalog,
    customer: { id: "customer_opening_flow", productId: "" },
    customerMessage: "Assalamualaikum, saya berminat",
    source: { referralHeadline: "Facebook ad blackhead remover" },
  });
  const testimonyTextIndex = plan.messages.findIndex((message) =>
    String(message.body || "").includes("Dgn sini adalah customer")
  );
  const testimonialEntries = plan.messages
    .map((message, index) => ({ message, index }))
    .filter(({ message }) => String(message.url || "").includes("testimonial-"));

  assert.equal(testimonialEntries.length, 4);
  assert.ok(testimonyTextIndex > -1);
  for (const { message, index } of testimonialEntries) {
    assert.equal(message.caption, "");
    assert.ok(index < testimonyTextIndex);
  }
});

test("opening flow does not include missing optional sales photo", async () => {
  const plan = await buildConversationPlan({
    catalog,
    customer: { id: "customer_no_optional_sales_photo", productId: "" },
    customerMessage: product.name,
    source: { productId: product.id },
  });

  assert.equal(
    plan.messages.some((message) => String(message.url || "").includes("/assets/blackhead-remover/sales")),
    false
  );
});

test("initial Facebook ad enquiry uses the fixed opening flow without needing OpenAI", () => {
  assert.equal(
    usesFixedOpeningFlow(
      { id: "new_ad_customer", productId: "" },
      "Assalamualaikum, saya berminat",
      { referralHeadline: "Facebook ad blackhead remover" }
    ),
    true
  );
  assert.equal(
    usesFixedOpeningFlow(
      { id: "existing_customer", productId: product.id },
      "Package A harga berapa?",
      {}
    ),
    false
  );
});

test("new customer sending only product name receives that product opening flow", async () => {
  const plan = await buildConversationPlan({
    catalog,
    customer: { id: "new_product_name_customer", productId: "" },
    customerMessage: ilsoProduct.name,
    source: { productId: ilsoProduct.id },
  });

  assert.equal(plan.customerPatch.productId, ilsoProduct.id);
  assert.equal(plan.handoffRequired, false);
  assert.notEqual(plan.messages[0].body, "This should not be sent before the opening flow.");
  assert.ok(plan.messages.length > 1);
});

test("existing customer sending product name receives opening flow instead of image knowledge", async () => {
  const plan = await buildConversationPlan({
    catalog,
    customer: { id: "existing_product_name_customer", productId: ilsoProduct.id },
    customerMessage: ilsoProduct.name,
    source: { productId: ilsoProduct.id },
  });

  assert.equal(plan.customerPatch.productId, ilsoProduct.id);
  assert.equal(plan.handoffRequired, false);
  assert.notEqual(plan.messages[0].body, "Promotional sales image raw summary should not be sent.");
  assert.ok(plan.messages.length > 1);
});

test("product SKU can trigger product opening flow", async () => {
  const skuCatalog = {
    ...catalog,
    products: catalog.products.map((entry) =>
      entry.id === ilsoProduct.id ? { ...entry, sku_code: "P08" } : entry
    ),
  };
  const plan = await buildConversationPlan({
    catalog: skuCatalog,
    customer: { id: "sku_opening_customer", productId: "" },
    customerMessage: "P08",
  });

  assert.equal(plan.customerPatch.productId, ilsoProduct.id);
  assert.equal(isProductNameMessage({ ...ilsoProduct, sku_code: "P08" }, "P08"), true);
  assert.equal(isProductNameMessage({ ...ilsoProduct, sku_code: "P08" }, "P08 ada stock?"), false);
});

test("product name without saved SKU prefix can trigger opening flow", async () => {
  const message = "Ilso super melting sebum softener";
  const product = findProduct(catalog, message);
  assert.equal(product.id, ilsoProduct.id);
  assert.equal(isProductNameMessage(product, message), true);

  const plan = await buildConversationPlan({
    catalog,
    customer: { id: "sku_prefix_removed_customer", productId: "" },
    customerMessage: message,
  });

  assert.equal(plan.customerPatch.productId, ilsoProduct.id);
  assert.equal(plan.handoffRequired, false);
  assert.ok(plan.messages.length > 1);
});

test("short product name prefix can trigger opening flow for new product names", async () => {
  const skinProduct = {
    ...ilsoProduct,
    id: "skin-1004-tone-brightening",
    name: "Skin 1004 Tone Brightening",
    aliases: [],
    ad_keywords: [],
  };
  const skinCatalog = {
    ...catalog,
    products: [...catalog.products, skinProduct],
  };
  const product = findProduct(skinCatalog, "Skin 1004");
  assert.equal(product.id, skinProduct.id);
  assert.equal(isProductNameMessage(product, "Skin 1004"), true);

  const plan = await buildConversationPlan({
    catalog: skinCatalog,
    customer: { id: "short_product_name_customer", productId: "" },
    customerMessage: "Skin 1004",
  });

  assert.equal(plan.customerPatch.productId, skinProduct.id);
  assert.equal(plan.handoffRequired, false);
  assert.ok(plan.messages.length > 1);
});

test("short product name prefix matches before applying an existing product fallback", () => {
  const skinProduct = {
    ...ilsoProduct,
    id: "skin-1004-tone-brightening",
    name: "Skin 1004 Tone Brightening",
    aliases: [],
    ad_keywords: [],
  };
  const skinCatalog = {
    ...catalog,
    products: [...catalog.products, skinProduct],
  };
  const product = findProduct(skinCatalog, "Skin 1004", {}, "");

  assert.equal(product.id, skinProduct.id);
});

test("product can be detected from ad greeting context", () => {
  const adCatalog = {
    default_product_id: "blackhead-remover",
    products: [
      { id: "blackhead-remover", name: "Blackhead Remover", aliases: ["blackhead remover"] },
      { id: "wipe-xpert", name: "Wipe Xpert", aliases: ["wipe xpert"] },
    ],
  };
  const matched = findProductMatch(adCatalog, "Hi! Are you interested in Wipe Xpert?");

  assert.equal(matched.id, "wipe-xpert");
});

test("product name inside a longer message does not trigger opening flow", async () => {
  assert.equal(isProductNameMessage(ilsoProduct, ilsoProduct.name), true);
  assert.equal(isProductNameMessage(ilsoProduct, `I want to ask about ${ilsoProduct.name}`), false);
  const plan = await buildConversationPlan({
    catalog,
    customer: { id: "long_product_name_customer", productId: ilsoProduct.id },
    customerMessage: `I want to ask about ${ilsoProduct.name}`,
    source: { productId: ilsoProduct.id },
  });

  assert.equal(plan.messages.length, 0);
  assert.equal(plan.handoffRequired, true);
});

test("general approved replies apply during any product conversation", async () => {
  const generalCases = [
    ["Business location kat mana?", "Warehouse at bandar. Tapi skrg buleh proceed delivery dgn MP service saja"],
    ["Delivery ada caj?", "nda ya"],
    ["Delivery ada caj tak?", "nda ya"],
    ["Ada delivery caj tak?", "nda ya"],
    ["Delivery free ke?", "nda ya"],
    ["Ada delivery?", "ada"],
    ["Buleh bayar hujung bulan?", "Buleh"],
    ["Berapa hari barang baru sampai?", "15-18 days."],
    ["nanti if barang sampai kita deliver or pickup sendiri?", "Kami akan deliver ya."],
  ];

  for (const [customerMessage, expectedReply] of generalCases) {
    const plan = await buildConversationPlan({
      catalog,
      faqLibrary,
      customer: { id: "customer_general_reply", productId: product.id },
      customerMessage,
    });

    assert.equal(plan.messages[0].body, expectedReply, customerMessage);
    assert.equal(plan.messages[1].body, blackheadSalesPrompt, customerMessage);
    assert.equal(plan.customerPatch.awaitingPackageBInterest, true, customerMessage);
    assert.equal(plan.handoffRequired, false, customerMessage);
  }
});

test("short delivery fee follow-up uses previous delivery context", async () => {
  const plan = await buildConversationPlan({
    catalog,
    faqLibrary,
    customer: {
      id: "customer_delivery_context",
      productId: product.id,
      lastApprovedFaqId: "general_delivery_available",
    },
    customerMessage: "ada caj?",
  });

  assert.equal(plan.messages[0].body, "nda ya");
  assert.equal(plan.customerPatch.lastApprovedFaqId, "general_delivery_fee");
  assert.equal(plan.handoffRequired, false);
});

test("short delivery fee follow-up can use recent conversation memory", async () => {
  const plan = await buildConversationPlan({
    catalog,
    faqLibrary,
    customer: { id: "customer_delivery_memory", productId: product.id },
    customerMessage: "ada caj?",
    conversationContext: [
      { role: "customer", text: "ada delivery ke rumahkah?" },
      { role: "agent", text: "ada" },
    ],
  });

  assert.equal(plan.messages[0].body, "nda ya");
  assert.equal(plan.customerPatch.lastApprovedFaqId, "general_delivery_fee");
  assert.equal(plan.handoffRequired, false);
});

test("short charge question without context asks for clarification", async () => {
  const plan = await buildConversationPlan({
    catalog,
    faqLibrary,
    customer: { id: "customer_charge_no_context", productId: product.id },
    customerMessage: "ada caj?",
  });

  assert.match(plan.messages[0].body, /Delivery, harga, atau produk/i);
  assert.equal(plan.handoffRequired, false);
});

test("short unclear question asks for clarification instead of handoff", async () => {
  const plan = await buildConversationPlan({
    catalog,
    faqLibrary,
    customer: { id: "customer_unclear_short_question", productId: product.id },
    customerMessage: "yang mana?",
  });

  assert.match(plan.messages[0].body, /maksudkan/i);
  assert.equal(plan.handoffRequired, false);
});

test("common paraphrased business questions answer without OpenAI", async () => {
  const cases = [
    ["area mana", "Warehouse at bandar. Tapi skrg buleh proceed delivery dgn MP service saja"],
    ["ada perhantaran ke rumahkah?", "ada"],
  ];

  for (const [customerMessage, expectedReply] of cases) {
    const plan = await buildConversationPlan({
      catalog,
      faqLibrary,
      customer: { id: "customer_paraphrased_general", productId: ilsoProduct.id },
      customerMessage,
    });

    assert.equal(plan.messages[0].body, expectedReply, customerMessage);
    assert.equal(plan.handoffRequired, false, customerMessage);
  }
});

test("general FAQ replies take priority over approved image chunks", async () => {
  const chunkCatalog = structuredClone(catalog);
  const chunkProduct = chunkCatalog.products.find((item) => item.id === ilsoProduct.id);
  chunkProduct.extracted_knowledge = {
    pending: [],
    approved: [],
    pendingImages: [],
    approvedImages: [
      {
        id: "image_nose_area",
        kind: "image_chunk",
        category: "benefit_claim",
        title: "Without ILSO vs with ILSO",
        summary: "Promotional comparison image showing a nose area and cleaner pores.",
        extracted_text: "WITHOUT ILSO vs WITH ILSO on a nose area.",
      },
      {
        id: "image_delivery_price",
        kind: "image_chunk",
        category: "price",
        title: "Price promo image",
        summary: "Price promo image mentions delivery and refund messages.",
        extracted_text: "Delivery/refund messages are visible in the price image.",
      },
    ],
  };

  const cases = [
    ["area mana", "Warehouse at bandar. Tapi skrg buleh proceed delivery dgn MP service saja", "general_business_location"],
    ["ada delivery tak?", "ada", "general_delivery_available"],
  ];

  for (const [customerMessage, expectedReply, expectedFaqId] of cases) {
    const plan = await buildConversationPlan({
      catalog: chunkCatalog,
      faqLibrary,
      customer: { id: "customer_general_over_chunk", productId: chunkProduct.id },
      customerMessage,
    });

    assert.equal(plan.messages[0].body, expectedReply, customerMessage);
    assert.equal(plan.customerPatch.lastApprovedFaqId, expectedFaqId, customerMessage);
    assert.equal(plan.customerPatch.lastProductFactId, undefined, customerMessage);
    assert.equal(plan.handoffRequired, false, customerMessage);
  }
});

test("product order option price question answers from configured options", async () => {
  const plan = await buildConversationPlan({
    catalog,
    customer: { id: "customer_ilso_price", productId: ilsoProduct.id },
    customerMessage: "harganya satu $39 or $55?",
  });

  assert.match(plan.messages[0].body, /Single Unit: B\$39/);
  assert.match(plan.messages[0].body, /Special Combo: B\$55/);
  assert.equal(plan.handoffRequired, false);
});

test("polite maybe-later customer reply does not create handoff", async () => {
  const plan = await buildConversationPlan({
    catalog,
    customer: { id: "customer_maybe_later", productId: ilsoProduct.id },
    customerMessage: "terima kasih info nya.. kalay sya mau ada sya txt lagi.",
  });

  assert.match(plan.messages[0].body, /Sama-sama/);
  assert.equal(plan.handoffRequired, false);
});

test("approved image chunks do not answer locally without vector-store RAG", async () => {
  const factCatalog = structuredClone(catalog);
  const factProduct = factCatalog.products.find((item) => item.id === ilsoProduct.id);
  factProduct.extracted_knowledge = {
    pending: [],
    approved: [],
    pendingImages: [],
    approvedImages: [
      {
        id: "image_volume",
        kind: "image_chunk",
        category: "specification",
        title: "Product volume",
        summary: "The image shows the product volume is 150ml.",
        extracted_text: "Product volume: 150ml.",
        question_examples: ["berapa ml?", "1 botol contains how much ml?"],
      },
    ],
  };
  const plan = await buildConversationPlan({
    catalog: factCatalog,
    customer: { id: "customer_volume", productId: factProduct.id },
    customerMessage: "ilso ada berapa ml?",
  });

  assert.equal(plan.messages.length, 0);
  assert.equal(plan.handoffRequired, true);
});

test("blackhead feature questions require generated RAG product fact replies", async () => {
  const cases = [
    "Suction kuat tak?",
    "Ada berapa mode?",
    "Buleh recharge?",
  ];

  for (const customerMessage of cases) {
    const plan = await buildConversationPlan({
      catalog,
      customer: { id: "customer_blackhead_feature", productId: product.id },
      customerMessage,
    });

    assert.equal(plan.handoffRequired, true, customerMessage);
    assert.equal(plan.messages.length, 0, customerMessage);
  }
});

test("vector-store RAG answers when local approved replies do not match", async () => {
  const plan = await buildConversationPlan({
    catalog,
    customer: { id: "customer_retrieved_fact", productId: ilsoProduct.id },
    customerMessage: "how big is one bottle?",
    ragAnswer: {
      reply: "Volume: 150ml",
      replyType: "faq",
      buyingIntent: "not_buying",
      handoffRequired: false,
      allowProductSpecific: true,
    },
  });

  assert.equal(plan.messages[0].body, "Volume: 150ml");
  assert.equal(plan.customerPatch.awaitingPackageBInterest, true);
  assert.equal(plan.handoffRequired, false);
});

test("FAQ sales prompt frequency can send every second answered question", async () => {
  const customCatalog = structuredClone(catalog);
  const customProduct = customCatalog.products.find((item) => item.id === ilsoProduct.id);
  customProduct.sales_prompt = "Custom follow-up prompt";
  customProduct.sales_prompt_frequency = 2;

  const firstPlan = await buildConversationPlan({
    catalog: customCatalog,
    customer: { id: "customer_prompt_frequency", productId: customProduct.id },
    customerMessage: "how big is one bottle?",
    ragAnswer: {
      reply: "Volume: 150ml",
      replyType: "faq",
      buyingIntent: "not_buying",
      handoffRequired: false,
      allowProductSpecific: true,
    },
  });

  assert.deepEqual(firstPlan.messages.map((message) => message.body), ["Volume: 150ml"]);
  assert.equal(firstPlan.customerPatch.awaitingPackageBInterest, false);
  assert.equal(firstPlan.customerPatch.faqSalesPromptCounts[customProduct.id], 1);

  const secondPlan = await buildConversationPlan({
    catalog: customCatalog,
    customer: {
      id: "customer_prompt_frequency",
      productId: customProduct.id,
      faqSalesPromptCounts: firstPlan.customerPatch.faqSalesPromptCounts,
    },
    customerMessage: "sensitive skin boleh guna?",
    ragAnswer: {
      reply: "Suitable for sensitive skin.",
      replyType: "faq",
      buyingIntent: "not_buying",
      handoffRequired: false,
      allowProductSpecific: true,
    },
  });

  assert.deepEqual(secondPlan.messages.map((message) => message.body), [
    "Suitable for sensitive skin.",
    "Custom follow-up prompt",
  ]);
  assert.equal(secondPlan.customerPatch.awaitingPackageBInterest, true);
  assert.equal(secondPlan.customerPatch.faqSalesPromptCounts[customProduct.id], 2);
});

test("FAQ sales prompt frequency can disable the follow-up prompt", async () => {
  const customCatalog = structuredClone(catalog);
  const customProduct = customCatalog.products.find((item) => item.id === ilsoProduct.id);
  customProduct.sales_prompt = "Custom follow-up prompt";
  customProduct.sales_prompt_frequency = 0;

  const plan = await buildConversationPlan({
    catalog: customCatalog,
    customer: { id: "customer_prompt_disabled", productId: customProduct.id },
    customerMessage: "how big is one bottle?",
    ragAnswer: {
      reply: "Volume: 150ml",
      replyType: "faq",
      buyingIntent: "not_buying",
      handoffRequired: false,
      allowProductSpecific: true,
    },
  });

  assert.deepEqual(plan.messages.map((message) => message.body), ["Volume: 150ml"]);
  assert.equal(plan.customerPatch.awaitingPackageBInterest, false);
  assert.equal(plan.customerPatch.faqSalesPromptCounts[customProduct.id], 1);
});

test("vector-store RAG can use generated customer-facing product image reply", async () => {
  const plan = await buildConversationPlan({
    catalog,
    customer: { id: "customer_generated_chunk_reply", productId: ilsoProduct.id },
    customerMessage: "produk ni fungsi apa",
    ragAnswer: {
      reply: "Produk ani untuk bantu lembutkan sebum supaya blackhead sanang dibersihkan, dan bantu nampakkan pores lebih bersih.",
      replyType: "faq",
      buyingIntent: "not_buying",
      handoffRequired: false,
      allowProductSpecific: true,
    },
  });

  assert.equal(
    plan.messages[0].body,
    "Produk ani untuk bantu lembutkan sebum supaya blackhead sanang dibersihkan, dan bantu nampakkan pores lebih bersih."
  );
  assert.doesNotMatch(plan.messages[0].body, /Promotional|image|visible text|WITHOUT ILSO/i);
  assert.equal(plan.customerPatch.awaitingPackageBInterest, true);
  assert.equal(plan.handoffRequired, false);
});

test("usage-duration questions do not become price or loose image-chunk answers", async () => {
  const chunkCatalog = structuredClone(catalog);
  const chunkProduct = chunkCatalog.products.find((item) => item.id === ilsoProduct.id);
  chunkProduct.extracted_knowledge = {
    pending: [],
    approved: [],
    pendingImages: [],
    approvedImages: [
      {
        id: "image_benefit",
        kind: "image_chunk",
        category: "benefit_claim",
        title: "Without ILSO vs with ILSO",
        summary: "Promotional comparison image showing blackheads out in 5 minutes, softer sebum, easier removal, cleaner pores, and smoother skin.",
        extracted_text: "WITHOUT ILSO vs WITH ILSO. Blackheads out in 5 minutes. Softer sebum. Cleaner pores.",
      },
    ],
  };

  const cases = [
    "satu botol buleh guna berapa lama?",
    "how long can i use one botol?",
  ];

  for (const customerMessage of cases) {
    const plan = await buildConversationPlan({
      catalog: chunkCatalog,
      customer: { id: "customer_usage_duration", productId: chunkProduct.id },
      customerMessage,
    });

    assert.equal(plan.handoffRequired, true, customerMessage);
    assert.equal(plan.messages.length, 0, customerMessage);
  }
});

test("product origin questions do not leak raw image chunk summaries", async () => {
  const chunkCatalog = structuredClone(catalog);
  const chunkProduct = chunkCatalog.products.find((item) => item.id === ilsoProduct.id);
  chunkProduct.extracted_knowledge = {
    pending: [],
    approved: [],
    pendingImages: [],
    approvedImages: [
      {
        id: "image_promo",
        kind: "image_chunk",
        category: "benefit_claim",
        title: "Promotional product image",
        summary: "Promotional image for ilso super melting sebum softener showing four visible benefit points: no painful squeezing, visible results, 5-minute care, and gentle formula. The bottle is centered with the product name visible.",
        extracted_text: "No painful squeezing. Visible results. 5-minute care. Gentle formula.",
      },
    ],
  };

  const plan = await buildConversationPlan({
    catalog: chunkCatalog,
    customer: { id: "customer_product_origin", productId: chunkProduct.id },
    customerMessage: "this product from where?",
  });

  assert.equal(plan.handoffRequired, true);
  assert.equal(plan.messages.length, 0);
});

test("feature image chunks do not answer locally without generated RAG reply", async () => {
  const chunkCatalog = structuredClone(catalog);
  const chunkProduct = chunkCatalog.products.find((item) => item.id === product.id);
  chunkProduct.extracted_knowledge = {
    pending: [],
    approved: [],
    pendingImages: [],
    approvedImages: [
      {
        id: "image_features",
        kind: "image_chunk",
        category: "feature",
        title: "Built with smart features",
        summary: "The product shows 3 suction heads, 3 suction modes, USB-C rechargeable charging, and a physical button.",
        extracted_text: "3 suction heads. 3 suction modes. USB-C rechargeable. Physical button.",
        sourceImageUrl: "/assets/blackhead-remover/product-3.png",
        sourceFilename: "product-3-feature.png",
        question_examples: ["how many suction heads?", "is it rechargeable?"],
      },
    ],
  };

  const plan = await buildConversationPlan({
    catalog: chunkCatalog,
    customer: { id: "customer_image_chunk", productId: chunkProduct.id },
    customerMessage: "is it usb rechargeable?",
  });

  assert.equal(plan.handoffRequired, true);
  assert.equal(plan.messages.length, 0);
});

test("product-specific questions ignore global RAG answers from other products", async () => {
  const scopedCatalog = structuredClone(catalog);
  const scopedIlso = scopedCatalog.products.find((item) => item.id === ilsoProduct.id);
  scopedIlso.extracted_knowledge = {
    pending: [],
    approved: [],
    pendingImages: [],
    approvedImages: [],
  };

  const plan = await buildConversationPlan({
    catalog: scopedCatalog,
    customer: { id: "customer_product_scoped_rag", productId: scopedIlso.id },
    customerMessage: "Macam mana cara guna",
    ragAnswer: {
      reply: "Cara guna ya: Start dengan mode Normal dulu. Ada 3 suction heads.",
      replyType: "faq",
      handoffRequired: false,
    },
  });

  assert.equal(plan.handoffRequired, true);
  assert.equal(plan.messages.length, 0);
});

test("product-specific guard catches usage and allows general business questions", () => {
  assert.equal(isProductSpecificQuestion("Macam mana cara guna"), true);
  assert.equal(isProductSpecificQuestion("produk ni fungsi apa"), true);
  assert.equal(isProductSpecificQuestion("satu botol buleh guna berapa lama?"), true);
  assert.equal(isProductSpecificQuestion("Business location kat mana?"), false);
  assert.equal(isProductSpecificQuestion("Ada delivery caj tak?"), false);
});

test("image chunk benefit claims do not send raw chunk text from local matcher", async () => {
  const factCatalog = structuredClone(catalog);
  const factProduct = factCatalog.products.find((item) => item.id === ilsoProduct.id);
  factProduct.extracted_knowledge = {
    pending: [],
    approved: [],
    pendingImages: [],
    approvedImages: [
      {
        id: "image_claim",
        kind: "image_chunk",
        category: "benefit_claim",
        title: "Cleaner pores claim",
        summary: "Cleaner pores",
        extracted_text: "Cleaner pores",
        question_examples: ["does it clean pores?"],
      },
    ],
  };
  const plan = await buildConversationPlan({
    catalog: factCatalog,
    customer: { id: "customer_cleaner_pores", productId: factProduct.id },
    customerMessage: "cleaner pores?",
  });

  assert.equal(plan.handoffRequired, true);
  assert.equal(plan.messages.length, 0);
});

test("approved FAQ exact examples identify the stored reply record", () => {
  const faq = findApprovedFaqExactMatch(catalog, product, "Kalau hantar rumah perlu bayar?", { faqLibrary });

  assert.equal(faq.id, "general_delivery_fee");
  assert.equal(faq.approved_reply, "nda ya");
});

test("only current product FAQ records are eligible alongside general replies", () => {
  const scopedCatalog = structuredClone(catalog);
  scopedCatalog.products.push({
    id: "another-product",
    name: "Another Product",
    openingFlowEnabled: true,
    approved_faqs: [
      {
        id: "another_private_question",
        topic: "Another private answer",
        example_questions: ["Private question?"],
        approved_reply: "Private answer",
        active: true,
      },
    ],
  });

  const records = approvedFaqRecordsForProduct(scopedCatalog, product, { faqLibrary });
  const ids = records.map((record) => record.id);

  assert.ok(ids.includes("general_delivery_fee"));
  assert.ok(ids.includes("blackhead_usage"));
  assert.ok(!ids.includes("another_private_question"));
});

test("stored product locks the conversation even if text mentions another product", () => {
  const matched = findProduct(
    catalog,
    "Macam mana cara guna Blackhead Remover?",
    {},
    ilsoProduct.id
  );

  assert.equal(matched.id, ilsoProduct.id);
});

test("general FAQ is only eligible for business-level questions", () => {
  const businessFaq = findApprovedFaqExactMatch(catalog, ilsoProduct, "Kalau hantar rumah perlu bayar?", { faqLibrary });
  const productQuestionFaq = findApprovedFaqExactMatch(catalog, ilsoProduct, "Warranty atau refund ada?", { faqLibrary });

  assert.equal(businessFaq?.id, "general_delivery_fee");
  assert.equal(productQuestionFaq, null);
  assert.equal(isGeneralBusinessQuestion("Business location kat mana?"), true);
  assert.equal(isGeneralBusinessQuestion("produk ni fungsi apa?"), false);
});

test("general FAQ can be supplied from independent library", async () => {
  const independentLibrary = {
    approved_faqs: [
      {
        id: "independent_delivery",
        topic: "Delivery availability",
        example_questions: ["Can deliver to Muara?"],
        approved_reply: "Buleh deliver ya.",
        active: true,
      },
    ],
  };

  const plan = await buildConversationPlan({
    catalog: { ...catalog, approved_faqs: [] },
    faqLibrary: independentLibrary,
    customer: {
      id: "customer_independent_general_faq",
      productId: ilsoProduct.id,
    },
    customerMessage: "Can deliver to Muara?",
  });

  assert.equal(plan.handoffRequired, false);
  assert.equal(plan.messages[0].body, "Buleh deliver ya.");
});

test("semantic approved FAQ match sends only the saved business reply", async () => {
  const plan = await buildConversationPlan({
    catalog,
    customer: {
      id: "customer_paraphrased_delivery_fee",
      productId: product.id,
      pendingOrder: { productId: product.id },
    },
    customerMessage: "If hantar ke rumah ada additional payment kah?",
    approvedFaqMatch: {
      faqId: "general_delivery_fee",
      approvedReply: "nda ya",
    },
  });

  assert.equal(plan.messages[0].body, "nda ya");
  assert.equal(plan.messages[1].body, blackheadSalesPrompt);
  assert.equal(plan.customerPatch.lastApprovedFaqId, "general_delivery_fee");
  assert.doesNotMatch(plan.messages[0].body, /delivery detail/i);
});

test("delivery-fee standard reply is not mistaken for order delivery details", async () => {
  const plan = await buildConversationPlan({
    catalog,
    faqLibrary,
    customer: {
      id: "customer_pending_order_fee_question",
      productId: product.id,
      pendingOrder: { productId: product.id },
    },
    customerMessage: "Delivery ada caj tak?",
  });

  assert.equal(plan.messages[0].body, "nda ya");
  assert.equal(plan.messages[1].body, blackheadSalesPrompt);
  assert.doesNotMatch(plan.messages[0].body, /delivery detail/i);
});

test("RAG FAQ answer takes priority over pending-order delivery fallback", async () => {
  const plan = await buildConversationPlan({
    catalog,
    customer: {
      id: "customer_pending_order_paraphrased_fee_question",
      productId: product.id,
      pendingOrder: { productId: product.id },
    },
    customerMessage: "Do I need to pay anything for sending it?",
    ragAnswer: {
      reply: "nda ya",
      replyType: "faq",
      buyingIntent: "not_buying",
      handoffRequired: false,
      handoffReason: "",
    },
  });

  assert.equal(plan.messages[0].body, "nda ya");
  assert.equal(plan.messages[1].body, blackheadSalesPrompt);
});

test("product FAQ answer includes the Package B sales follow-up", async () => {
  const plan = await buildConversationPlan({
    catalog,
    customer: { id: "customer_product_faq", productId: product.id },
    customerMessage: "Boleh COD?",
  });

  assert.equal(plan.messages[0].body, "Boleh, COD to all Brunei.");
  assert.equal(plan.messages[1].body, blackheadSalesPrompt);
});

test("sales response and human-review RAG replies do not add the FAQ sales follow-up", async () => {
  const salesPlan = await buildConversationPlan({
    catalog,
    salesReplyLibrary: {
      sales_replies: [
        {
          id: "general_tanya_dulu",
          scope: "business",
          productId: "",
          objection_type: "Tanya dulu",
          intent: "Customer wants to ask first before buying.",
          example_messages: ["Tanya dulu"],
          approved_reply: "Buleh tau apa yg kita fikir? Ada rasa nak tunggu payday?",
          active: true,
        },
      ],
    },
    customer: { id: "customer_sales_response", productId: product.id },
    customerMessage: "Tanya dulu",
  });
  const handoffPlan = await buildConversationPlan({
    catalog,
    customer: { id: "customer_handoff", productId: product.id },
    customerMessage: "Can a manager review this manually?",
    ragAnswer: {
      reply: "Team kami akan bantu check perkara ani.",
      replyType: "faq",
      buyingIntent: "not_buying",
      handoffRequired: true,
      handoffReason: "Damaged product review.",
    },
  });

  assert.equal(salesPlan.messages.length, 1);
  assert.equal(handoffPlan.messages.length, 1);
});

test("sales replies can be supplied from independent library", async () => {
  const salesReplyLibrary = {
    sales_replies: [
      {
        id: "independent_general_objection",
        scope: "business",
        productId: "",
        objection_type: "Need to ask first",
        intent: "Customer wants to ask first before buying.",
        example_messages: ["tanya laki dulu"],
        approved_reply: "Buleh kita, tanya dulu. Kalau ada soalan lain, bagitau saja ya.",
        active: true,
      },
    ],
  };

  const plan = await buildConversationPlan({
    catalog,
    salesReplyLibrary,
    customer: { id: "customer_independent_sales_reply", productId: ilsoProduct.id },
    customerMessage: "tanya laki dulu",
  });

  assert.equal(plan.messages[0].body, "Buleh kita, tanya dulu. Kalau ada soalan lain, bagitau saja ya.");
  assert.equal(plan.customerPatch.lastSalesReplyId, "independent_general_objection");
});

test("sales reply examples match natural hesitation variants before FAQ follow-up", async () => {
  const salesReplyLibrary = {
    sales_replies: [
      {
        id: "sales_tanya_dulu",
        scope: "business",
        productId: "",
        objection_type: "Tanya dulu",
        intent: "Customer wants to ask someone first before buying.",
        example_messages: ["Tanya dulu"],
        approved_reply: "Buleh tau apa yg kita fikir? Ada rasa nak tunggu payday?",
        active: true,
      },
    ],
  };

  const plan = await buildConversationPlan({
    catalog,
    salesReplyLibrary,
    customer: {
      id: "customer_tanya_dulu_after_prompt",
      productId: product.id,
      awaitingPackageBInterest: true,
    },
    customerMessage: "Saya tanya dulu",
  });

  assert.equal(plan.messages.length, 1);
  assert.equal(plan.messages[0].body, "Buleh tau apa yg kita fikir? Ada rasa nak tunggu payday?");
  assert.equal(plan.customerPatch.lastSalesReplyId, "sales_tanya_dulu");
  assert.equal(plan.customerPatch.awaitingPackageBInterest, false);
});

test("sales intent classifier handles Brunei-Malay typo and budget variants", async () => {
  const salesReplyLibrary = {
    sales_replies: [
      {
        id: "sales_payday_only_pay",
        sales_intent: "payday_only_pay",
        scope: "business",
        productId: "",
        objection_type: "Payday / only pay later",
        intent: "Customer is interested but wants to wait for payday, salary, budget, or pay later.",
        example_messages: ["Budget belum cukup"],
        approved_reply: "Faham kita. Kalau tunggu payday, no worries ya. Bila kita ready nanti, boleh message kami semula.",
        repeat_action: "openai_acknowledge",
        active: true,
      },
    ],
  };

  const plan = await buildConversationPlan({
    catalog,
    salesReplyLibrary,
    customer: { id: "customer_budget_typo", productId: product.id },
    customerMessage: "Tungu dulu blom ada bajet",
  });

  assert.equal(normalizeCustomerMessage("Tungu dulu blom ada bajet"), "tunggu dulu belum ada budget");
  assert.equal(plan.messages[0].body, "Faham kita. Kalau tunggu payday, no worries ya. Bila kita ready nanti, boleh message kami semula.");
  assert.equal(plan.customerPatch.lastSalesReplyIntent, "payday_only_pay");
  assert.equal(plan.handoffRequired, false);
});

test("same normalized sales intent again respects repeat action instead of resending approved reply", async () => {
  const salesReplyLibrary = {
    sales_replies: [
      {
        id: "sales_payday_only_pay",
        sales_intent: "payday_only_pay",
        scope: "business",
        productId: "",
        objection_type: "Payday / only pay later",
        intent: "Customer is interested but wants to wait for payday, salary, budget, or pay later.",
        example_messages: ["Budget belum cukup"],
        approved_reply: "Faham kita. Kalau tunggu payday, no worries ya. Bila kita ready nanti, boleh message kami semula.",
        repeat_action: "handoff",
        active: true,
      },
    ],
  };

  const repeatedPlan = await buildConversationPlan({
    catalog,
    salesReplyLibrary,
    customer: {
      id: "customer_budget_typo_repeat",
      productId: product.id,
      lastSalesReplyId: "sales_payday_only_pay",
      lastSalesReplyIntent: "payday_only_pay",
    },
    customerMessage: "blom ada budget",
  });

  assert.equal(repeatedPlan.messages.length, 0);
  assert.equal(repeatedPlan.customerPatch.lastRepeatedSalesReplyIntent, "payday_only_pay");
  assert.equal(repeatedPlan.repeatedSalesReply.action, "handoff");
});

test("another-date purchase sales reply pauses normal follow-ups and stores status", async () => {
  const salesReplyLibrary = {
    sales_replies: [
      {
        id: "sales_another_date_purchase",
        sales_intent: "another_date_purchase",
        scope: "business",
        productId: "",
        objection_type: "Another date purchase",
        intent: "Customer plans to buy on another date.",
        example_messages: ["25/7 baru beli"],
        approved_reply: "Noted kita. Saya follow up semula bila sampai tarikh atu ya.",
        repeat_action: "openai_acknowledge",
        active: true,
      },
    ],
  };

  const plan = await buildConversationPlan({
    catalog,
    salesReplyLibrary,
    customer: { id: "customer_another_date_purchase", productId: product.id },
    customerMessage: "25/7 baru beli",
  });

  assert.equal(plan.messages.length, 1);
  assert.equal(plan.messages[0].body, "Noted kita. Saya follow up semula bila sampai tarikh atu ya.");
  assert.equal(plan.customerPatch.status, "another_date_purchase");
  assert.equal(plan.customerPatch.salesStatus, "another_date_purchase");
  assert.equal(plan.customerPatch.followupBlocked, true);
  assert.equal(plan.customerPatch.followupBlockedReason, "another_date_purchase");

  const dateOnlyPlan = await buildConversationPlan({
    catalog,
    salesReplyLibrary,
    customer: { id: "customer_another_date_only", productId: product.id },
    customerMessage: "25/7",
  });

  assert.equal(dateOnlyPlan.messages[0].body, "Noted kita. Saya follow up semula bila sampai tarikh atu ya.");
  assert.equal(dateOnlyPlan.customerPatch.salesStatus, "another_date_purchase");
});

test("sales reply repeat returns configured OpenAI acknowledgement action", async () => {
  const salesReplyLibrary = {
    sales_replies: [
      {
        id: "sales_thinking_first",
        sales_intent: "thinking_first",
        scope: "business",
        productId: "",
        objection_type: "Thinking first",
        intent: "Customer wants to think first before buying.",
        example_messages: ["Fikir dulu"],
        approved_reply: "Boleh kita, no worries. Kalau ada soalan, tanya saja ya.",
        repeat_action: "openai_acknowledge",
        active: true,
      },
    ],
  };

  const firstPlan = await buildConversationPlan({
    catalog,
    salesReplyLibrary,
    customer: { id: "customer_sales_cooldown", productId: product.id },
    customerMessage: "Fikir dulu",
  });
  const repeatedPlan = await buildConversationPlan({
    catalog,
    salesReplyLibrary,
    customer: {
      id: "customer_sales_cooldown",
      productId: product.id,
      lastSalesReplyId: firstPlan.customerPatch.lastSalesReplyId,
      lastSalesReplyIntent: firstPlan.customerPatch.lastSalesReplyIntent,
    },
    customerMessage: "Fikir dulu",
  });

  assert.equal(firstPlan.messages[0].body, "Boleh kita, no worries. Kalau ada soalan, tanya saja ya.");
  assert.equal(firstPlan.customerPatch.lastSalesReplyIntent, "thinking_first");
  assert.equal(repeatedPlan.messages.length, 0);
  assert.equal(repeatedPlan.customerPatch.lastRepeatedSalesReplyIntent, "thinking_first");
  assert.equal(repeatedPlan.repeatedSalesReply.action, "openai_acknowledge");
});

test("sales reply repeat can request admin handoff", async () => {
  const salesReplyLibrary = {
    sales_replies: [
      {
        id: "sales_payday_only_pay",
        sales_intent: "payday_only_pay",
        scope: "business",
        productId: "",
        objection_type: "Payday / only pay later",
        intent: "Customer wants to wait for payday.",
        example_messages: ["Payday dulu"],
        approved_reply: "Faham kita, no worries ya.",
        repeat_action: "handoff",
        active: true,
      },
    ],
  };

  const firstPlan = await buildConversationPlan({
    catalog,
    salesReplyLibrary,
    customer: { id: "customer_sales_cooldown_hours", productId: product.id },
    customerMessage: "Payday dulu",
  });
  const repeatedPlan = await buildConversationPlan({
    catalog,
    salesReplyLibrary,
    customer: {
      id: "customer_sales_cooldown_hours",
      productId: product.id,
      lastSalesReplyId: firstPlan.customerPatch.lastSalesReplyId,
      lastSalesReplyIntent: firstPlan.customerPatch.lastSalesReplyIntent,
    },
    customerMessage: "Payday dulu",
  });

  assert.equal(firstPlan.messages[0].body, "Faham kita, no worries ya.");
  assert.equal(repeatedPlan.messages.length, 0);
  assert.equal(repeatedPlan.repeatedSalesReply.action, "handoff");
});

test("business FAQ without a local match does not use global RAG fallback", async () => {
  const plan = await buildConversationPlan({
    catalog,
    customer: { id: "customer_similar_delivery_faq", productId: product.id },
    customerMessage: "Can you issue tax invoice?",
  });

  assert.equal(plan.handoffRequired, true);
  assert.equal(plan.messages.length, 0);
  assert.equal(plan.customerPatch.awaitingPackageBInterest, false);
});

test("ada after the FAQ sales question sends the order form without GPT", async () => {
  const customer = {
    id: "customer_accepts_package_b",
    productId: product.id,
    awaitingPackageBInterest: true,
  };
  const plan = await buildConversationPlan({
    catalog,
    customer,
    customerMessage: "ada",
  });

  assert.equal(classifyFaqSalesPromptResponse(customer, "ada"), "interested");
  assert.equal(plan.customerPatch.awaitingPackageBInterest, false);
  assert.equal(plan.customerPatch.pendingOrder.productId, product.id);
  assert.match(plan.messages[1].body, /Full name/);
});

test("nda minat after the FAQ sales question sends thanks and does not open an order", async () => {
  const customer = {
    id: "customer_declines_package_b",
    productId: product.id,
    awaitingPackageBInterest: true,
  };
  const plan = await buildConversationPlan({
    catalog,
    customer,
    customerMessage: "nda minat",
  });

  assert.equal(classifyFaqSalesPromptResponse(customer, "nda minat"), "not_interested");
  assert.equal(plan.messages[0].body, "bah, terima kasih.");
  assert.equal(plan.messages.length, 1);
  assert.equal(plan.customerPatch.awaitingPackageBInterest, false);
  assert.equal(plan.customerPatch.pendingOrder, undefined);
});

test("products still in opening-flow setup are not matched to customer conversations", () => {
  const draft = {
    id: "setup-product",
    name: "Setup Product",
    aliases: ["setup product"],
    openingFlowEnabled: false,
  };
  const withDraft = { ...catalog, products: [...catalog.products, draft] };

  assert.equal(findProduct(withDraft, "Setup Product").id, catalog.default_product_id);
});
