"use strict";
// The one door to the system browser (audit B8): https always, http only to this
// machine. The implementation is @masora/desktop-kit's; every caller in desktop/
// goes through this file so a test can still see there is one door.
const { isSafeUrl, openSafe } = require("@masora/desktop-kit");

module.exports = { isSafeUrl, openSafe };
