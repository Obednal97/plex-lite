// Plex's sign-in page sends the popup here when it's done (web/web-signin.js polls the PIN, so
// this page only has to close itself).
'use strict';
setTimeout(function () { window.close(); }, 600);
