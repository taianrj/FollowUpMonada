'use strict';

function createHistorySocketConfig({ Browsers, fullSyncType, retentionDays }) {
  return {
    // rc13 anuncia WEB com DARWIN/WIN32 ao usar Desktop, combinação que o
    // servidor rejeita antes do QR. WEB_BROWSER mantém o pareamento compatível.
    browser: Browsers.ubuntu('Chrome'),
    syncFullHistory: true,
    shouldSyncHistoryMessage: ({ syncType }) => retentionDays > 2 || syncType !== fullSyncType
  };
}

module.exports = { createHistorySocketConfig };
