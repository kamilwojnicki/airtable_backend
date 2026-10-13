const test = require("node:test");
const assert = require("node:assert/strict");

const {
  mapPersonalizationSlots,
} = require("../product-customization-fields");

test("maps personalizationSlots unchanged to the Airtable field", () => {
  const personalizationSlots =
    "Imię - przód: Maja | Plecy - imię i nazwisko: Maja Jurek";

  const fields = mapPersonalizationSlots({ personalizationSlots });

  assert.equal(fields["personalizacja sloty"], personalizationSlots);
});

test("omits the Airtable field when personalizationSlots is absent", () => {
  const fields = mapPersonalizationSlots({});

  assert.equal(
    Object.prototype.hasOwnProperty.call(fields, "personalizacja sloty"),
    false
  );
});

test("preserves an empty personalizationSlots string", () => {
  const fields = mapPersonalizationSlots({ personalizationSlots: "" });

  assert.equal(fields["personalizacja sloty"], "");
});

test("omits the Airtable field when personalizationSlots is not a string", () => {
  const fields = mapPersonalizationSlots({ personalizationSlots: null });

  assert.equal(
    Object.prototype.hasOwnProperty.call(fields, "personalizacja sloty"),
    false
  );
});
