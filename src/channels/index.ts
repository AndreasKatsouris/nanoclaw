// Channel self-registration barrel.
// Each import triggers the channel module's registerChannelAdapter() call.
//
// Main ships with one default channel — `cli`, the always-on local-terminal
// channel. Other channel skills (/add-slack, /add-discord, /add-whatsapp,
// ...) copy their module from the `channels` branch and append a
// self-registration import below.

import './cli.js';

// discord

// gmail — re-add via /add-gmail (v2 Chat SDK adapter)

// slack

// telegram — re-add via /add-telegram (v2 Chat SDK adapter)

// whatsapp
