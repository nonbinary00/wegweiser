// ==================== DOM-Elemente ====================
// Verbatim aus wegweiser-v13.html (Abschnitt "---- Elemente ----").

  // ---- Elemente ----
  var video   = document.getElementById("cam");
  var canvas  = document.getElementById("view");
  var ctx     = canvas.getContext("2d", { willReadFrequently: true });
  var roomEl  = document.getElementById("room");
  var metaEl  = document.getElementById("meta");
  var liveEl  = document.getElementById("live");
  var gate    = document.getElementById("gate");
  var errBox  = document.getElementById("err");
  var errMsg  = document.getElementById("errMsg");
  var startBtn= document.getElementById("startBtn");
  var retryBtn= document.getElementById("retryBtn");
  var whereBtn  = document.getElementById("whereBtn");
  var muteBtn   = document.getElementById("muteBtn");
  var navStartBtn = document.getElementById("navStartBtn");
  var navEndBtn   = document.getElementById("navEndBtn");
  var destSel = document.getElementById("destSel");
  var uiDest  = document.getElementById("uiDest");
  var uiCur   = document.getElementById("uiCur");
  var uiNext  = document.getElementById("uiNext");
  var uiDist  = document.getElementById("uiDist");
  var uiState = document.getElementById("navState");
  var uiInstr = document.getElementById("uiInstr");
  var uiSource= document.getElementById("stepSource");

  // ---- Logging-Panel (neu, Feldtest-Instrumentierung) ----
  var testNameInput = document.getElementById("testNameInput");
  var logCounter    = document.getElementById("logCounter");
  var logExportBtn  = document.getElementById("logExportBtn");
  var logClearBtn   = document.getElementById("logClearBtn");

export {
  video,
  canvas,
  ctx,
  roomEl,
  metaEl,
  liveEl,
  gate,
  errBox,
  errMsg,
  startBtn,
  retryBtn,
  whereBtn,
  muteBtn,
  navStartBtn,
  navEndBtn,
  destSel,
  uiDest,
  uiCur,
  uiNext,
  uiDist,
  uiState,
  uiInstr,
  uiSource,
  testNameInput,
  logCounter,
  logExportBtn,
  logClearBtn
};
