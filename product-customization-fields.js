function mapPersonalizationSlots(customization) {
  return {
    ...(typeof customization.personalizationSlots === "string"
      ? {
          "personalizacja sloty": customization.personalizationSlots,
        }
      : {}),
  };
}

module.exports = { mapPersonalizationSlots };
