'use strict';
// Shipping provider boundary. Labels and carrier tracking are NOT faked: when no provider key is
// configured, label purchase is unavailable and sellers enter the carrier + tracking number from a
// label they bought elsewhere. Tracking sync works through the authenticated carrier webhook
// (POST /webhooks/tracking) which any provider (Shippo/EasyPost) can be pointed at.
const config = require('./config');

const shippo = {
  name: 'shippo',
  async buyLabel(/* order, parcel */) {
    // Intentionally unimplemented: requires a Shippo account, address validation and rate selection UI.
    // Interface: return { carrier, trackingNumber, labelRef, costCents }.
    throw Object.assign(new Error('Shippo label purchase is not implemented yet'), { status: 501 });
  },
};
const getLabelProvider = () => (config.shippo.apiKey ? shippo : null);
module.exports = { getLabelProvider };
