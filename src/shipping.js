'use strict';
// Legacy boundary kept for the old platform-mode dashboard: it never offers label purchase.
// Label purchase for direct (seller-owned) orders lives in src/shipments.js on top of src/shippo.js, in TEST MODE ONLY (docs/SHIPPING.md).
const getLabelProvider = () => null;
module.exports = { getLabelProvider };
